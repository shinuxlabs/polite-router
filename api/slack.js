import { createHandler } from "@vercel/slack-bolt";
import { app, grokConfigured, receiver, slackConfigured } from "../lib/bolt-app.js";
import { LLM_URL, llmModel } from "../lib/grok.js";

const post = createHandler(app, receiver);

async function slackAuth() {
  const token = process.env.SLACK_BOT_TOKEN || "";
  if (!token || token.startsWith("xoxb-0-0-")) return "missing";
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return body.ok ? "ok" : body.error || "invalid_auth";
  } catch {
    return "unreachable";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const auth = await slackAuth();
    res.status(200).json({
      ok: true,
      name: "polite-router",
      slack: slackConfigured,
      slackAuth: auth,
      grok: grokConfigured,
      browser: true,
      model: llmModel(),
      llm: LLM_URL,
    });
    return;
  }

  if (Number(req.headers["x-slack-retry-num"] || 0) > 0) {
    res.status(200).json({ ok: true });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const request = new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const response = await post(request);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    const code = err?.data?.error || "";
    console.error("slack handler failed", code || err?.message || err);
    if (code === "invalid_auth") {
      res.status(200).json({ ok: false, error: "invalid_auth" });
      return;
    }
    res.status(500).json({ ok: false });
  }
}
