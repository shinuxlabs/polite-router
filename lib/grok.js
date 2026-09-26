import { readFile } from "node:fs/promises";
export const LLM_URL = "https://api.x.ai/v1/chat/completions";
const RESPONSES_URL = "https://api.x.ai/v1/responses";

export function llmModel() {
  return process.env.XAI_MODEL || "grok-4.5";
}

const SYSTEM = `You answer in a Slack DM the way a sharp assistant would.
Open with the answer in the first sentence. Then one short paragraph of what you actually saw.
If the site blocked the browser and there was no other way in, use the search-engine text and say that plainly.
Do not invent counts, prices, or listings. If neither the page nor the search results contain the fact, say so.
When images are attached, answer from what is visible in them. Do not say a screenshot was saved.
If a counted fact is included, lead with that number and say whether it is new, used, or all vehicles when the text says so.
Never tell the user to open, try, or visit a page.
Do not write a crawl diary. One short closing line is enough.
Never mention Grok or xAI.
Slack bold uses one asterisk on each side, *like this*. Never use **double asterisks**.
A site name is enough. Do not ask for https.`;

function forSlack(text) {
  return String(text || "")
    .replace(/\bgrok\b/gi, "I")
    .replace(/\bxAI\b/g, "the model")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
}

const FILTER = `You filter a Slack message before it is posted.
Keep every fact that is already in the draft. Do not add counts, prices, or pages.
A status line stays one short sentence.
Never tell the user to open, try, or visit a page.
Write it as a direct Slack reply. Bold uses *single asterisks*, never double asterisks.
Never mention Grok, xAI, or a language model.
Return only the message to post.`;

export async function filterReply(text) {
  const draft = forSlack(String(text || "").trim());
  if (!draft) return "";
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return draft;
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: llmModel(),
        max_tokens: 700,
        messages: [
          { role: "system", content: FILTER },
          { role: "user", content: draft.slice(0, 12000) },
        ],
      }),
    });
    if (!res.ok) return draft;
    const body = await res.json();
    const clean = body.choices?.[0]?.message?.content?.trim();
    return forSlack(clean || draft);
  } catch {
    return draft;
  }
}

export async function askGrok(userText, images) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, text: "Chat is not available until the model key is set on the server." };
  const pictures = (images || []).slice(0, 3).filter(Boolean);
  const content = pictures.length
    ? [
        { type: "text", text: String(userText || "").slice(0, 8000) },
        ...pictures.map((data) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } })),
      ]
    : String(userText || "").slice(0, 14000);
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
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) return { ok: false, text: `I couldn't finish the answer (${res.status}).` };
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content?.trim() || "I didn't get a reply.";
  return { ok: true, text: forSlack(text) };
}

function responseText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text.trim();
  const parts = [];
  for (const item of body?.output || []) {
    if (typeof item.text === "string") parts.push(item.text);
    for (const part of item.content || []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}


async function chooseChunk(question, chunk) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return [];
  const lines = chunk.map((link) => `${link.url} | ${link.text || ""}`).join("\n");
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: "Choose the links that can answer the question. Copy matching URLs exactly, one per line. If none match, return none. No other text.",
        },
        { role: "user", content: `Question:\n${String(question || "").slice(0, 500)}\n\nLinks:\n${lines}` },
      ],
    }),
  });
  if (!res.ok) return [];
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content || "";
  if (/^none\b/i.test(text.trim())) return [];
  const allowed = new Set(chunk.map((link) => link.url));
  const found = [];
  for (const match of text.matchAll(/https?:\/\/[^\s|]+/g)) {
    const url = match[0].replace(/[)>.,]+$/, "");
    if (allowed.has(url)) found.push(url);
  }
  return found;
}


export async function reviseShot(file) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || !file) return "";
  const data = (await readFile(file)).toString("base64");
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: "Revise this one screenshot into a short factual note. Keep any count, price, or heading you can see. Do not invent. Do not mention Grok or a screenshot. Return only the note.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Revise this page." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) return "";
  const body = await res.json();
  return forSlack(body.choices?.[0]?.message?.content?.trim() || "");
}

export async function pickLinks(question, links, options = {}) {
  const deadline = options.deadline || Date.now() + 40000;
  const unique = [];
  const seen = new Set();
  for (const link of links || []) {
    const url = String(link.url || link.href || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({ url, text: String(link.text || "").replace(/\s+/g, " ").slice(0, 70) });
  }
  if (!unique.length || !String(question || "").trim()) return { urls: [], judged: 0 };
  const chunks = [];
  for (let i = 0; i < unique.length; i += 70) chunks.push(unique.slice(i, i + 70));
  const picked = [];
  let judged = 0;
  for (let i = 0; i < chunks.length; i += 3) {
    if (Date.now() > deadline) break;
    const group = chunks.slice(i, i + 3);
    const found = await Promise.all(group.map((chunk) => chooseChunk(question, chunk).catch(() => [])));
    for (const list of found) picked.push(...list);
    judged += group.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  return { urls: [...new Set(picked)], judged };
}


export async function learnFilters(host, links) {
  const apiKey = process.env.XAI_API_KEY;
  const rows = (links || []).slice(0, 40);
  if (!apiKey || !rows.length) return [];
  const lines = rows.map((link) => `${link.url} | ${link.text || ""}`).join("\n");
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: llmModel(),
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: "You catalog filters a website already offers. Return JSON only, an array of {url,label,kind}. kind is one of all, price, year, body, condition, other. Copy urls exactly. Skip links that are not filters.",
          },
          { role: "user", content: `Site: ${host}\n${lines}` },
        ],
      }),
    });
    if (!res.ok) return [];
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    const allowed = new Set(rows.map((link) => link.url));
    const kinds = new Set(["all", "price", "year", "body", "condition", "other"]);
    return parsed
      .filter((row) => row && allowed.has(row.url))
      .map((row) => ({ url: row.url, label: String(row.label || "").slice(0, 80), kind: kinds.has(row.kind) ? row.kind : "other" }));
  } catch {
    return [];
  }
}

export async function searchWeb(query) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { text: "", sources: [] };
  const model = process.env.XAI_SEARCH_MODEL || "grok-4";
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model,
        input: `Search the public web and answer this. Lead with the fact. Name the pages you used.\n\n${String(query || "").slice(0, 1000)}`,
        tools: [{ type: "web_search" }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { text: "", sources: [], error: `${res.status} ${err.slice(0, 180)}` };
    }
    const body = await res.json();
    const sources = [];
    for (const cite of body.citations || body.output?.flatMap?.((item) => item.citations || []) || []) {
      if (typeof cite === "string") sources.push(cite);
      else if (cite?.url) sources.push(cite.url);
    }
    const text = forSlack(responseText(body));
    const withSources = sources.length ? `${text}\n\nPages: ${[...new Set(sources)].slice(0, 5).join(", ")}` : text;
    return { text: withSources, sources: [...new Set(sources)].slice(0, 5) };
  } catch (err) {
    return { text: "", sources: [], error: err.message || String(err) };
  }
}
