// Renders the "website coming soon" posters to PNG at 2x and checks that no two
// blocks overlap or leave the page:
//   marketing/website-coming-soon-poster.html        1080×1350 (feeds)
//   marketing/website-coming-soon-status.html        1080×1920 (WhatsApp Status, Stories)
// The HTML files embed their fonts and QR code, so they render the same anywhere.
const path = require("path");
const { chromium } = require("playwright");

const M = path.join(__dirname, "..", "marketing");
const POSTERS = [
  { name: "website-coming-soon-poster", w: 1080, h: 1350, blocks: [".soon", ".brand", ".kicker", "h1", "h2", ".lede", ".slipwrap", ".steps", ".foot"] },
  { name: "website-coming-soon-status", w: 1080, h: 1920, blocks: [".soon", ".brand", ".kicker", "h1", "h2", ".lede", ".slipwrap", ".steps", ".foot"] }
];

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  let failed = false;
  for (const poster of POSTERS) {
    const page = await browser.newPage({ viewport: { width: poster.w, height: poster.h }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    await page.goto("file://" + path.join(M, poster.name + ".html"));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(M, poster.name + ".png") });
    const boxes = await page.evaluate((sels) => sels.map((s) => {
      const el = document.querySelector(s);
      if (!el || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      return { s, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
    }).filter(Boolean), poster.blocks);
    const problems = [];
    for (const b of boxes) if (b.x1 < -1 || b.y1 < -1 || b.x2 > poster.w + 1 || b.y2 > poster.h + 1) problems.push(`${b.s} leaves the page`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (ox > 1 && oy > 1) problems.push(`${a.s} overlaps ${b.s} by ${Math.round(ox)}×${Math.round(oy)} px`);
    }
    if (problems.length) { failed = true; console.log(poster.name + ": LAYOUT PROBLEMS\n  " + problems.join("\n  ")); }
    else console.log(poster.name + ".png rendered — no overlaps.");
    console.log("  " + boxes.map((b) => `${b.s} ${Math.round(b.y1)}–${Math.round(b.y2)}`).join(" · "));
    await page.close();
  }
  await browser.close();
  if (failed) process.exitCode = 1;
})();
