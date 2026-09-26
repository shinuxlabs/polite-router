import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";
import { clickLink, lookAround } from "./human.js";
import { reviseShot } from "./grok.js";

const SHOT_DIR = "/tmp/pr-shots";
const SHOT_CAP = 3;
let shotsTaken = 0;

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
      args: [...chromium.args, "--disable-blink-features=AutomationControlled"],
      executablePath: await chromium.executablePath(PACK),
      headless: "shell",
      defaultViewport: null,
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

async function saveShot(page) {
  if (shotsTaken >= SHOT_CAP) return "";
  await mkdir(SHOT_DIR, { recursive: true });
  const existing = await readdir(SHOT_DIR).catch(() => []);
  if (existing.length) return "";
  const file = join(SHOT_DIR, `${Date.now()}-${shotsTaken + 1}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 42, fullPage: false });
  shotsTaken += 1;
  return file;
}

async function snapshot(page, status, light) {
  const data = await read(page);
  const denied = blocked(data.text, status);
  const file = denied ? "" : await saveShot(page).catch(() => "");
  let revision = "";
  if (file) {
    try {
      revision = await reviseShot(file);
    } catch {
      revision = "";
    } finally {
      await unlink(file).catch(() => {});
    }
  }
  const visible = String(data.text || "").slice(0, revision ? 240 : 500);
  return {
    status: status || 200,
    finalUrl: page.url(),
    title: data.title,
    text: revision ? `${revision} ${visible}` : (file ? visible : data.text),
    links: data.links,
    bytes: Buffer.byteLength(data.text || ""),
    identity: session?.identity || "",
    entered: false,
    human: !light,
    shot: "",
    revision,
  };
}

export async function resetShots() {
  shotsTaken = 0;
  const names = await readdir(SHOT_DIR).catch(() => []);
  await Promise.all(names.map((name) => unlink(join(SHOT_DIR, name)).catch(() => {})));
}

export async function discardShots(paths) {
  const files = new Set(paths || []);
  const names = await readdir(SHOT_DIR).catch(() => []);
  for (const name of names) files.add(join(SHOT_DIR, name));
  await Promise.all([...files].map((file) => unlink(file).catch(() => {})));
  shotsTaken = 0;
}

async function enter(origin) {
  let last = null;
  for (let i = 0; i < IDENTITIES.length; i += 1) {
    const page = await openIdentity(i);
    let status = 0;
    try {
      const res = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 14000 });
      status = res?.status() || 0;
    } catch {
      status = 0;
    }
    await settle(page, false);
    const shot = await snapshot(page, status, false);
    last = shot;
    if (!blocked(shot.text, status)) {
      session.origin = origin;
      session.home = page.url() || `${origin}/`;
      shot.entered = true;
      return shot;
    }
  }
  session = null;
  return last;
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
