// Build the QuickServe flyer: inline the fonts as data URIs so the HTML is
// fully self-contained, then render it to PNG at 1080x1350.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HERE = __dirname;
const OUT_HTML = path.join(HERE, "..", "marketing", "quickserve-flyer.html");
const OUT_PNG = path.join(HERE, "..", "marketing", "quickserve-flyer.png");

// The flyer HTML already carries its fonts and graphics inline, so it is both the
// editable source and the thing we render. Edit the HTML, re-run this.
console.log(`Source: ${OUT_HTML} (${(fs.statSync(OUT_HTML).size / 1024).toFixed(0)} KB, fonts embedded)`);

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
  );
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 2
  });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.goto("file://" + OUT_HTML);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT_PNG });

  // Measure every block that must not collide, and report overlaps as numbers
  // rather than eyeballing the render.
  const boxes = await page.evaluate(() => {
    const sel = {
      logo: '.header', headline: '.headline', subhead: '.subhead',
      cards: '.features', reqHead: '.req-head', reqList: '.req-list',
      trust: '.trust', contact: '.contact', phone: '.phone'
    };
    const out = {};
    for (const [k, s] of Object.entries(sel)) {
      const r = document.querySelector(s).getBoundingClientRect();
      out[k] = { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) };
    }
    return out;
  });

  const overlaps = (a, b) => !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y);
  const MUST_NOT_TOUCH = [
    ['headline','phone'], ['subhead','phone'], ['cards','phone'],
    ['cards','reqHead'], ['reqHead','reqList'], ['reqList','contact'],
    ['reqList','trust'], ['trust','contact'], ['trust','phone'],
    ['logo','phone'], ['subhead','cards'], ['headline','subhead']
  ];

  console.log('\n  element      x     y     right  bottom');
  for (const [k, v] of Object.entries(boxes)) {
    console.log(`  ${k.padEnd(10)} ${String(v.x).padStart(5)} ${String(v.y).padStart(5)} ${String(v.r).padStart(6)} ${String(v.b).padStart(7)}`);
  }
  const hits = MUST_NOT_TOUCH.filter(([a, b]) => overlaps(boxes[a], boxes[b]));
  console.log(hits.length
    ? '\n  COLLISIONS: ' + hits.map(([a,b]) => `${a}<->${b}`).join(', ')
    : '\n  LAYOUT OK - no collisions');
  const overflow = Object.entries(boxes).filter(([,v]) => v.r > 1080 || v.b > 1350 || v.x < 0 || v.y < 0);
  if (overflow.length) console.log('  OFF-CANVAS: ' + overflow.map(([k]) => k).join(', '));
  await browser.close();
})();
