import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import { readFile } from "node:fs/promises";
import { discardShots } from "./browser.js";
import { askGrok, filterReply, searchWeb } from "./grok.js";
import { findTargets, routeSite } from "./router.js";

export const slackConfigured = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
export const grokConfigured = Boolean(process.env.XAI_API_KEY);

if (!process.env.SLACK_SIGNING_SECRET) {
  process.env.SLACK_SIGNING_SECRET = "placeholdersecretplaceholdersecret";
}
if (!process.env.SLACK_BOT_TOKEN) {
  process.env.SLACK_BOT_TOKEN = "xoxb-0-0-placeholder";
}

export const receiver = new VercelReceiver();

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

const ASKS = /\?|\b(how many|how much|what|which|where|who|why|list|count|price|prices|cars?|vehicles?|inventory|available|total|show me)\b/i;

const HELP = [
  "Send a site name. https is optional.",
  "`toyotaofdeerfieldbeach.com`",
  "Then ask: `how many cars are listed?`",
  "Pages are opened in a browser. If the site blocks that and there is no other way in, a search engine is used.",
].join("\n");

const PROMPTS = [
  { title: "Scan a site", message: "toyotaofdeerfieldbeach.com" },
  { title: "What can you do?", message: "What can you do?" },
];

let botUserId = "";

function limits(text) {
  const max = /(?:^|\s)max:(\d+)/i.exec(text || "");
  return {
    maxPages: Math.min(30, Math.max(1, max ? Number(max[1]) : Number(process.env.PR_MAX_PAGES || 15))),
    maxRequests: Number(process.env.PR_MAX_REQUESTS || 30),
    botName: process.env.PR_BOT_NAME || "PoliteRouter",
    contact: process.env.PR_CONTACT || "",
  };
}

async function selfId(client) {
  if (botUserId || !slackConfigured) return botUserId;
  try {
    const auth = await client.auth.test();
    botUserId = auth.user_id || "";
  } catch {
    botUserId = "";
  }
  return botUserId;
}

async function setPrompts(client, channel) {
  if (!slackConfigured || !channel) return;
  try {
    await client.apiCall("assistant.threads.setSuggestedPrompts", {
      channel_id: channel,
      prompts: PROMPTS,
    });
  } catch {
    // Prompts are also in the manifest.
  }
}

async function setSession(client, channel, thread, status) {
  if (!slackConfigured || !channel || !thread) return;
  try {
    await client.apiCall("agents.sessions.setStatus", {
      channel_id: channel,
      thread_ts: thread,
      status,
    });
  } catch {
    // The reply still posts if agent sessions are unavailable.
  }
}

async function remembered(client, channel) {
  if (!slackConfigured || !channel) return { url: "", lines: [] };
  try {
    const res = await client.conversations.history({ channel, limit: 20 });
    let url = "";
    const lines = [];
    for (const msg of res.messages || []) {
      if (msg.bot_id || msg.subtype) continue;
      const text = msg.text || "";
      if (!url) {
        const found = findTargets(text);
        if (found.length) url = found[found.length - 1];
      }
      if (lines.length < 6) lines.push(text.slice(0, 300));
    }
    return { url, lines: lines.reverse() };
  } catch (err) {
    console.error("history", err?.data?.error || err?.message || err);
    return { url: "", lines: [] };
  }
}

function whyLines(items, label) {
  if (!items.length) return `${label}: nothing opened.`;
  const sample = items.slice(0, 4).map((page) => `\u2022 ${page.why}: ${page.url}`).join("\n");
  return `${label}: ${items.length} page${items.length === 1 ? "" : "s"}.\n${sample}`;
}

function usefulPages(data) {
  return (data.pages || []).filter((page) => (page.excerpt || "").length > 160 && !/access denied/i.test(page.excerpt));
}

function wasBlocked(data) {
  return Boolean(data.stopped) || data.coverage?.reason === "blocked" || (data.log || []).some((line) => /blocked[: ]|access denied|browser failed/i.test(line));
}

function scanPacket(data, question, earlier, search) {
  const body = data.pages.filter((page) => (page.excerpt || "").length > 180).slice(0, 8).map((page) => {
    return [`${page.route} \u2014 ${page.why}`, page.title, page.url, (page.excerpt || "").slice(0, 1000)].join("\n");
  }).join("\n\n");
  return [
    earlier.length ? `Earlier user messages:\n${earlier.join("\n")}` : "",
    `Latest message: ${question}`,
    `Site: ${data.url}`,
    whyLines(data.manual || [], "Manual crawl"),
    whyLines(data.robot || [], "Robot crawl"),
    `Log:\n${data.log.slice(-25).join("\n")}`,
    data.coverage ? `Coverage: read ${data.coverage.read} of ${data.coverage.found} pages. Stop: ${data.coverage.reason}.` : "",
    body ? `Rendered page text:\n${body}` : "Rendered page text: (none)",
    search?.text ? `Search engines, because the browser was blocked and had no other way in:\n${search.text}` : "",
    search?.error ? `Search engine lookup failed: ${search.error}` : "",
    "Answer from the rendered page when it has the fact. Use the search-engine text only when the site blocked the browser and the page text does not contain the answer.",
  ].filter(Boolean).join("\n\n");
}

async function replyRoute(say, url, text, earlier) {
  const host = new URL(url).host.replace(/^www\./, "");
  await say(`Opening ${host} in a browser.`);
  try {
    const data = await routeSite(url, {
      ...limits(text),
      question: text,
      onProgress: async ({ read, found, done }) => {
        if (done || read === 1 || read % 25 === 0) await say(`Looking through the site: ${read} of ${found} pages.`);
      },
    });
    let search = null;
    if (wasBlocked(data) && usefulPages(data).length === 0) {
      search = await searchWeb(`${text} ${host}`);
    }
    const images = [];
    for (const file of (data.shots || []).slice(0, 3)) {
      try {
        images.push((await readFile(file)).toString("base64"));
      } catch {
        // The page is still answered from its text if the file is already gone.
      }
    }
    let answer;
    try {
      answer = await askGrok(scanPacket(data, text, earlier, search), images);
    } finally {
      await discardShots(data.shots);
    }
    const cover = data.coverage;
    const coverLine = cover
      ? `Manual crawl read ${cover.read} of ${cover.found} pages${cover.reason === "finished" ? "." : ` and stopped (${cover.reason}) before the site could kick the browser.`}`
      : "Opened in a browser.";
    const note = search?.text
      ? `The site blocked the browser, so this came from a search engine. ${coverLine}`
      : search?.error
        ? `The site blocked the browser. The search engine lookup failed. ${coverLine}`
        : coverLine;
    await say({
      text: answer.text.slice(0, 3500),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: answer.text.slice(0, 2800) } },
        { type: "context", elements: [{ type: "mrkdwn", text: note }] },
      ],
    });
  } catch (err) {
    await discardShots().catch(() => {});
    try {
      const found = await searchWeb(`${text} ${host}`);
      if (found?.text) {
        const answer = await askGrok(`The browser could not stay on ${host} (${err.message || err}). A search engine returned the text below. Answer from it. Say the site blocked the browser, so you used a search engine.\n\nUser: ${text}\n\n${found.text}`);
        await say({
          text: answer.text.slice(0, 3500),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: answer.text.slice(0, 2800) } },
            { type: "context", elements: [{ type: "mrkdwn", text: "The site blocked the browser, so this came from a search engine." }] },
          ],
        });
        return;
      }
    } catch {
      // Show the browser error below.
    }
    await say(`I couldn't open ${host} in the browser: ${err.message || err}`);
  }
}

async function replyChat(say, text, earlier) {
  const answer = await askGrok([earlier.length ? `Earlier:\n${earlier.join("\n")}` : "", text].filter(Boolean).join("\n\n"));
  await say(answer.text.slice(0, 3500));
}

async function handleText(say, text, client, channel) {
  let targets = findTargets(text);
  const memory = client && channel ? await remembered(client, channel) : { url: "", lines: [] };
  if (!targets.length && memory.url && ASKS.test(text || "")) targets = [memory.url];
  const speak = guard(say);
  if (!targets.length) {
    const trimmed = (text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!trimmed) {
      await speak(HELP);
      return;
    }
    await replyChat(speak, trimmed, memory.lines);
    return;
  }
  for (const url of targets.slice(0, 1)) await replyRoute(speak, url, text, memory.lines);
}

function sayIn(say, thread) {
  return (payload) => {
    const message = typeof payload === "string" ? { text: payload } : payload;
    return say(thread ? { ...message, thread_ts: thread } : message);
  };
}

function guard(say) {
  return async (payload) => {
    const message = typeof payload === "string" ? { text: payload } : payload;
    const clean = (await filterReply(message.text || "")).slice(0, 3500);
    const next = { ...message, text: clean };
    if (message.blocks) {
      next.blocks = [
        { type: "section", text: { type: "mrkdwn", text: clean.slice(0, 2800) } },
      ];
    }
    return say(next);
  };
}

app.command("/route", async ({ ack, command, say }) => {
  const text = (command.text || "").trim();
  const targets = findTargets(text);
  if (!targets.length) {
    await ack("Send a site name, like `/route example.com`");
    return;
  }
  await ack(`Opening ${new URL(targets[0]).host} in a browser\u2026`);
  await replyRoute(guard(say), targets[0], text, []);
});

app.event("app_mention", async ({ event, say, client }) => {
  const thread = event.thread_ts || event.ts;
  await setSession(client, event.channel, thread, "processing");
  try {
    await handleText(sayIn(say, thread), event.text || "", client, event.channel);
  } finally {
    await setSession(client, event.channel, thread, "active");
  }
});

app.event("message", async ({ event, say, client }) => {
  if (event.channel_type !== "im") return;
  if (event.bot_id || event.subtype) return;
  const me = await selfId(client);
  if (me && (event.text || "").includes(`<@${me}>`)) return;
  const thread = event.thread_ts || undefined;
  await setSession(client, event.channel, event.thread_ts || event.ts, "processing");
  try {
    await handleText(sayIn(say, thread), event.text || "", client, event.channel);
  } finally {
    await setSession(client, event.channel, event.thread_ts || event.ts, "active");
  }
});

app.event("agent_session_stopped", async ({ event, client }) => {
  const channel = event.channel || event.channel_id;
  await setSession(client, channel, event.thread_ts, "active");
});

app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab === "messages") {
    await setPrompts(client, event.channel);
    return;
  }
  await client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Polite Router" } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "Send a site name. https is optional.",
              "Every page is opened in a browser.",
              "If the site blocks the browser and there is no other way in, a search engine is used.",
              "",
              "\u2022 Manual crawl follows the rendered links",
              "\u2022 Robot crawl reads robots.txt, then opens the sitemap pages",
              "",
              "`toyotaofdeerfieldbeach.com`",
              "`how many cars are listed?`",
            ].join("\n"),
          },
        },
      ],
    },
  });
});
