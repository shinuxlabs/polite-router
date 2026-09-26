import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";
import { clickLink, lookAround } from "./human.js";
import { reviseShot } from "./grok.js";
import { orderDoors, recallWay, rememberWay } from "./ways.js";

const SHOT_DIR = "/tmp/pr-shots";
let pendingShot = null;

const PACK = "https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar";

const IDENTITIES = [
  { name: "win-1366", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", width: 1366, height: 900, platform: "Win32" },
  { name: "mac-1440", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", width: 1440, height: 900, platform: "MacIntel" },
  { name: "win-1920", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", width: 1920, height: 1080, platform: "Win32" },
];

chromium.setGraphicsMode = false;

let launching;
let session = null;

async function browser() {
  if (!launching) {
    launching = puppeteer.launch({
      args: chromium.args.filter((arg) => arg !== "--single-process").concat(["--disable-blink-features=AutomationControlled"]),
      executablePath: await chromium.executablePath(PACK),
      headless: true,
      defaultViewport: null,
      protocolTimeout: 60000,
    });
  }
  return launching;
}

function blocked(text, status) {
  if (status === 401 || status === 403 || status === 429 || status === 451) return true;
  return /access denied/i.test(text || "") && String(text || "").length < 2500;
}

async function read(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const links = [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.href,
      text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    }));
    return { title: document.title || "", text, links };
  });
}

async function settle(page, light) {
  if (light) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.waitForFunction(
    () => /\d[\d,]*\s+(vehicles|cars|results)/i.test(document.body?.innerText || "") || (document.body?.innerText || "").length > 400,
    { timeout: 2500 },
  ).catch(() => {});
  await lookAround(page);
}

async function freshContext(b) {
  if (typeof b.createBrowserContext === "function") return b.createBrowserContext();
  return b.createIncognitoBrowserContext();
}

async function openIdentity(index) {
  const b = await browser();
  if (session?.context) await session.context.close().catch(() => {});
  const identity = IDENTITIES[index % IDENTITIES.length];
  const context = await freshContext(b);
  const page = await context.newPage();
  await page.setUserAgent(identity.ua);
  await page.setViewport({ width: identity.width, height: identity.height });
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.evaluateOnNewDocument((platform) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "platform", { get: () => platform });
  }, identity.platform);
  session = { context, page, identity: identity.name, origin: "", home: "" };
  return page;
}

async function move(page, url, referer) {
  const before = page.url();
  const clicked = await clickLink(page, url).catch(() => false);
  if (clicked) {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (page.url() !== before) return;
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000, referer: referer || undefined });
}

async function holdShot(page) {
  if (pendingShot) return;
  try {
    pendingShot = await page.screenshot({ type: "jpeg", quality: 40 });
  } catch {
    pendingShot = null;
  }
}

export async function revisePending() {
  const buf = pendingShot;
  pendingShot = null;
  if (!buf) return "";
  await mkdir(SHOT_DIR, { recursive: true });
  const file = join(SHOT_DIR, "one.jpg");
  try {
    await writeFile(file, buf);
    return await reviseShot(file);
  } catch {
    return "";
  } finally {
    await unlink(file).catch(() => {});
  }
}

async function snapshot(page, status, light) {
  const data = await read(page);
  const denied = blocked(data.text, status);
  if (!denied) await holdShot(page);
  return {
    status: status || 200,
    finalUrl: page.url(),
    title: data.title,
    text: data.text,
    links: data.links,
    bytes: Buffer.byteLength(data.text || ""),
    identity: session?.identity || "",
    entered: false,
    human: !light,
    shot: "",
    revision: "",
  };
}

export async function resetShots() {
  pendingShot = null;
  const names = await readdir(SHOT_DIR).catch(() => []);
  await Promise.all(names.map((name) => unlink(join(SHOT_DIR, name)).catch(() => {})));
}

export async function discardShots(paths) {
  const files = new Set(paths || []);
  const names = await readdir(SHOT_DIR).catch(() => []);
  for (const name of names) files.add(join(SHOT_DIR, name));
  await Promise.all([...files].map((file) => unlink(file).catch(() => {})));
}

async function enter(origin) {
  const host = new URL(origin).host;
  const known = await recallWay(host);
  let last = null;
  for (const way of orderDoors(known)) {
    let status = 0;
    try {
      const page = await openIdentity(way.identity || 0);
      const start = `${origin}${way.path === "/" ? "/" : way.path}`;
      try {
        const res = await page.goto(start, {
          waitUntil: "domcontentloaded",
          timeout: 14000,
          referer: way.referer || undefined,
        });
        status = res?.status() || 0;
      } catch {
        status = 0;
      }
      await settle(page, false);
      const shot = await snapshot(page, status, false);
      shot.way = way.door;
      last = shot;
      const open = !blocked(shot.text, status) && status < 400 && String(shot.text || "").length > 200;
      if (open) {
        session.origin = origin;
        session.home = page.url() || start;
        shot.entered = true;
        await rememberWay(host, { ...way, ok: true });
        return shot;
      }
    } catch (err) {
      const msg = String(err?.message || err);
      if (/connection closed|target closed|session closed|browser has disconnected|protocol error/i.test(msg)) {
        await dropBrowser();
      }
    }
    await rememberWay(host, { door: way.door, ok: false });
  }
  session = null;
  return last;
}

export async function dropBrowser() {
  const current = launching;
  launching = null;
  const context = session?.context;
  session = null;
  if (context) await context.close().catch(() => {});
  if (current) {
    try {
      const browser = await current;
      await browser.close();
    } catch {
      // The process is already gone.
    }
  }
}

export async function sessionCookies() {
  if (!session?.page) return "";
  try {
    const list = await session.page.cookies();
    return list.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
}

export async function browsePage(url, options = {}) {
  const light = Boolean(options.light);
  const target = new URL(url);
  const origin = `${target.protocol}//${target.host}`;
  if (!session || session.origin !== origin) {
    const entry = await enter(origin);
    if (!session) return entry;
    const here = new URL(session.home || session.page.url());
    const same = here.pathname === target.pathname && here.search === target.search;
    if (same) return entry;
  }

  const page = session.page;
  await move(page, url, session.home);
  await settle(page, light);
  let shot = await snapshot(page, 200, light);
  if (blocked(shot.text, shot.status) && session.home && !light) {
    await page.goto(session.home, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    await settle(page, true);
    await move(page, url, session.home);
    await settle(page, true);
    shot = await snapshot(page, 200, true);
  }
  return shot;
}
