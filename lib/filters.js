import { readFile, writeFile } from "node:fs/promises";
import { findCount } from "./facts.js";

const FILE = "/tmp/site-filters.json";
const memory = new Map();

function hostKey(host) {
  return String(host || "").replace(/^www\./, "").toLowerCase();
}

export function filterLinks(links) {
  const out = [];
  const seen = new Set();
  for (const link of links || []) {
    const url = link.url || link.href || "";
    const text = link.text || "";
    const blob = `${url} ${text}`;
    if (!url || seen.has(url)) continue;
    if (!/under-|price|\$\d|year|mileage|body|make|model|certified|pre-owned|used-inventory|new-inventory|view all inventory|all inventory|filter|facet/i.test(blob)) continue;
    seen.add(url);
    out.push({ url, text: text.slice(0, 80) });
  }
  return out.slice(0, 40);
}

async function readStore() {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function recall(host) {
  const key = hostKey(host);
  if (memory.has(key)) return memory.get(key);
  const saved = await readStore();
  if (saved[key]) {
    memory.set(key, saved[key]);
    return saved[key];
  }
  try {
    const seeded = JSON.parse(await readFile(new URL("../data/filters.json", import.meta.url), "utf8"));
    if (seeded[key]) {
      memory.set(key, seeded[key]);
      return seeded[key];
    }
  } catch {
    // No seed file.
  }
  return { filters: [] };
}

export async function remember(host, filters) {
  const key = hostKey(host);
  const entry = { filters, updated: new Date().toISOString() };
  memory.set(key, entry);
  const saved = await readStore();
  saved[key] = entry;
  await writeFile(FILE, JSON.stringify(saved)).catch(() => {});
  return entry;
}

export function mergeFilters(known, fresh) {
  const byUrl = new Map();
  for (const filter of known || []) byUrl.set(filter.url, { ...filter });
  for (const filter of fresh || []) {
    const prior = byUrl.get(filter.url) || {};
    byUrl.set(filter.url, { ...filter, blocked: prior.blocked || false, count: prior.count || "" });
  }
  return [...byUrl.values()];
}

export function chooseFilter(question, entry) {
  const filters = (entry?.filters || []).filter((filter) => !filter.blocked);
  const q = String(question || "").toLowerCase();
  const money = q.match(/(?:under|below|less than|\$)\s*\$?\s*([\d,.]+)\s*(k)?/i);
  if (money) {
    const target = Number(money[1].replace(/,/g, "")) * (money[2] ? 1000 : 1);
    const prices = filters.filter((filter) => filter.kind === "price" || /\$|under-/i.test(`${filter.url} ${filter.label}`));
    let best = null;
    let bestGap = Infinity;
    for (const filter of prices) {
      const raw = `${filter.url} ${filter.label}`.match(/(\d{2,3})(?:,?\d{3})|(\d+)k/i);
      const value = raw?.[2] ? Number(raw[2]) * 1000 : Number(String(raw?.[1] || "").replace(/,/g, "") + (String(raw?.[0] || "").length <= 3 ? "000" : ""));
      if (!value) continue;
      const gap = Math.abs(value - target);
      if (gap < bestGap) {
        best = filter;
        bestGap = gap;
      }
    }
    if (best) return best;
  }
  if (/how many|listed|total|inventory|cars|vehicles/.test(q)) {
    return filters.find((filter) => filter.kind === "all")
      || filters.find((filter) => /view all inventory|used-inventory\/index|all inventory/i.test(`${filter.url} ${filter.label}`))
      || null;
  }
  return filters.find((filter) => filter.label && q.includes(filter.label.toLowerCase())) || null;
}

export function noteResult(host, url, text, blocked) {
  const entry = memory.get(hostKey(host));
  if (!entry) return;
  const filter = entry.filters.find((item) => item.url === url);
  if (!filter) return;
  filter.blocked = Boolean(blocked);
  filter.count = blocked ? "" : findCount(text);
}
