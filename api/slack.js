import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "../lib/bolt-app.js";

export const POST = createHandler(app, receiver);

export function GET() {
  return new Response("Polite Router is running. Slack should POST events here.", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
