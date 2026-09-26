import { browsePage } from "./browser.js";

const STOP = new Set([401, 403, 429, 451]);
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
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
  return !/\.(jpg|jpeg|png|gif|svg|css|js|pdf|zip|webp|ico|mp4|woff2?|xml)($|\?)/i.test(url);
}

function linkScore(link) {
  const text = link.text || "";
  const href = link.url || link.href || "";
  if (/view all inventory/i.test(text)) return 6;
  if (/all inventory|used inventory|pre-owned inventory/i.test(text)) return 5;
  if (/used-inventory\/index/i.test(href) && !/under-|special/i.test(href)) return 4;
  if (/inventory|vehicle|\/vdp/i.test(`${href} ${text}`) && !/under-|special|\$\d/i.test(`${href} ${text}`)) return 3;
  if (/under-|special|\$\d/i.test(`${href} ${text}`)) return 0;
  return 1;
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

function locs(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

function rankLinks(links, host) {
  const out = [];
  for (const link of links || []) {
    try {
      const u = new URL(link.href);
      if (u.host !== host || !/^https?:$/.test(u.protocol) || !isPage(u.href)) continue;
      if (/\/blog\/|\/rss|privacy|sitemap/i.test(u.pathname)) continue;
      const url = u.href.split("#")[0];
      out.push({ url, score: linkScore({ url, text: link.text || "" }), text: link.text || "" });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return out.filter((item) => (seen.has(item.url) ? false : seen.add(item.url)));
}

export async function routeSite(startUrl, options = {}) {
  const maxPages = options.maxPages ?? 15;
  const maxRequests = options.maxRequests ?? 30;
  const botName = options.botName || "PoliteRouter";
  const pages = [];
  const manual = [];
  const robot = [];
  const log = [];
  const stats = { network: 0, not_modified: 0, cache_hits: 0 };
  const cache = new Map();
  const started = Date.now();
  const browserCap = Math.min(4, maxPages);
  const manualCap = Math.max(1, browserCap - 1);
  let browserOpens = 0;
  let stopped = null;

  async function fetchText(url) {
    if (cache.has(url)) return cache.get(url);
    if (stats.network >= maxRequests) return null;
    stats.network += 1;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": CHROME_UA, accept: "text/plain,application/xml,text/xml,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        log.push(`skip: ${res.status} ${short(url)}`);
        cache.set(url, null);
        return null;
      }
      const text = await res.text();
      const page = { text, finalUrl: res.url || url };
      cache.set(url, page);
      return page;
    } catch (err) {
      log.push(`skip: ${err.message || err}`);
      cache.set(url, null);
      return null;
    }
  }

  function expired() {
    return browserOpens >= browserCap || Date.now() - started > 40000;
  }

  async function openInBrowser(url, required = false) {
    if (cache.has(`b:${url}`)) {
      stats.cache_hits += 1;
      return cache.get(`b:${url}`);
    }
    if (expired()) {
      log.push("stop: browser page cap");
      return null;
    }
    browserOpens += 1;
    stats.network += 1;
    log.push(`browser ${short(url)}`);
    try {
      const viewed = await browsePage(url);
      if (viewed.entered) log.push(`entered on ${viewed.identity} and staying in that browser`);
      const denied = /access denied/i.test(viewed.text || "") && (viewed.text || "").length < 2500;
      if (STOP.has(viewed.status) || viewed.status >= 400 || denied) {
        log.push(`blocked: ${denied ? "access denied" : viewed.status} ${short(url)}`);
        if (required) stopped = viewed.status || 403;
        if (!required) browserOpens -= 1;
        cache.set(`b:${url}`, null);
        return null;
      }
      const page = {
        title: viewed.title,
        text: viewed.text,
        finalUrl: viewed.finalUrl,
        links: viewed.links,
        bytes: viewed.bytes,
        browser: true,
      };
      cache.set(`b:${url}`, page);
      cache.set(`b:${viewed.finalUrl}`, page);
      return page;
    } catch (err) {
      log.push(`browser failed: ${err.message || err}`);
      if (!required) browserOpens -= 1;
      cache.set(`b:${url}`, null);
      return null;
    }
  }

  function push(bucket, page, route, why) {
    if (bucket.some((item) => item.url === page.finalUrl)) return;
    const entry = {
      url: page.finalUrl,
      title: page.title || page.finalUrl,
      route,
      why,
      bytes: page.bytes || 0,
      excerpt: String(page.text || "").replace(/\s+/g, " ").trim().slice(0, 5000),
    };
    bucket.push(entry);
    pages.push(entry);
  }

  const home = new URL(startUrl);
  if (!/^https?:$/.test(home.protocol)) throw new Error("Send a site name, like example.com");
  const origin = originOf(home.href);
  log.push(`browser start ${home.host}`);

  const robots = await fetchText(`${origin}/robots.txt`);
  const robotsOk = robots && /user-agent|sitemap|disallow/i.test(robots.text);
  const parsed = robotsOk ? parseRobots(robots.text, botName) : { rules: [], sitemaps: [] };
  const rules = parsed.rules;
  const sitemaps = parsed.sitemaps.length ? parsed.sitemaps : [`${origin}/sitemap.xml`];
  log.push(robotsOk ? `robots: ${rules.length} rules, ${parsed.sitemaps.length} sitemaps` : "robots.txt blocked, assuming allow");
  const can = (url) => allowed(rules, url);

  const queue = [{ url: home.href, why: "You named this site", score: 0 }];
  const queued = new Set([home.href]);
  if (!can(home.href)) log.push("manual crawl: robots.txt disallows the page you named");
  while (queue.length && manual.length < manualCap && !expired()) {
    const item = queue.shift();
    if (!can(item.url) || !isPage(item.url)) continue;
    const page = await openInBrowser(item.url, item.url === home.href);
    if (stopped) break;
    if (!page) continue;
    push(manual, page, "manual", item.why);
    for (const link of rankLinks(page.links, home.host)) {
      if (queued.has(link.url) || !can(link.url)) continue;
      queued.add(link.url);
      queue.push({
        url: link.url,
        score: link.score,
        why: `Browser link${link.text ? ` "${link.text}" ` : " "}from ${short(page.finalUrl)}`,
      });
    }
    queue.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  log.push(`manual crawl: ${manual.length} browser pages`);

  for (const mapUrl of sitemaps.slice(0, 2)) {
    if (!can(mapUrl)) continue;
    const map = await fetchText(mapUrl);
    if (!map || !/<urlset|<sitemapindex/i.test(map.text.slice(0, 800))) continue;
    log.push(`sitemap ${short(map.finalUrl)}`);
    let urls = locs(map.text);
    if (/<sitemapindex/i.test(map.text) && urls[0] && can(urls[0])) {
      const child = await fetchText(urls[0]);
      if (child) urls = locs(child.text);
    }
    const preferred = urls.filter((u) => /inventory|vehicle/i.test(u));
    const chosen = (preferred.length ? preferred : urls).slice(0, 3);
    if (!chosen.length) continue;
    robot.push({
      url: map.finalUrl,
      title: "sitemap",
      route: "robot",
      why: `Sitemap from robots.txt lists ${urls.length} urls`,
      bytes: 0,
      excerpt: chosen.slice(0, 8).join("\n"),
    });
    for (const loc of chosen) {
      if (robot.filter((item) => item.bytes).length >= 1 || expired() || !can(loc) || !isPage(loc)) continue;
      if (manual.some((item) => item.url === loc)) continue;
      const page = await openInBrowser(loc);
      if (!page) continue;
      push(robot, page, "robot", "Opened in the browser from the sitemap in robots.txt");
    }
  }
  log.push(`robot crawl: ${robot.length} pages`);
  log.push(`done manual=${manual.length} robot=${robot.length} browser=${browserOpens}`);
  return { url: home.href, pages, manual, robot, log, stats, stopped };
}
