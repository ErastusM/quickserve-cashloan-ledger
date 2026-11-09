// Records marketing/how-to-apply-video.mp4: the "How to apply" walkthrough on a phone-sized browser against a
// local copy of the site (sample documents, no real application).
const { chromium, devices } = require("playwright");
const DIR = __dirname, SITE = process.env.SITE || "http://localhost:8788";
// Recorded in real time from the browser's own screen stream (about 55–60
// frames a second) at 780×1688: the page is shown at 2× zoom in a 780-wide
// window, so it keeps its phone layout but every frame is sharp.
const SLOW = 1;
const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=Instrument+Sans:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap">';

function card(top, title, sub, foot) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${FONTS}<style>
  html{zoom:2}
  body{margin:0;background:#053437;color:#f8f8f3;font-family:"Instrument Sans",Arial,sans-serif;height:844px;display:flex;flex-direction:column;justify-content:center;padding:0 26px;box-sizing:border-box}
  .k{font:600 13px "IBM Plex Mono",monospace;letter-spacing:.18em;color:#9cc3bd;text-transform:uppercase}
  h1{font:900 64px/0.9 "Big Shoulders Display","Arial Narrow",sans-serif;text-transform:uppercase;margin:14px 0 0}
  h1 span{color:#12b84f} p{font-size:19px;line-height:1.45;color:#d5e6e2;margin:18px 0 0}
  .foot{margin-top:34px;background:#f3d94a;color:#0e2224;padding:16px 18px;font-weight:700;font-size:20px;box-shadow:5px 5px 0 #021e20}
  .foot small{display:block;font:600 12px "IBM Plex Mono",monospace;letter-spacing:.16em;margin-bottom:6px}
  </style></head><body><div class="k">${top}</div><h1>${title}</h1><p>${sub}</p>${foot || ""}</body></html>`;
}

async function caption(p, step, text) {
  await p.evaluate(([s, t]) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div"); el.id = "__cap";
      el.style.cssText = "position:fixed;left:10px;right:10px;top:10px;z-index:99999;background:#f3d94a;color:#0e2224;font:600 17px/1.35 'Instrument Sans',Arial,sans-serif;padding:11px 14px;border:2px solid #0e2224;box-shadow:4px 4px 0 #021e20;transition:opacity .3s";
      document.body.appendChild(el);
    }
    el.style.opacity = "0";
    setTimeout(() => { el.innerHTML = (s ? '<div style="font:600 11px/1 \'IBM Plex Mono\',monospace;letter-spacing:.14em;margin-bottom:5px">' + s + "</div>" : "") + t; el.style.opacity = "1"; }, 180);
  }, [step, text]);
  await p.waitForTimeout(350 * SLOW);
}
// Glides the page (native smooth scrolling) so the element sits in view below the caption.
async function glideTo(p, locator) {
  const box = await locator.first().boundingBox();
  if (!box) return;
  if (box.y >= 240 && box.y + box.height <= 1688 - 260) return;
  await locator.first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await p.waitForTimeout(750);
}
async function mark(p, locator) {
  const el = locator.first();
  await glideTo(p, locator);
  await p.waitForTimeout(150 * SLOW);
  const b = await el.boundingBox();
  if (!b) return;
  await p.evaluate(({ x, y }) => {
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;left:${x - 24}px;top:${y - 24}px;width:48px;height:48px;border-radius:50%;background:rgba(18,184,79,.4);border:3px solid #12b84f;z-index:100000;pointer-events:none;transition:transform .55s ease-out,opacity .55s ease-out`;
    document.body.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => { d.style.transform = "scale(1.7)"; d.style.opacity = "0"; }));
    setTimeout(() => d.remove(), 700);
  }, { x: (b.x + b.width / 2) / 2, y: (b.y + b.height / 2) / 2 });
  await p.waitForTimeout(380 * SLOW);
}
async function tap(p, locator) { await mark(p, locator); await locator.first().click(); }
async function typeIn(p, sel, text) { const l = p.locator(sel); await mark(p, l); await l.click(); await l.pressSequentially(text, { delay: 55 * SLOW }); }

(async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  const ctx = await browser.newContext({ userAgent: devices["iPhone 13"].userAgent, isMobile: true, hasTouch: true, viewport: { width: 780, height: 1688 }, deviceScaleFactor: 1 });
  // The site's sizes that depend on screen width, set to what a 390-wide phone shows.
  const PHONE_CSS = `html{zoom:2}
    .nav .hide-sm{display:none}.hero-slip{transform:none}.hero-slip .stamp{right:6px;top:70px;font-size:12px}.slip{padding:26px 18px 22px}
    .clauses li{grid-template-columns:36px minmax(0,1fr)}.app-shell{min-height:844px}
    .amount{font-size:44px}.hero h1{font-size:64px}.hero .lede{font-size:18px}.band h2{font-size:48px}.clauses p{font-size:22px}
    .equation{font-size:40px}.foot .phone{font-size:44px}.receipt .ref{font-size:48px}.sheet h1{font-size:40px}
    #fineprint h2{font-size:56px!important}.band-ground .wrap[style] > h2{font-size:44px!important}
    main.wrap h1.display,#h5{font-size:48px!important}`;
  await ctx.addInitScript((css) => {
    const add = () => { if (document.getElementById("__phone")) return; const st = document.createElement("style"); st.id = "__phone"; st.textContent = css; (document.head || document.documentElement).appendChild(st); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
  }, PHONE_CSS);
  await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: "window.turnstile={render:function(el,o){setTimeout(function(){o.callback('ok')},300);return 1},reset:function(){}}" }));
  await ctx.route("https://static.cloudflareinsights.com/**", (r) => r.abort());
  const p = await ctx.newPage();
  const W = (ms) => p.waitForTimeout(ms * SLOW);
  if (process.env.DEBUG) {
    p.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 160)));
    p.on("pageerror", (e) => console.log("pageerror:", e.message));
    p.on("request", (r) => { if (!r.url().includes("fonts")) console.log("req:", r.method(), r.url().slice(0, 100)); });
    p.on("requestfailed", (r) => console.log("failed:", r.url().slice(0, 100), r.failure() && r.failure().errorText));
  }
  // Capture the screen itself at full phone resolution (780×1688).
  const fs = require("fs");
  fs.rmSync(DIR + "/frames", { recursive: true, force: true }); fs.mkdirSync(DIR + "/frames");
  const frames = [];
  // The browser's own screen stream: a frame whenever the screen changes.
  const cdp = await ctx.newCDPSession(p);
  let recording = true;
  cdp.on("Page.screencastFrame", async (f) => {
    if (recording) {
      const file = DIR + "/frames/" + String(frames.length).padStart(5, "0") + ".jpg";
      fs.writeFileSync(file, Buffer.from(f.data, "base64"));
      frames.push({ file, t: f.metadata.timestamp });
    }
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  const shooter = Promise.resolve();

  // Title
  await p.setContent(card("QuickServe Cashloan · how to apply", "Apply for a<br><span>payday loan</span>", "On your phone, in about five minutes. Here’s every step.",
    '<div class="foot"><small>YOU NEED</small>Your ID or passport · latest payslip · 3 months’ bank statements</div>'));
  await W(4200);

  // Home + quote slip
  await p.goto(SITE + "/"); await W(1200);
  await caption(p, "STEP 1 · QUICKSERVE.GROUP", "Open <b>quickserve.group</b>. The quote slip shows the full cost before you apply.");
  await W(2600);
  const more = p.locator("#qMore");
  await caption(p, "STEP 1 · CHOOSE AN AMOUNT", "Tap <b>+</b> or <b>−</b> to choose how much you need. Interest is 30%, paid once, on your payday.");
  for (let i = 0; i < 5; i++) { await tap(p, more); await W(220); }
  await W(1800);
  await caption(p, "STEP 1 · START", "Tap <b>Apply with this slip</b>.");
  await W(900);
  await tap(p, p.locator("text=Apply with this slip"));
  await p.waitForSelector("#s1:not([hidden])"); await W(800);

  if (process.env.UNTIL === "sheet1") { recording = false; await shooter; console.log("test: " + frames.length + " frames"); await ctx.close(); await browser.close(); return; }
  // Sheet 1
  await caption(p, "SHEET 1 OF 4 · THE LOAN", "Your amount is already filled in. Tick what the loan is for.");
  await W(1600);
  await tap(p, p.locator("label.tick:has-text('School fees')")); await W(1400);
  await caption(p, "SHEET 1 OF 4 · THE LOAN", "Check the total you’ll repay, then tap <b>Next</b>.");
  await W(1400);
  await tap(p, p.locator("#next")); await p.waitForSelector("#s2:not([hidden])"); await W(800);

  // Sheet 2
  await caption(p, "SHEET 2 OF 4 · ABOUT YOU", "Fill in your details exactly as on your ID or passport.");
  await typeIn(p, "[name=fullName]", "Ndapewa Shikongo");
  await typeIn(p, "[name=nationalId]", "91041500123");
  await caption(p, "SHEET 2 OF 4 · ABOUT YOU", "Use the cellphone number you use on WhatsApp. We send your updates there.");
  await typeIn(p, "[name=phone]", "081 234 5678");
  await caption(p, "SHEET 2 OF 4 · ABOUT YOU", "Add your employer, payday, take-home pay and a next of kin.");
  await typeIn(p, "[name=employer]", "Ministry of Education");
  await typeIn(p, "[name=payday]", "25th");
  await typeIn(p, "[name=netIncome]", "9800");
  await typeIn(p, "[name=kinName]", "Tangeni Shikongo");
  await typeIn(p, "[name=kinPhone]", "081 765 4321");
  await W(900);
  await caption(p, "SHEET 2 OF 4 · ABOUT YOU", "Everything is saved on your phone as you go. Tap <b>Next</b>.");
  await W(1200);
  await tap(p, p.locator("#next"));
  if (process.env.UNTIL === "sheet3") {
    const ok = await p.waitForSelector("#s3:not([hidden])", { timeout: 30000 }).then(() => true, () => false);
    console.log("sheet 3 reached:", ok, "| alert:", await p.textContent("#alert2"), "| button:", await p.textContent("#next"), "| ts2:", await p.innerHTML("#ts2"));
    recording = false; await shooter; await ctx.close(); await browser.close(); return;
  }
  await p.waitForSelector("#s3:not([hidden])"); await W(900);

  // Sheet 3
  await caption(p, "SHEET 3 OF 4 · DOCUMENTS", "Take a photo or choose a PDF for each document. Lay the page flat with all four corners showing.");
  await W(2600);
  const attach = async (kind, files) => {
    await mark(p, p.locator(`label.add-file:has(input[data-kind=${kind}])`));
    await p.setInputFiles(`input[data-kind=${kind}]`, files.map((f) => DIR + "/" + f));
    await W(1300);
  };
  await attach("id", ["id-sample.jpg"]);
  await attach("payslip", ["payslip-sample.jpg"]);
  await caption(p, "SHEET 3 OF 4 · DOCUMENTS", "Add all 3 months of bank statements. Each one gets an <b>Attached</b> stamp.");
  await attach("bank", ["statement-august-sample.jpg", "statement-september-sample.jpg", "statement-october-sample.jpg"]);
  await W(1600);
  await tap(p, p.locator("#next")); await p.waitForSelector("#s4:not([hidden])"); await W(900);

  // Sheet 4
  await caption(p, "SHEET 4 OF 4 · CHECK & SIGN", "Check your details, tick the three boxes, and type your full name to sign.");
  await W(1800);
  for (const n of ["creditCheck", "privacy", "truthful"]) { await tap(p, p.locator(`[name=${n}]`)); await W(350); }
  await typeIn(p, "[name=signedName]", "Ndapewa Shikongo");
  await W(900);
  await caption(p, "SHEET 4 OF 4 · CHECK & SIGN", "This is an application, not a loan agreement. Tap <b>Hand in my application</b>.");
  await W(1800);
  await tap(p, p.locator("#next")); await p.waitForSelector("#s5:not([hidden])"); await W(1200);

  // Customer copy
  await caption(p, "DONE · YOUR CUSTOMER COPY", "Take a screenshot of your copy. Your reference starts with <b>QSA-</b>.");
  await W(4200);

  // Tracking
  await caption(p, "TRACK YOUR APPLICATION", "Tap <b>Track this application</b> any time to see where it is.");
  await W(1400);
  await tap(p, p.locator("#next")); await p.waitForSelector("#result:not([hidden])"); await W(1000);
  await caption(p, "TRACK YOUR APPLICATION", "Each step gets a stamp: <b>Received</b>, <b>In review</b>, <b>Approved</b>, <b>Paid</b>.");
  await W(3800);
  await caption(p, "TRACK YOUR APPLICATION", "If we need something, a note appears here with an upload button. We also message you on WhatsApp.");
  await W(4000);

  // End card
  await p.setContent(card("QuickServe Cashloan", "Fast cash.<br><span>No small print.</span>", "Apply at <b style=\"color:#f8f8f3\">quickserve.group</b>",
    '<div class="foot"><small>QUESTIONS? CALL OR WHATSAPP</small>+264 81 281 9840</div>'));
  await W(4500);

  recording = false; await shooter;
  // ffmpeg concat list: each frame shown until the next one arrived.
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = frames[i + 1] ? frames[i + 1].t : f.t + SLOW;
    lines.push("file '" + f.file + "'", "duration " + Math.max(0.004, (next - f.t) / SLOW).toFixed(5));
  });
  lines.push("file '" + frames[frames.length - 1].file + "'");
  fs.writeFileSync(DIR + "/frames.ffconcat", lines.join("\n") + "\n");
  const secs = (frames[frames.length - 1].t - frames[0].t) / SLOW + 1;
  console.log(frames.length + " frames, " + secs.toFixed(1) + " s of video, " + (frames.length / secs).toFixed(1) + " fps captured");
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
