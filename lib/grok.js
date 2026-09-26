export const LLM_URL = "https://api.x.ai/v1/chat/completions";

export function llmModel() {
  return process.env.XAI_MODEL || "grok-4.5";
}

const SYSTEM = `You are Polite Router in a Slack DM. Answer directly from the crawl.
Never mention Grok, xAI, or a language model. Speak only as Polite Router.
Use only facts in the crawled page text. Do not invent counts, prices, or listings.
If the text does not contain the answer, say what is missing.
After the answer, add two short lines: what the manual crawl opened and why, and what the robot crawl opened and why.
Do not ask for https. A site name is enough.`;

export async function askGrok(userText) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, text: "Chat is not available until the model key is set on the server." };
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: 900,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: String(userText || "").slice(0, 14000) },
      ],
    }),
  });
  if (!res.ok) return { ok: false, text: `I couldn't finish the answer (${res.status}).` };
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content?.trim() || "I didn't get a reply.";
  return { ok: true, text: text.replace(/\bgrok\b/gi, "I").replace(/\bxAI\b/g, "the model") };
}
