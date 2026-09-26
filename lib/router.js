import { browsePage, dropBrowser, resetShots, sessionCookies } from "./browser.js";
import { learnFilters, pickLinks } from "./grok.js";
import { chooseFilter, filterLinks, mergeFilters, noteResult, recall, remember } from "./filters.js";

const STOP = new Set([401, 403, 429, 451]);
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const URL_RE = /https?:\/\/[^\s>|]+/g;
const SKIP_TLD = new Set(["htm", "html", "php", "asp", "aspx", "js", "css", "jpg", "jpeg", "png", "gif", "svg", "xml", "json", "txt", "pdf", "zip", "webp", "ico"]);
const FRONTIER_CAP = 4000;

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

function short(url) {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return (path && path !== "/" ? path : u.host).slice(0, 90);
  } catch {
    return String(url).slice(0, 90);
  }
}

function bareHost(url) {
  return new URL(url).host.replace(/^www\./, "");
}

function sameSite(url, homeHref) {
  try {
    return bareHost(url) === bareHost(homeHref);
  } catch {
    return false;
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

function pathOf(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}` || "/";
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

function visibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlLinks(html, base) {
  const out = [];
  for (const match of String(html || "").matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(match[1], base);
      if (/^https?:$/.test(u.protocol)) out.push({ href: u.href.split("#")[0], text: "" });
    } catch {
      /* skip */
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function routeSite(startUrl, options = {}) {
  const botName = options.botName || "PoliteRouter";
  const pages = [];
  const manual = [];
  const robot = [];
  const log = [];
  const stats = { network: 0, not_modified: 0, cache_hits: 0 };
  const started = Date.now();
  const deadline = started + (options.maxMs || 240000);
  const shots = [];
  await resetShots();
  let stopped = null;
  let read = 0;
  let reason = "finished";

  async function fetchRaw(url) {
    if (stats.network >= 5000) return null;
    stats.network += 1;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": CHROME_UA, accept: "text/plain,application/xml,text/xml,text/html,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        log.push(`skip: ${res.status} ${short(url)}`);
        return null;
      }
      return { text: await res.text(), finalUrl: res.url || url };
    } catch (err) {
      log.push(`skip: ${err.message || err}`);
      return null;
    }
  }

  const home = new URL(startUrl);
  if (!/^https?:$/.test(home.protocol)) throw new Error("Send a site name, like example.com");
  const origin = originOf(home.href);
  const frontier = [];
  const queued = new Set();

  const robotsFile = await fetchRaw(`${origin}/robots.txt`);
  const robotsOk = robotsFile && /user-agent|sitemap|disallow/i.test(robotsFile.text);
  const parsed = robotsOk ? parseRobots(robotsFile.text, botName) : { rules: [], sitemaps: [] };
  const rules = parsed.rules;
  const sitemaps = parsed.sitemaps.length ? parsed.sitemaps : [`${origin}/sitemap.xml`];
  const can = (url) => allowed(rules, url);
  log.push(robotsOk ? `robots: ${rules.length} rules, ${parsed.sitemaps.length} sitemaps` : "robots.txt blocked, assuming allow");

  function enqueue(url, why, score) {
    let href = "";
    try {
      href = new URL(url, home.href).href.split("#")[0];
    } catch {
      return;
    }
    if (queued.has(href) || queued.size >= FRONTIER_CAP) return;
    if (!sameSite(href, home.href) || !isPage(href) || !can(href)) return;
    queued.add(href);
    frontier.push({ url: href, why, score: score || 1 });
  }

  const candidates = [];
  const seenLinks = new Set();
  const pending = [];
  function consider(url, text) {
    let href = "";
    try {
      href = new URL(url, home.href).href.split("#")[0];
    } catch {
      return;
    }
    if (seenLinks.has(href) || seenLinks.size >= FRONTIER_CAP) return;
    if (!sameSite(href, home.href) || !isPage(href) || !can(href)) return;
    seenLinks.add(href);
    candidates.push({ url: href, text: text || "" });
  }
  function absorb(links) {
    for (const link of links || []) {
      const before = seenLinks.size;
      consider(link.href || link.url, link.text || "");
      if (seenLinks.size > before) pending.push(candidates[candidates.length - 1]);
    }
  }

  async function openInBrowser(url, required, light) {
    if (Date.now() > deadline) return null;
    stats.network += 1;
    log.push(`browser ${short(url)}`);
    try {
      const viewed = await browsePage(url, { light });
      if (!viewed) return null;
      if (viewed.entered) log.push(`entered on ${viewed.identity} and staying in that browser`);
      if (viewed.human) log.push("human agent: moved the pointer, scrolled, and clicked");
      const denied = STOP.has(viewed.status) || viewed.status >= 400 || (/access denied/i.test(viewed.text || "") && (viewed.text || "").length < 2500);
      if (denied) {
        if (required) stopped = viewed.status || 403;
        return { blocked: true };
      }
      if (viewed.revision) log.push("revised one screenshot and deleted it");
      if (viewed.shot) shots.push(viewed.shot);
      return {
        title: viewed.title,
        text: viewed.text,
        finalUrl: viewed.finalUrl,
        links: viewed.links,
        bytes: viewed.bytes,
        shot: viewed.shot || "",
      };
    } catch (err) {
      const msg = String(err.message || err);
      const dropped = /connection closed|target closed|session closed|browser has disconnected|protocol error|navigation failed/i.test(msg);
      if (!dropped) {
        log.push(`browser failed: ${msg}`);
        return null;
      }
      log.push("browser dropped, reopening");
      await dropBrowser();
      try {
        const viewed = await browsePage(url, { light: true });
        if (!viewed) return null;
        const denied = STOP.has(viewed.status) || viewed.status >= 400 || (/access denied/i.test(viewed.text || "") && (viewed.text || "").length < 2500);
        if (denied) return { blocked: true };
        if (viewed.revision) log.push("revised one screenshot and deleted it");
        return {
          title: viewed.title,
          text: viewed.text,
          finalUrl: viewed.finalUrl,
          links: viewed.links,
          bytes: viewed.bytes,
          shot: "",
        };
      } catch (err2) {
        log.push(`browser failed: ${err2.message || err2}`);
        return null;
      }
    }
  }

  async function fetchHtml(url, cookies) {
    if (stats.network >= 5000) return { missing: true };
    stats.network += 1;
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": CHROME_UA,
          accept: "text/html,application/xhtml+xml",
          cookie: cookies || "",
          referer: `${origin}/`,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (STOP.has(res.status)) return { blocked: true, status: res.status };
      if (!res.ok) return { missing: true, status: res.status };
      const html = await res.text();
      const text = visibleText(html);
      if (/access denied/i.test(text) && text.length < 2500) return { blocked: true, status: 403 };
      const title = html.match(/<title[^>]*>([^<]{1,180})/i)?.[1]?.replace(/\s+/g, " ").trim() || url;
      return { title, text, finalUrl: res.url || url, links: htmlLinks(html, res.url || url), bytes: Buffer.byteLength(html) };
    } catch (err) {
      return { missing: true, error: err.message || String(err) };
    }
  }

  function push(page, why) {
    if (!page?.finalUrl || manual.some((item) => item.url === page.finalUrl)) return;
    const raw = String(page.text || "").replace(/\s+/g, " ").trim();
    const interesting = /vehicle|inventory|\bvin\b|results/i.test(raw);
    const excerpt = page.shot ? raw.slice(0, 240) : raw.slice(0, read <= 8 || interesting ? 1800 : 220);
    const entry = {
      url: page.finalUrl,
      title: page.title || page.finalUrl,
      route: "manual",
      why,
      bytes: page.bytes || 0,
      excerpt,
    };
    manual.push(entry);
    pages.push(entry);
  }

  const sitemapUrls = [];
  const mapSeen = new Set();
  const mapQueue = sitemaps.slice(0, 8);
  while (mapQueue.length && mapSeen.size < 12 && sitemapUrls.length < FRONTIER_CAP && Date.now() < deadline) {
    const mapUrl = mapQueue.shift();
    if (!mapUrl || mapSeen.has(mapUrl) || !can(mapUrl)) continue;
    mapSeen.add(mapUrl);
    const map = await fetchRaw(mapUrl);
    if (!map || !/<urlset|<sitemapindex/i.test(map.text.slice(0, 800))) continue;
    const found = locs(map.text);
    if (/<sitemapindex/i.test(map.text.slice(0, 800))) {
      mapQueue.push(...found.filter((loc) => /sitemap|\.xml/i.test(loc)).slice(0, 20));
      continue;
    }
    sitemapUrls.push(...found);
  }
  for (const loc of sitemapUrls) consider(loc, "");
  for (const path of ["/used-inventory/index.htm", "/new-inventory/index.htm", "/certified-inventory/index.htm"]) {
    consider(`${origin}${path}`, "inventory");
  }
  log.push(`manual crawl starting ${home.host}`);
  const homePage = await openInBrowser(home.href, true, false);
  let added = 0;
  if (homePage?.blocked || stopped) {
    reason = "blocked";
  } else if (homePage) {
    read += 1;
    push(homePage, "You named this site");
    absorb(homePage.links);
    const site = home.host.replace(/^www\./, "");
    const known = await recall(site);
    const learned = await learnFilters(site, filterLinks(candidates));
    const catalog = await remember(site, mergeFilters(known.filters, learned));
    const chosenFilter = chooseFilter(options.question || "", catalog);
    if (chosenFilter) {
      enqueue(chosenFilter.url, `Site filter: ${chosenFilter.label || chosenFilter.kind}`, 95);
      log.push(`filter: ${chosenFilter.label || chosenFilter.kind}`);
    } else {
      log.push(`filters: ${catalog.filters.length} learned, none matched this question`);
    }
    const decision = await pickLinks(options.question || "", candidates, {
      deadline: Math.min(deadline, Date.now() + 45000),
    });
    log.push(`link match: ${decision.urls.length} of ${decision.judged} hyperlinks`);
    let urls = decision.urls;
    if (/how many|count|cars|vehicles|inventory|listed/i.test(options.question || "")) {
      const inventory = candidates
        .filter((link) => /used-inventory\/index|new-inventory\/index|view all inventory|all inventory|pre-owned/i.test(`${link.url} ${link.text}`))
        .map((link) => link.url);
      urls = [...new Set([...inventory, ...urls])];
    }
    if (!urls.length) {
      urls = [...candidates].sort((a, b) => linkScore(b) - linkScore(a)).slice(0, 8).map((link) => link.url);
      log.push("link match: no direct match, opening the closest pages");
    }
    for (const url of urls) {
      if (url === homePage.finalUrl) continue;
      enqueue(url, "Matched the question", 80);
    }
    added = urls.length;
    pending.length = 0;
  } else if (!stopped && candidates.length) {
    const decision = await pickLinks(options.question || "", candidates, {
      deadline: Math.min(deadline, Date.now() + 45000),
    });
    log.push(`link match: ${decision.urls.length} of ${decision.judged} hyperlinks`);
    for (const url of decision.urls) enqueue(url, "Matched the question", 80);
    added = decision.urls.length;
  }
  if (sitemapUrls.length) {
    robot.push({
      url: sitemaps[0],
      title: "sitemap",
      route: "robot",
      why: `Sitemap listed ${sitemapUrls.length} urls. ${added} matched the question.`,
      bytes: 0,
      excerpt: sitemapUrls.slice(0, 12).join("\n"),
    });

  }
  log.push(`robot crawl: ${sitemapUrls.length} sitemap urls`);
  const retried = new Set();
  let streak = 0;

  while (frontier.length) {
    if (Date.now() > deadline) {
      reason = "time";
      break;
    }
    frontier.sort((a, b) => (b.score || 0) - (a.score || 0));
    const item = frontier.shift();
    if (manual.some((page) => page.url === item.url)) continue;

    let blockedHit = false;
    let page = null;
    if (read > 0) {
      const fast = await fetchHtml(item.url, await sessionCookies());
      if (fast.blocked) blockedHit = true;
      else if ((fast.text || "").length > 350) page = fast;
    }
    if (!page && !blockedHit) {
      const viewed = await openInBrowser(item.url, read === 0, read > 0);
      if (viewed?.blocked) blockedHit = true;
      else page = viewed;
    }
    if (!page && !blockedHit) {
      const fast = await fetchHtml(item.url, await sessionCookies());
      if (fast?.blocked) blockedHit = true;
      else if ((fast?.text || "").length > 200) page = fast;
    }
    if (stopped) break;
    if (blockedHit) {
      streak += 1;
      log.push(`blocked ${short(item.url)}`);
      if (streak >= 2) {
        reason = "blocked";
        log.push("stop: two blocks in a row, leaving before the site kicks the session");
        break;
      }
      if (!retried.has(item.url)) {
        retried.add(item.url);
        await openInBrowser(home.href, false, true);
        frontier.unshift(item);
        await sleep(1200);
      }
      continue;
    }
    if (!page) continue;
    streak = 0;
    read += 1;
    push(page, item.why);
    noteResult(home.host, page.finalUrl, page.text, false);
    absorb(page.links);
    if (pending.length >= 40 && options.question && Date.now() < deadline - 20000) {
      const batch = pending.splice(0, pending.length);
      const more = await pickLinks(options.question, batch, { deadline: Math.min(deadline - 15000, Date.now() + 20000) });
      log.push(`link match: ${more.urls.length} of ${more.judged} new hyperlinks`);
      for (const url of more.urls) enqueue(url, "Matched the question", 70);
    }
    if (read === 1 || read % 25 === 0) {
      await options.onProgress?.({ read, found: queued.size });
    }
    await sleep(read < 3 ? 200 : 250 + Math.floor(Math.random() * 300));
  }

  if (pending.length && options.question && reason !== "blocked" && Date.now() < deadline - 10000) {
    const more = await pickLinks(options.question, pending.splice(0, pending.length), {
      deadline: Math.min(deadline - 8000, Date.now() + 15000),
    });
    log.push(`link match: ${more.urls.length} of ${more.judged} new hyperlinks`);
    for (const url of more.urls) enqueue(url, "Matched the question", 70);
  }

  if (reason === "finished" && queued.size >= FRONTIER_CAP) reason = "cap";
  if (added && reason === "finished" && Date.now() < deadline) {
    reason = "time";
    while (frontier.length && Date.now() < deadline && streak < 2) {
      frontier.sort((a, b) => (b.score || 0) - (a.score || 0));
      const item = frontier.shift();
      if (manual.some((page) => page.url === item.url)) continue;
      const fast = await fetchHtml(item.url, await sessionCookies());
      if (fast.blocked) {
        streak += 1;
        if (streak >= 2) {
          reason = "blocked";
          log.push("stop: two blocks in a row, leaving before the site kicks the session");
          break;
        }
        continue;
      }
      if ((fast.text || "").length < 350) continue;
      streak = 0;
      read += 1;
      push(fast, item.why);
      absorb(fast.links);
      if (read % 25 === 0) await options.onProgress?.({ read, found: queued.size });
      await sleep(250 + Math.floor(Math.random() * 300));
    }
    if (!frontier.length && streak < 2) reason = queued.size >= FRONTIER_CAP ? "cap" : "finished";
  }

  const site = home.host.replace(/^www\./, "");
  const learnedNow = await recall(site);
  if (learnedNow.filters?.length) await remember(site, learnedNow.filters);
  await options.onProgress?.({ read, found: queued.size, done: true });
  log.push(`manual crawl: read ${read} of ${queued.size} (${reason})`);
  return {
    url: home.href,
    pages,
    manual,
    robot,
    log,
    stats,
    stopped,
    coverage: { found: queued.size, read, reason },
    shots,
  };
}
