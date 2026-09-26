import { readFile, writeFile } from "node:fs/promises";

const FILE = "/tmp/site-ways.json";
const memory = new Map();

const DOORS = [
  { door: "front", identity: 0, path: "/", referer: "" },
  { door: "search-referer", identity: 0, path: "/", referer: "https://www.google.com/" },
  { door: "inventory", identity: 0, path: "/used-inventory/index.htm", referer: "https://www.google.com/" },
  { door: "front", identity: 1, path: "/", referer: "" },
  { door: "front", identity: 2, path: "/", referer: "" },
];

function keyOf(host) {
  return String(host || "").replace(/^www\./, "").toLowerCase();
}

export function orderDoors(known) {
  const failed = new Set(known?.failed || []);
  const ranked = known?.ok ? [known, ...DOORS] : [...DOORS];
  ranked.sort((a, b) => Number(failed.has(a.door)) - Number(failed.has(b.door)));
  const seen = new Set();
  const doors = [];
  for (const door of ranked) {
    const id = `${door.door}:${door.identity}:${door.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    doors.push(door);
  }
  if (!known?.ok && failed.size) {
    const shift = failed.size % doors.length;
    return [...doors.slice(shift), ...doors.slice(0, shift)].slice(0, 4);
  }
  return doors.slice(0, 4);
}

export async function recallWay(host) {
  const key = keyOf(host);
  if (memory.has(key)) return memory.get(key);
  try {
    const saved = JSON.parse(await readFile(FILE, "utf8"));
    if (saved[key]) {
      memory.set(key, saved[key]);
      return saved[key];
    }
  } catch {
    // No saved entrances yet.
  }
  return null;
}

export async function rememberWay(host, way) {
  const key = keyOf(host);
  const prior = memory.get(key) || (await recallWay(host)) || { failed: [] };
  const failed = new Set(prior.failed || []);
  const next = way.ok
    ? { ...way, ok: true, failed: [...failed].filter((door) => door !== way.door) }
    : { ...prior, ok: false, failed: [...failed, way.door] };
  memory.set(key, next);
  let saved = {};
  try {
    saved = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    saved = {};
  }
  saved[key] = next;
  await writeFile(FILE, JSON.stringify(saved)).catch(() => {});
  return next;
}
