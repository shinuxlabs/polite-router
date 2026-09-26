import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

const PACK = "https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

chromium.setGraphicsMode = false;

let launching;

async function browser() {
  if (!launching) {
    launching = puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1366, height: 900 },
      executablePath: await chromium.executablePath(PACK),
      headless: "shell",
    });
  }
  return launching;
}

export async function browsePage(url) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    let status = 0;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 18000 });
    status = res?.status() || 0;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await page.waitForFunction(
      () => /\d[\d,]*\s+(vehicles|cars|results)/i.test(document.body?.innerText || ""),
      { timeout: 4000 },
    ).catch(() => {});
    const data = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const links = [...document.querySelectorAll("a[href]")].map((a) => ({
        href: a.href,
        text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      }));
      return { title: document.title || "", text, links };
    });
    return {
      status,
      finalUrl: page.url() || url,
      title: data.title,
      text: data.text,
      links: data.links,
      bytes: Buffer.byteLength(data.text || ""),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
