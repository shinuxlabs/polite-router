function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function between(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function lookAround(page) {
  const view = page.viewport() || { width: 1280, height: 800 };
  for (let i = 0; i < between(3, 5); i += 1) {
    const x = between(48, Math.max(96, view.width - 48));
    const y = between(48, Math.max(96, view.height - 48));
    await page.mouse.move(x, y, { steps: between(6, 12) });
    await wait(between(70, 180));
  }
  await page.evaluate(async () => {
    const height = Math.min(document.body?.scrollHeight || 800, 1600);
    let y = 0;
    let steps = 0;
    while (y < height && steps < 6) {
      y += 160 + Math.floor(Math.random() * 180);
      window.scrollTo(0, y);
      steps += 1;
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 160)));
    }
    window.scrollTo(0, 180);
  });
  await wait(between(180, 420));
}

export async function clickLink(page, url) {
  const point = await page.evaluate((target) => {
    let want;
    try {
      want = new URL(target);
    } catch {
      return null;
    }
    const link = [...document.querySelectorAll("a[href]")].find((el) => {
      try {
        const next = new URL(el.href);
        return next.host === want.host && next.pathname === want.pathname && next.search === want.search;
      } catch {
        return false;
      }
    });
    if (!link) return null;
    link.scrollIntoView({ block: "center", inline: "center" });
    const rect = link.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height / 2, 18),
    };
  }, url);
  if (!point) return false;
  await page.mouse.move(Math.max(2, point.x), Math.max(2, point.y), { steps: between(8, 16) });
  await wait(between(90, 240));
  await page.mouse.click(Math.max(2, point.x), Math.max(2, point.y), { delay: between(40, 110) });
  return true;
}
