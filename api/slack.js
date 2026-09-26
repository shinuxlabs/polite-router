import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "../lib/bolt-app.js";

const post = createHandler(app, receiver);

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).send("Polite Router is running. Slack should POST events here.");
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
  const response = await post(request);
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.send(Buffer.from(await response.arrayBuffer()));
}
