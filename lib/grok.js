export const LLM_URL = "https://api.x.ai/v1/chat/completions";

export function llmModel() {
  return process.env.XAI_MODEL || "grok-4.5";
}

const SYSTEM = `You are Polite Router in a Slack DM. Talk like Grok: direct, specific, and based on what was just scanned.
When scanned page text is included, answer the user's latest question first in plain sentences. Counts, prices, names, and listings must come from that text. If the text does not contain the answer, say what is missing. Do not invent numbers. Do not ask for a URL when a page was already scanned. Mention a 401, 403, 429, or 451 only when it blocked the answer.
When no scan is included, chat normally. Ask for an https URL only if they want a site checked and the conversation has none.`;

export async function askGrok(userText) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, text: "Chat is not available until XAI_API_KEY is set on the server." };
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
  if (!res.ok) return { ok: false, text: `Grok request failed (${res.status}).` };
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content?.trim() || "I didn't get a reply.";
  return { ok: true, text };
}
