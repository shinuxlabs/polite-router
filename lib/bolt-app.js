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

const HELP = [
  "This Messages tab is the chat.",
  "Send a URL and I'll find the polite way in, then Grok will summarize it.",
  "Or just talk to me.",
  "Examples: `https://example.com` or `/route https://example.com`",
  "Optional: `max:10` limits how many pages I list.",
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

function resultBlocks(data) {
  const stats = data.stats;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Route results for ${data.url}`.slice(0, 150) } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Pages found:* ${data.pages.length}` },
        { type: "mrkdwn", text: `*Requests sent:* ${stats.network}` },
        { type: "mrkdwn", text: `*Cached:* ${stats.cache_hits}` },
        { type: "mrkdwn", text: `*Unchanged (304):* ${stats.not_modified}` },
      ],
    },
    { type: "divider" },
  ];
  for (const page of data.pages.slice(0, 15)) {
    const title = (page.title || page.url).replace(/[<>]/g, "");
    const size = page.bytes ? `${page.bytes.toLocaleString()} bytes` : "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `\`${page.route}\`  <${page.url}|${title}>\n${size}` },
    });
  }
  if (data.pages.length > 15) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_\u2026and ${data.pages.length - 15} more pages_` }] });
  }
  if (data.summary) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: data.summary.slice(0, 2800) } });
  }
  const logText = (data.log || []).join("\n").slice(0, 2500);
  if (logText) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "```" + logText + "```" }] });
  }
  return blocks;
}

async function replyRoute(say, url, text) {
  await say(`Routing \`${url}\` \u2014 checking the site's rules, then asking Grok.`);
  try {
    const data = await routeSite(url, limits(text));
    const brief = data.pages.slice(0, 12).map((p) => `${p.route} ${p.title} ${p.url}`).join("\n");
    const grok = await askGrok(
      `The user asked about ${url}.\nTheir message: ${text || url}\nRoute log:\n${data.log.join("\n")}\nPages:\n${brief || "(none)"}`
    );
    data.summary = grok.text;
    await say({ blocks: resultBlocks(data), text: `Found ${data.pages.length} pages on ${url}` });
  } catch (err) {
    await say(`Failed to route \`${url}\`: ${err.message || err}`);
  }
}

async function replyChat(say, text) {
  const grok = await askGrok(text);
  await say(grok.text.slice(0, 3500));
}

async function handleText(say, text) {
  const urls = findUrls(text);
  if (!urls.length) {
    const trimmed = (text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!trimmed) {
      await say(HELP);
      return;
    }
    await replyChat(say, trimmed);
    return;
  }
  for (const url of urls.slice(0, 3)) await replyRoute(say, url, text);
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
  await ack(`On it \u2014 routing \`${urls[0]}\`\u2026`);
  for (const url of urls.slice(0, 3)) await replyRoute(say, url, text);
});

app.event("app_mention", async ({ event, say, client }) => {
  const thread = event.thread_ts || event.ts;
  await setSession(client, event.channel, thread, "processing");
  try {
    await handleText(sayIn(say, thread), event.text || "");
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
    await handleText(sayIn(say, thread), event.text || "");
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
              "Open *Messages* to chat. A URL is routed politely, then Grok summarizes it. Anything else is just a chat with Grok.",
              "",
              "*How to use me:*",
              "\u2022 Messages tab, or a DM",
              "\u2022 `/route https://example.com`",
              "\u2022 Mention me with a URL",
              "",
              "*What I do:*",
              "1. Read `robots.txt` and respect it",
              "2. Check feeds first",
              "3. Then sitemaps, then a short crawl",
              "4. Stop on 401/403/429/451",
              "5. Ask Grok to summarize or to talk",
            ].join("\n"),
          },
        },
      ],
    },
  });
});
