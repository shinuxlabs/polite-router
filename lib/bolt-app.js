import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import { askGrok } from "./grok.js";
import { findUrls, routeSite } from "./router.js";

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
  "Send a URL, then ask about it in the same chat.",
  "Example: `https://example.com` then `how many pages mention pricing?`",
  "`max:10` limits how many pages I open.",
].join("\n");

const PROMPTS = [
  { title: "Route a site", message: "https://example.com" },
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
    // The manifest already ships the same prompts.
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
    // Chat still posts if this workspace has no agent session yet.
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
        const found = findUrls(text);
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

function scanPacket(data, question, earlier) {
  const body = data.pages.slice(0, 6).map((page) => {
    return [`${page.route} ${page.title}`, page.url, (page.excerpt || "").slice(0, 1200)].join("\n");
  }).join("\n\n");
  return [
    earlier.length ? `Earlier user messages:\n${earlier.join("\n")}` : "",
    `Latest question: ${question}`,
    `Scanned URL: ${data.url}`,
    `Log:\n${data.log.join("\n")}`,
    body ? `Page text:\n${body}` : "Page text: (none fetched)",
    "Answer the latest question from the page text. If they only sent a URL, report the concrete data on the page: totals, listings, prices, and names you can actually see.",
  ].filter(Boolean).join("\n\n");
}

async function replyRoute(say, url, text, earlier) {
  const question = text.replace(url, "").trim();
  await say(question ? `Reading that page to answer: ${question.slice(0, 180)}` : "Reading the page.");
  try {
    const data = await routeSite(url, { ...limits(text), question: text });
    const grok = await askGrok(scanPacket(data, text, earlier));
    const note = `Scanned ${data.pages.length} page${data.pages.length === 1 ? "" : "s"} · ${data.stats.network} requests${data.stopped ? ` · stopped on ${data.stopped}` : ""}`;
    await say({
      text: grok.text.slice(0, 3500),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: grok.text.slice(0, 2800) } },
        { type: "context", elements: [{ type: "mrkdwn", text: note }] },
      ],
    });
  } catch (err) {
    await say(`I couldn't read \`${url}\`: ${err.message || err}`);
  }
}

async function replyChat(say, text, earlier) {
  const grok = await askGrok([earlier.length ? `Earlier:\n${earlier.join("\n")}` : "", text].filter(Boolean).join("\n\n"));
  await say(grok.text.slice(0, 3500));
}

async function handleText(say, text, client, channel) {
  let urls = findUrls(text);
  const memory = client && channel ? await remembered(client, channel) : { url: "", lines: [] };
  if (!urls.length && memory.url && ASKS.test(text || "")) urls = [memory.url];
  if (!urls.length) {
    const trimmed = (text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!trimmed) {
      await say(HELP);
      return;
    }
    await replyChat(say, trimmed, memory.lines);
    return;
  }
  for (const url of urls.slice(0, 2)) await replyRoute(say, url, text, memory.lines);
}

function sayIn(say, thread) {
  return (payload) => {
    const message = typeof payload === "string" ? { text: payload } : payload;
    return say(thread ? { ...message, thread_ts: thread } : message);
  };
}

app.command("/route", async ({ ack, command, say }) => {
  const text = (command.text || "").trim();
  const urls = findUrls(text);
  if (!urls.length) {
    await ack("Send a full URL, like `/route https://example.com`");
    return;
  }
  await ack(`Reading \`${urls[0]}\`…`);
  for (const url of urls.slice(0, 2)) await replyRoute(say, url, text, []);
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
              "Send a URL, then keep asking about that site in this chat.",
              "I read the page text and answer from what is actually there.",
              "",
              "`https://example.com`",
              "`how many items are listed?`",
            ].join("\n"),
          },
        },
      ],
    },
  });
});
