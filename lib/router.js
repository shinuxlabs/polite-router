const STOP = new Set([401, 403, 429, 451]);
const URL_RE = /https?:\/\/[^\s>|]+/g;
const SKIP_TLD = new Set(["htm", "html", "php", "asp", "aspx", "js", "css", "jpg", "jpeg", "png", "gif", "svg", "xml", "json", "txt", "pdf", "zip", "webp", "ico"]);

export function findUrls(text) {
  const cleaned = String(text || "").replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, "$1");
  return [...new Set(cleaned.match(URL_RE) || [])].map((u) => u.replace(/[)>.,]+$/, ""));
}

export function findTargets(text) {
  const found = findUrls(text);
  const re = /(^|[\s(])((?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s>|]*)?)/gi;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const raw = match[2].replace(/[),.:]+$/, "");
    const host = raw.split("/")[0].replace(/^www\./, "");
    const tld = host.split(".").pop().toLowerCase();
    if (!host.includes(".") || SKIP_TLD.has(tld)) continue;
    found.push(`https://${raw}`);
  }
  const seen = new Set();
  const out = [];
  for (const item of found) {
    try {
      const u = new URL(item);
      const key = `${u.host.replace(/^www\./, "")}${u.pathname}${u.search}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u.href);
    } catch {
      /* skip */
    }
  }
  return out;
}

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function pathOf(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}` || "/";
}

function short(url) {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return (path && path !== "/" ? path : u.host).slice(0, 90);
  } catch {
    return String(url).slice(0, 90);
  }
}

function isPage(url) {
  return !/\.(jpg|jpeg|png|gif|svg|css|js|pdf|zip|webp|ico|mp4|woff2?)($|\?)/i.test(url);
}

function parseRobots(text, botName) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
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
  const m = String(html || "").match(/<title[^>]*>([^<]{1,180})/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : fallback;
}

function extract(html) {
  const blobs = [];
  for (const m of String(html || "").matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body.length > 180000) continue;
    if (/vin|inventory|vehicle|internetPrice|stockNumber|totalCount|resultCount/i.test(body)) {
      blobs.push(body.replace(/\s+/g, " ").slice(0, 2000));
    }
  }
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return [text, ...blobs].filter(Boolean).join("\n").slice(0, 5500);
}

function pageLinks(html, base, host) {
  const out = [];
  for (const m of String(html || "").matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.host === host && /^https?:$/.test(u.protocol) && isPage(u.href)) out.push(u.href.split("#")[0]);
    } catch {
      /* skip */
    }
  }
  return [...new Set(out)];
}

function feedLinks(html, base) {
  const out = [];
  for (const tag of String(html || "").match(/<link[^>]+rel=["']alternate["'][^>]*>/gi) || []) {
    const type = /type=["']([^"']+)["']/i.exec(tag)?.[1] || "";
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && /rss|atom|xml/i.test(type + href)) {
      try { out.push(new URL(href, base).href); } catch { /* skip */ }
    }
  }
  return out;
}

function locs(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export async function routeSite(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 15;
  const maxRequests = options.maxRequests ?? 30;
  const botName = options.botName || "PoliteRouter";
  const contact = options.contact || "";
  const ua = `${botName}/1.0${contact ? ` (+${contact})` : ""}`;
  const pages = [];
  const manual = [];
  const robot = [];
  const log = [];
  const stats = { network: 0, not_modified: 0, cache_hits: 0 };
  const cache = new Map();
  let stopped = null;
  const reserve = Math.min(8, Math.max(3, Math.floor(maxRequests / 4)));

  async function fetchText(url, required = false) {
    if (cache.has(url)) {
      stats.cache_hits += 1;
      return cache.get(url);
    }
    if (stats.network >= maxRequests) {
      log.push(`stop: request cap ${maxRequests}`);
      cache.set(url, null);
      return null;
    }
    stats.network += 1;
    let page = null;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": ua, accept: "text/html,application/xml,text/xml,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (STOP.has(res.status)) {
        log.push(`blocked: ${res.status} ${url}`);
        if (required) stopped = res.status;
      } else if (res.status === 304) {
        stats.not_modified += 1;
      } else if (!res.ok) {
        log.push(`skip: ${res.status} ${url}`);
      } else {
        const text = await res.text();
        page = { text, bytes: Buffer.byteLength(text), type: res.headers.get("content-type") || "", finalUrl: res.url || url };
      }
    } catch (err) {
      log.push(`skip: ${err.message || err} ${url}`);
    }
    cache.set(url, page);
    return page;
  }

  function push(bucket, page, route, why) {
    if (bucket.length >= maxPages) return;
    if (bucket.some((item) => item.url === page.finalUrl)) return;
    const entry = {
      url: page.finalUrl,
      title: titleFrom(page.text, page.finalUrl),
      route,
      why,
      bytes: page.bytes,
      excerpt: extract(page.text),
    };
    bucket.push(entry);
    pages.push(entry);
  }

  const home = new URL(startUrl);
  if (!/^https?:$/.test(home.protocol)) throw new Error("Send a site name, like example.com");
  const origin = originOf(home.href);
  log.push(`start ${home.host}`);

  const robots = await fetchText(`${origin}/robots.txt`);
  const parsed = robots ? parseRobots(robots.text, botName) : { rules: [], sitemaps: [] };
  const rules = parsed.rules;
  const sitemaps = parsed.sitemaps.length ? parsed.sitemaps : [`${origin}/sitemap.xml`];
  log.push(robots ? `robots: ${rules.length} rules, ${parsed.sitemaps.length} sitemaps` : "robots: none, assuming allow");
  const can = (url) => allowed(rules, url);

  const queue = [{ url: home.href, why: "You named this site" }];
  const queued = new Set([home.href]);
  if (!can(home.href)) log.push("manual crawl: robots.txt disallows the page you named");
  while (queue.length && manual.length < maxPages && stats.network < maxRequests - reserve) {
    const item = queue.shift();
    if (!can(item.url) || !isPage(item.url)) continue;
    const page = await fetchText(item.url, item.url === home.href);
    if (stopped) break;
    if (!page) continue;
    push(manual, page, "manual", item.why);
    for (const link of pageLinks(page.text, page.finalUrl, home.host)) {
      if (queued.has(link) || !can(link)) continue;
      queued.add(link);
      queue.push({ url: link, why: `Linked from ${short(page.finalUrl)}` });
      if (queue.length > 50) break;
    }
  }
  log.push(`manual crawl: ${manual.length} pages`);

  const startPage = cache.get(home.href);
  for (const feedUrl of startPage ? feedLinks(startPage.text, startPage.finalUrl) : []) {
    if (robot.length >= 4 || stats.network >= maxRequests || !can(feedUrl)) break;
    const feed = await fetchText(feedUrl);
    if (!feed || !/<(rss|feed|rdf:RDF)\b/i.test(feed.text.slice(0, 800))) continue;
    push(robot, feed, "robot", "Feed linked from the page you named");
  }

  for (const mapUrl of sitemaps.slice(0, 2)) {
    if (robot.length >= maxPages || stats.network >= maxRequests || !can(mapUrl)) continue;
    const map = await fetchText(mapUrl);
    if (!map || !/<urlset|<sitemapindex/i.test(map.text.slice(0, 800))) continue;
    log.push(`sitemap ${short(map.finalUrl)}`);
    let urls = locs(map.text);
    if (/<sitemapindex/i.test(map.text) && urls[0] && can(urls[0])) {
      const child = await fetchText(urls[0]);
      if (child) urls = locs(child.text);
    }
    for (const loc of urls) {
      if (robot.length >= Math.min(maxPages, 8) || stats.network >= maxRequests) break;
      if (!can(loc) || !isPage(loc)) continue;
      if (manual.some((item) => item.url === loc)) continue;
      const page = await fetchText(loc);
      if (!page) continue;
      push(robot, page, "robot", "Listed in the sitemap from robots.txt");
    }
  }
  log.push(`robot crawl: ${robot.length} pages`);
  log.push(`done manual=${manual.length} robot=${robot.length} requests=${stats.network}`);
  return { url: home.href, pages, manual, robot, log, stats, stopped };
}
