const STOP = new Set([401, 403, 429, 451]);
const URL_RE = /https?:\/\/[^\s>|]+/g;

export function findUrls(text) {
  const cleaned = String(text || "").replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, "$1");
  return [...new Set(cleaned.match(URL_RE) || [])].map((u) => u.replace(/[)>.,]+$/, ""));
}

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function pathOf(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}` || "/";
}

function parseRobots(text, botName) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], rules: [] };
      groups.push(current);
    } else if (key === "sitemap") {
      sitemaps.push(value);
    } else if (current && (key === "allow" || key === "disallow")) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const name = botName.toLowerCase();
  const matched = groups.filter((g) => g.agents.some((a) => a === "*" || name.includes(a) || a.includes(name)));
  const specific = matched.filter((g) => g.agents.some((a) => a !== "*"));
  const rules = (specific.length ? specific : matched.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  return { rules, sitemaps };
}

function allowed(rules, url) {
  const path = pathOf(url);
  let best = null;
  for (const rule of rules) {
    if (!rule.path) continue;
    const pattern = rule.path.replace(/\*/g, ".*");
    let hit = false;
    try {
      hit = new RegExp("^" + pattern).test(path) || path.startsWith(rule.path);
    } catch {
      hit = path.startsWith(rule.path);
    }
    if (!hit) continue;
    if (!best || rule.path.length > best.path.length) best = rule;
  }
  return !best || best.allow || best.path === "";
}

function titleFrom(html, fallback) {
  const m = html.match(/<title[^>]*>([^<]{1,180})/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : fallback;
}

function extract(html) {
  const blobs = [];
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body.length > 180000) continue;
    if (/vin|inventory|vehicle|internetPrice|stockNumber|totalCount|resultCount/i.test(body)) {
      blobs.push(body.replace(/\s+/g, " ").slice(0, 2500));
    }
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&quot;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
  return [text, ...blobs].filter(Boolean).join("\n").slice(0, 7000);
}

function pageLinks(html, base, host) {
  const out = [];
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.host === host && /^https?:$/.test(u.protocol)) out.push(u.href.split("#")[0]);
    } catch {
      /* skip */
    }
  }
  return out;
}

function rankLinks(links, start) {
  const startU = new URL(start);
  const dir = startU.pathname.replace(/[^/]+$/, "");
  const scored = [];
  for (const link of links) {
    let u;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (u.host !== startU.host) continue;
    let score = 0;
    if (dir.length > 1 && u.pathname.startsWith(dir)) score += 5;
    if (/inventory|vehicle|vdp/i.test(`${u.pathname}${u.search}`)) score += 4;
    if (/[?&](page|start|offset|pg)=/i.test(u.search)) score += 3;
    if (score > 0) scored.push({ link: u.href, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.link))];
}

function locs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export async function routeSite(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 15;
  const maxRequests = options.maxRequests ?? 30;
  const botName = options.botName || "PoliteRouter";
  const contact = options.contact || "";
  const ua = `${botName}/1.0${contact ? ` (+${contact})` : ""}`;
  const pages = [];
  const log = [];
  const seen = new Set();
  const stats = { network: 0, not_modified: 0, cache_hits: 0 };
  let stopped = null;

  async function fetchText(url, required = false) {
    if (stats.network >= maxRequests) {
      log.push(`stop: request cap ${maxRequests}`);
      return null;
    }
    stats.network += 1;
    const res = await fetch(url, {
      headers: { "user-agent": ua, accept: "text/html,application/xml,text/xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (STOP.has(res.status)) {
      log.push(`blocked: ${res.status} ${url}`);
      if (required) stopped = res.status;
      return null;
    }
    if (res.status === 304) {
      stats.not_modified += 1;
      return null;
    }
    if (!res.ok) {
      log.push(`skip: ${res.status} ${url}`);
      return null;
    }
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text), type: res.headers.get("content-type") || "", finalUrl: res.url || url };
  }

  function add(url, title, route, bytes, excerpt) {
    if (pages.length >= maxPages || seen.has(url)) return;
    seen.add(url);
    pages.push({ url, title: title || url, route, bytes: bytes || 0, excerpt: excerpt || "" });
  }

  const home = new URL(startUrl);
  if (!/^https?:$/.test(home.protocol)) throw new Error("URL must be http or https");
  const origin = originOf(home.href);
  log.push(`start ${home.href}`);

  let rules = [];
  const robots = await fetchText(`${origin}/robots.txt`);
  let sitemaps = [];
  if (robots) {
    const parsed = parseRobots(robots.text, botName);
    rules = parsed.rules;
    sitemaps = parsed.sitemaps;
    log.push(`robots: ${rules.length} rules, ${sitemaps.length} sitemaps`);
  } else {
    log.push("robots: none, assuming allow");
  }

  const can = (url) => allowed(rules, url);
  if (!can(home.href)) {
    log.push("home disallowed by robots.txt");
    return { url: home.href, pages, log, stats, stopped };
  }

  const homeRes = await fetchText(home.href, true);
  if (stopped || !homeRes) return { url: home.href, pages, log, stats, stopped };
  add(homeRes.finalUrl, titleFrom(homeRes.text, home.host), "page", homeRes.bytes, extract(homeRes.text));

  for (const link of rankLinks(pageLinks(homeRes.text, homeRes.finalUrl, home.host), home.href)) {
    if (pages.length >= maxPages || stats.network >= maxRequests) break;
    if (!can(link) || seen.has(link)) continue;
    const page = await fetchText(link);
    if (!page) continue;
    if (!/text\/html|application\/xhtml|json/i.test(page.type) && !/<html|vin|vehicle/i.test(page.text.slice(0, 600))) continue;
    add(page.finalUrl, titleFrom(page.text, link), "listing", page.bytes, extract(page.text));
  }

  if (pages.length < 3) {
    if (!sitemaps.length) sitemaps = [`${origin}/sitemap.xml`];
    for (const mapUrl of sitemaps.slice(0, 2)) {
      if (pages.length >= maxPages || stats.network >= maxRequests) break;
      if (!can(mapUrl)) continue;
      const map = await fetchText(mapUrl);
      if (!map || !/<urlset|<sitemapindex/i.test(map.text.slice(0, 500))) continue;
      log.push(`sitemap ${map.finalUrl}`);
      let urls = locs(map.text);
      if (/<sitemapindex/i.test(map.text) && urls[0] && stats.network < maxRequests) {
        const child = await fetchText(urls[0]);
        if (child) urls = locs(child.text);
      }
      const preferred = urls.filter((u) => /inventory|vehicle/i.test(u)).concat(urls);
      for (const loc of preferred) {
        if (pages.length >= Math.min(maxPages, 8) || stats.network >= maxRequests) break;
        if (!can(loc) || seen.has(loc)) continue;
        const page = await fetchText(loc);
        if (!page) continue;
        add(page.finalUrl, titleFrom(page.text, loc), "sitemap", page.bytes, extract(page.text));
      }
    }
  }

  log.push(`done pages=${pages.length} requests=${stats.network}`);
  return { url: home.href, pages, log, stats, stopped };
}
