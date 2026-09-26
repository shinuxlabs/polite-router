const SYSTEM = `You are Polite Router, a Slack assistant. You help people read a site the lowest-impact way: respect robots.txt, prefer feeds, then sitemaps, then a short crawl, and stop on 401/403/429/451.
When route results are included, summarize what was found in a few sentences and name the routes used (feed, sitemap, crawl).
When the user is just chatting, answer briefly and usefully. If they want a site checked, ask for a full https URL.
Never invent pages that are not in the route results.`;

export async function askGrok(userText) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, text: "Chat is not available until XAI_API_KEY is set on the server." };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.XAI_MODEL || "grok-4.5",
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userText.slice(0, 12000) },
      ],
    }),
  });
  if (!res.ok) return { ok: false, text: `Grok request failed (${res.status}).` };
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content?.trim() || "I didn't get a reply.";
  return { ok: true, text };
}
