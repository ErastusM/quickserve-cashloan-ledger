// Renders marketing/website-launch-poster.html to PNG at 1080x1350 (saved at
// 2x, 2160x2700) and checks that no two blocks overlap or leave the page.
// The HTML embeds its fonts and QR code, so it renders the same anywhere.
const path = require("path");
const { chromium } = require("playwright");

const HTML = path.join(__dirname, "..", "marketing", "website-launch-poster.html");
const PNG = path.join(__dirname, "..", "marketing", "website-launch-poster.png");
const BLOCKS = [".soon", ".brand", ".kicker", "h1", "h2", ".lede", ".slipwrap", ".steps", ".foot"];

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.goto("file://" + HTML);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: PNG });

  const boxes = await page.evaluate((sels) => sels.map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { s, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
  }), BLOCKS);
  const problems = [];
  for (const b of boxes) if (b.x1 < 0 || b.y1 < 0 || b.x2 > 1080 || b.y2 > 1350) problems.push(`${b.s} leaves the page`);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    if (ox > 1 && oy > 1) problems.push(`${a.s} overlaps ${b.s} by ${Math.round(ox)}×${Math.round(oy)} px`);
  }
  await browser.close();
  if (problems.length) { console.log("LAYOUT PROBLEMS:\n  " + problems.join("\n  ")); process.exitCode = 1; }
  else console.log("Rendered " + PNG + " — no overlaps.");
})();
