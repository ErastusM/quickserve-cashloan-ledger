// Public apply form (apply.html) — browser tests.
//
// Serves the repo root with a tiny static server, stands in for the intake
// Worker with page.route, fills the form the way an applicant would (with
// real JPEG / PNG / PDF bytes) and checks exactly what goes over the wire
// against docs/credit-desk/CONTRACT.md §8, plus the error handling.
// The page clock is fixed to 28 Sep 2026 07:02 Windhoek so ages and date
// limits never drift.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/ui/apply.test.js

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const PAGE_SRC = fs.readFileSync(path.join(ROOT, "apply.html"), "utf8");
const ENDPOINT = (/const ENDPOINT = "([^"]*)";/.exec(PAGE_SRC) || [])[1];
const NOW = new Date("2026-09-28T07:02:00+02:00");
const REF = "QSA-7K2M9P";

// Contract §8 form field names, read from the contract itself so the two
// can never drift apart silently.
const CONTRACT_FIELDS = (() => {
  const md = fs.readFileSync(path.join(ROOT, "docs", "credit-desk", "CONTRACT.md"), "utf8");
  const line = md.split("\n").find((l) => l.includes("fullName→full_name"));
  assert.ok(line, "contract §8 field line not found");
  return line.replace(/`/g, "").replace(/\.\s*$/, "").split(",").map((s) => s.trim().split("→")[0].split(" ")[0]).filter(Boolean);
})();
// Sent on top of the contract list: the honeypot and the two old-Worker fields.
const EXTRA_FIELDS = ["website", "consent", "income"];

// ── test documents (real magic bytes; the form sniffs them like the Worker) ─
const bytes = (head, n, fill = 0x20) => Buffer.concat([Buffer.from(head), Buffer.alloc(n, fill)]);
const jpeg = (name, n = 3000) => ({ name, mimeType: "image/jpeg", buffer: bytes([0xff, 0xd8, 0xff, 0xe0], n, 7) });
const png = (name, n = 3000) => ({ name, mimeType: "image/png", buffer: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], n, 9) });
const pdf = (name, n = 3000) => ({ name, mimeType: "application/pdf", buffer: bytes("%PDF-1.4\n", n) });

// ── tiny static server for the repo root ────────────────────────────────────
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".pdf": "application/pdf" };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400).end(); return; }
    const file = path.normalize(path.join(ROOT, rel === "/" ? "apply.html" : rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── multipart/form-data parser (enough for what browsers send) ──────────────
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  assert.ok(m, "no multipart boundary in " + contentType);
  const delim = Buffer.from("--" + (m[1] || m[2]));
  const parts = [];
  let pos = body.indexOf(delim);
  assert.notEqual(pos, -1, "multipart body has no boundary");
  for (;;) {
    pos += delim.length;
    if (body.subarray(pos, pos + 2).toString() === "--") break;
    pos += 2;
    const headEnd = body.indexOf("\r\n\r\n", pos);
    const head = body.subarray(pos, headEnd).toString("utf8");
    const next = body.indexOf(delim, headEnd + 4);
    assert.notEqual(next, -1, "unterminated multipart part");
    const disp = /content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(head);
    assert.ok(disp, "part without a form-data name: " + head);
    const type = /content-type:\s*([^\r\n]+)/i.exec(head);
    parts.push({ name: disp[1], filename: disp[2], type: type ? type[1] : null, data: body.subarray(headEnd + 4, next - 2) });
    pos = next;
  }
  return parts;
}
function fieldsOf(parts) {
  const out = {};
  for (const p of parts.filter((x) => x.filename === undefined)) {
    assert.ok(!(p.name in out), "field sent twice: " + p.name);
    out[p.name] = p.data.toString("utf8");
  }
  return out;
}
const filesOf = (parts, name) => parts.filter((p) => p.name === name && p.filename !== undefined);

// ── harness ────────────────────────────────────────────────────────────────
let browser, server, base;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function openForm() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.problems = [];
  page.on("pageerror", (e) => page.problems.push("page error: " + e.message));
  // Chrome logs every non-2xx reply as "Failed to load resource"; those are expected here.
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) page.problems.push("console error: " + m.text());
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(base) && u !== ENDPOINT) page.problems.push("unexpected external request: " + u);
  });
  await page.goto(base + "/apply.html");
  return page;
}
async function closeForm(page) {
  const problems = page.problems;
  await page.context().close();
  assert.deepEqual(problems, [], "browser reported problems");
}

// Stand-in for the Worker. `respond(call, n)` returns {status, body} or "abort".
async function fakeWorker(page, respond) {
  const calls = [];
  await page.route((u) => u.href === ENDPOINT, async (route) => {
    const req = route.request();
    const call = { method: req.method(), contentType: req.headers()["content-type"], body: req.postDataBuffer() };
    calls.push(call);
    const r = typeof respond === "function" ? await respond(call, calls.length) : respond;
    if (r === "abort") return route.abort("failed");
    return route.fulfill({ status: r.status, contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(r.body) });
  });
  return calls;
}

const text = (page, sel) => page.locator(sel).innerText();
// The page marks the slot aria-busy (synchronously, in the change event)
// while it sniffs the picked files; wait for that to finish.
async function addFiles(page, slot, list) {
  await page.setInputFiles("#" + slot, list);
  await page.waitForFunction((s) => document.getElementById(s + "-slot").getAttribute("aria-busy") !== "true", slot);
}

// A complete, valid application (the design's example applicant).
async function fillValid(page) {
  await page.fill("#amountRequested", "4000");
  await page.fill("#repayDate", "2026-10-28");
  await page.fill("#purpose", "School fees");
  await page.fill("#fullName", "Selma Nangolo");
  await page.fill("#nationalId", "89031200457");
  await page.fill("#phone", "+264 81 234 5678");
  await page.fill("#email", "selma@example.com");
  await page.fill("#address", "14 Moses Garoeb St, Mondesa");
  await page.selectOption("#town", "Swakopmund");
  await page.fill("#dependants", "2");
  await page.fill("#employer", "Rössing Uranium");
  await page.fill("#jobTitle", "Plant operator");
  await page.selectOption("#employmentType", "Permanent");
  await page.selectOption("#payDay", "25th");
  await page.selectOption("#bankName", "FNB Namibia");
  await page.fill("#bankAccountHolder", "Selma Nangolo");
  await page.fill("#bankAccountNo", "62 1044 4471");
  await page.click('label[for="salaryIntoAccount-yes"]');
  await page.fill("#declaredIncome", "18,400");
  await page.fill("#declaredDeductions", "1,500");
  await page.fill("#declaredExpenses", "9,000");
  await page.click('label[for="otherLenderLoans-yes"]');
  await page.fill("#otherLenderCount", "1");
  await page.fill("#kinName", "Martha Nangolo");
  await page.fill("#kinRelationship", "Mother");
  await page.fill("#kinPhone", "+264 85 612 3390");
  await addFiles(page, "docId", [jpeg("id-front.jpg")]);
  await addFiles(page, "docPayslip", [pdf("payslip-aug.pdf")]);
  await addFiles(page, "docBank", [pdf("statement-jul.pdf")]);
  await addFiles(page, "docBank", [pdf("statement-aug.pdf"), png("statement-sep.png")]);
  await addFiles(page, "docAddress", [jpeg("water-bill.jpg", 1500)]);
  await page.check("#consentProcessing");
  await page.check("#consentBureau");
}
const VALID_FIELDS = {
  fullName: "Selma Nangolo", nationalId: "89031200457", dateOfBirth: "1989-03-12", phone: "+264 81 234 5678",
  email: "selma@example.com", address: "14 Moses Garoeb St, Mondesa", town: "Swakopmund", dependants: "2",
  employer: "Rössing Uranium", jobTitle: "Plant operator", employmentType: "Permanent", payDay: "25th",
  bankName: "FNB Namibia", bankAccountHolder: "Selma Nangolo", bankAccountNo: "62 1044 4471", salaryIntoAccount: "yes",
  kinName: "Martha Nangolo", kinRelationship: "Mother", kinPhone: "+264 85 612 3390",
  amountRequested: "4000", repayDate: "2026-10-28", purpose: "School fees",
  declaredIncome: "18400", declaredDeductions: "1500", declaredExpenses: "9000",
  otherLenderLoans: "yes", otherLenderCount: "1",
  consentProcessing: "yes", consentBureau: "yes", consentVersion: "2026-10-v1",
  website: "", consent: "yes", income: "18400"
};

// ── tests ──────────────────────────────────────────────────────────────────

test("contract field list is what the test expects", async () => {
  assert.equal(ENDPOINT, "https://quickserve-intake.quickservefinance.workers.dev/applications");
  assert.equal(CONTRACT_FIELDS.length, 30, "contract §8 lists 30 form fields: " + CONTRACT_FIELDS.join(","));
  assert.deepEqual(Object.keys(VALID_FIELDS).sort(), [...CONTRACT_FIELDS, ...EXTRA_FIELDS].sort());
});

test("happy path: every multipart field and file matches contract §8; success screen shows the reference", async () => {
  const page = await openForm();
  let whileSending = null;
  const calls = await fakeWorker(page, async () => {
    whileSending = await page.evaluate(() => {
      const b = document.getElementById("submitBtn");
      return { disabled: b.disabled, label: b.textContent, busy: document.getElementById("applyForm").getAttribute("aria-busy") };
    });
    return { status: 201, body: { ok: true, reference: REF } };
  });

  // Live bits before sending.
  assert.equal(await text(page, "#estimate"), "Enter an amount to see an estimate.");
  assert.equal(await page.getAttribute("#repayDate", "min"), "2026-09-29");
  assert.equal(await page.getAttribute("#repayDate", "max"), "2027-02-28");
  await fillValid(page);
  assert.equal(await text(page, "#estimate"),
    "Estimate: you would repay about N$5,200 (30% once-off). Your exact quotation comes before you sign anything.");
  assert.match(await text(page, "#nationalId-note"), /^Born 12 Mar 1989 · age 37/);
  assert.equal(await page.isVisible("#dateOfBirth"), false, "date of birth comes from a Namibian ID");
  assert.match(await text(page, "#docBank-m"), /^3 files added/);
  assert.equal(await page.locator("#docBank-slot.ok").count(), 1);
  assert.equal(await page.inputValue("#website"), "", "honeypot starts empty");

  await page.click("#submitBtn");
  await page.waitForSelector("#done", { state: "visible" });

  assert.equal(calls.length, 1);
  assert.deepEqual(whileSending, { disabled: true, label: "Sending…", busy: "true" });
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.match(call.contentType, /^multipart\/form-data; boundary=/);
  const parts = parseMultipart(call.body, call.contentType);
  assert.deepEqual(fieldsOf(parts), VALID_FIELDS);
  for (const name of CONTRACT_FIELDS) assert.ok(name in fieldsOf(parts), "missing contract field " + name);
  assert.equal(fieldsOf(parts).website, "", "honeypot must be sent empty");

  const fileNames = (name) => filesOf(parts, name).map((p) => p.filename);
  assert.deepEqual(fileNames("docId"), ["id-front.jpg"]);
  assert.deepEqual(fileNames("docPayslip"), ["payslip-aug.pdf"]);
  assert.deepEqual(fileNames("docBank"), ["statement-jul.pdf", "statement-aug.pdf", "statement-sep.png"]);
  assert.deepEqual(fileNames("docAddress"), ["water-bill.jpg"]);
  assert.ok(filesOf(parts, "docId")[0].data.equals(jpeg("x").buffer), "ID file bytes arrive intact");
  assert.ok(filesOf(parts, "docBank")[2].data.equals(png("x").buffer), "bank file bytes arrive intact");
  const names = new Set(parts.map((p) => p.name));
  assert.deepEqual([...names].sort(), [...CONTRACT_FIELDS, ...EXTRA_FIELDS, "docId", "docPayslip", "docBank", "docAddress"].sort(),
    "no field outside the contract (+ honeypot and old-Worker fields) is sent");

  // Success screen.
  assert.equal(await text(page, "#refNo"), REF);
  assert.equal(await text(page, "#doneThanks"), "Thank you, Selma. Keep this reference — screenshot this page.");
  assert.equal(await text(page, "#doneWhen"), "Received Mon 28 Sep 2026, 07:02");
  assert.equal(await page.isVisible("#applyForm"), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "doneTitle");
  await closeForm(page);
});

test("passport applicant, No answers, 'Other' choices and decimal comma are sent correctly", async () => {
  const page = await openForm();
  const calls = await fakeWorker(page, { status: 201, body: { ok: true, reference: "QSA-ABCDEF" } });
  await fillValid(page);
  await page.fill("#nationalId", "P1234567");
  assert.match(await text(page, "#nationalId-note"), /^Passport number — that is fine/);
  assert.equal(await page.isVisible("#dateOfBirth"), true, "passport holders can add a date of birth");
  await page.fill("#dateOfBirth", "1990-05-01");
  assert.match(await text(page, "#dateOfBirth-note"), /^Born 1 May 1990 · age 36/);
  await page.fill("#email", "");
  await page.selectOption("#town", "Other");
  await page.fill("#townOther", "Windhoek");
  await page.selectOption("#payDay", "Other");
  await page.fill("#payDayOther", "28th");
  await page.selectOption("#bankName", "Other");
  await page.fill("#bankNameOther", "Letshego Bank");
  await page.click('label[for="salaryIntoAccount-no"]');
  await page.click('label[for="otherLenderLoans-no"]');
  assert.equal(await page.isVisible("#otherLenderCount"), false);
  await page.fill("#amountRequested", "2500,50");
  await page.uncheck("#consentBureau");
  await page.click("#docAddress-list .rm");
  await page.click("#submitBtn");
  await page.waitForSelector("#done", { state: "visible" });

  const parts = parseMultipart(calls[0].body, calls[0].contentType);
  const f = fieldsOf(parts);
  assert.deepEqual(
    { nationalId: f.nationalId, dateOfBirth: f.dateOfBirth, email: f.email, town: f.town, payDay: f.payDay, bankName: f.bankName,
      salaryIntoAccount: f.salaryIntoAccount, otherLenderLoans: f.otherLenderLoans, otherLenderCount: f.otherLenderCount,
      amountRequested: f.amountRequested, consentProcessing: f.consentProcessing, consentBureau: f.consentBureau, consent: f.consent },
    { nationalId: "P1234567", dateOfBirth: "1990-05-01", email: "", town: "Windhoek", payDay: "28th", bankName: "Letshego Bank",
      salaryIntoAccount: "no", otherLenderLoans: "no", otherLenderCount: "0",
      amountRequested: "2500.50", consentProcessing: "yes", consentBureau: "no", consent: "yes" });
  assert.equal(filesOf(parts, "docAddress").length, 0, "no proof of address → no docAddress part");
  assert.equal(await text(page, "#refNo"), "QSA-ABCDEF");
  await closeForm(page);
});

test("empty form: inline errors linked by aria-describedby, focus on the first, nothing sent", async () => {
  const page = await openForm();
  const calls = await fakeWorker(page, { status: 201, body: { ok: true, reference: REF } });
  await page.click("#submitBtn");
  assert.equal(calls.length, 0, "nothing is sent while the form has problems");
  assert.match(await text(page, "#formAlert"), /^Please check \d+ items\./);
  assert.equal(await page.evaluate(() => document.activeElement.id), "amountRequested");

  const required = ["amountRequested", "repayDate", "purpose", "fullName", "nationalId", "phone", "address", "town",
    "dependants", "employer", "jobTitle", "employmentType", "payDay", "bankName", "bankAccountHolder", "bankAccountNo",
    "declaredIncome", "declaredDeductions", "declaredExpenses", "kinName", "kinRelationship", "kinPhone",
    "docId", "docPayslip", "docBank", "consentProcessing"];
  for (const id of required) {
    const el = page.locator("#" + id);
    assert.equal(await el.getAttribute("aria-invalid"), "true", id + " should be marked invalid");
    assert.ok((await el.getAttribute("aria-describedby")).split(" ").includes(id + "-err"), id + " error is linked");
    assert.ok((await text(page, "#" + id + "-err")).length > 10, id + " has a message");
  }
  for (const group of ["salaryIntoAccount", "otherLenderLoans"]) {
    for (const r of ["yes", "no"]) {
      assert.ok((await page.getAttribute("#" + group + "-" + r, "aria-describedby")).includes(group + "-err"));
    }
    assert.equal(await text(page, "#" + group + "-err"), "Please choose Yes or No.");
  }
  // Optional ones stay quiet.
  for (const id of ["email", "consentBureau", "docAddress"]) {
    assert.equal(await page.getAttribute("#" + id, "aria-invalid"), null, id + " is optional");
  }
  // Fixing a field clears its message straight away.
  await page.fill("#fullName", "Selma Nangolo");
  assert.equal(await page.getAttribute("#fullName", "aria-invalid"), null);
  assert.equal(await page.getAttribute("#fullName", "aria-describedby"), null);
  assert.equal(await text(page, "#fullName-err"), "");
  // The summary links jump to the field.
  await page.click("#formAlert a[href='#docId']");
  assert.equal(await page.evaluate(() => document.activeElement.id), "docId");
  await closeForm(page);
});

test("field rules: amount cap, repay date window, phone, email, counts", async () => {
  const page = await openForm();
  await fakeWorker(page, { status: 201, body: { ok: true, reference: REF } });
  await fillValid(page);
  const errAfter = async (id, value) => {
    await page.fill("#" + id, value);
    await page.locator("#" + id).blur();
    return text(page, "#" + id + "-err");
  };
  assert.equal(await errAfter("amountRequested", "150000"), "The most we can lend is N$100,000.");
  assert.equal(await text(page, "#estimate"), "The most we can lend is N$100,000.");
  assert.equal(await errAfter("amountRequested", "0"), "Please enter an amount of at least N$1.");
  assert.equal(await errAfter("amountRequested", "abc"), "Please enter the amount in numbers only, for example 4000.");
  assert.equal(await errAfter("amountRequested", "100 000"), "");
  assert.equal(await errAfter("repayDate", "2026-09-28"), "Please choose a date after today.");
  assert.equal(await errAfter("repayDate", "2027-03-01"), "Please choose a date no later than 28 Feb 2027 — at most 5 months away.");
  assert.equal(await errAfter("repayDate", "2027-02-28"), "");
  assert.match(await errAfter("phone", "12"), /^Please enter a phone number we can reach/);
  assert.equal(await errAfter("phone", "081 234 5678"), "");
  assert.equal(await errAfter("email", "selma@"), "Please check your email address, or leave it empty.");
  assert.equal(await errAfter("email", ""), "");
  assert.equal(await errAfter("dependants", "99"), "Please enter a number from 0 to 50.");
  assert.equal(await errAfter("dependants", "0"), "");
  assert.equal(await errAfter("otherLenderCount", "0"), "Please enter a number from 1 to 50.");
  assert.match(await errAfter("bankAccountNo", "62#1044"), /^Please check the account number/);
  await closeForm(page);
});

test("ID check is soft: warns on age and bad dates, never blocks", async () => {
  const page = await openForm();
  const calls = await fakeWorker(page, { status: 201, body: { ok: true, reference: REF } });
  await fillValid(page);
  const note = async (v) => { await page.fill("#nationalId", v); return text(page, "#nationalId-note"); };
  assert.equal(await note(""), "Using a passport? That is fine — enter its number.");
  assert.equal(await note("8903120045"), "A Namibian ID has 11 digits. Using a passport? That is fine.");
  assert.equal(await note("89131200457"), "The first 6 digits should be your date of birth — please check.");
  assert.equal(await note("89023000457"), "The first 6 digits should be your date of birth — please check.");
  assert.equal(await note("44010100001"), "Born 1 Jan 1944 · age 82 — we lend to people aged 18 to 70.");
  assert.equal(await note("26010100001"), "Born 1 Jan 2026 — you must be 18 or older.");
  assert.equal(await note("27010100001"), "Born 1 Jan 1927 · age 99 — we lend to people aged 18 to 70.", "YY after this year → 19xx");
  assert.equal(await note("10010100001"), "Born 1 Jan 2010 — you must be 18 or older.");
  assert.equal(await page.getAttribute("#nationalId-note", "class"), "note warn");
  assert.equal(await page.getAttribute("#nationalId", "aria-invalid"), null, "an age warning is not an error");
  await page.click("#submitBtn");
  await page.waitForSelector("#done", { state: "visible" });
  const f = fieldsOf(parseMultipart(calls[0].body, calls[0].contentType));
  assert.equal(f.nationalId, "10010100001");
  assert.equal(f.dateOfBirth, "2010-01-01");
  await closeForm(page);
});

test("documents: type sniffed, 10 MB per file, 40 MB in total, 6 bank files", async () => {
  const page = await openForm();
  await addFiles(page, "docId", [{ name: "id.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html><script>alert(1)</script></html>") }]);
  assert.match(await text(page, "#docId-err"), /“id\.jpg” isn't a photo or PDF we can open/);
  assert.equal(await page.locator("#docId-list li").count(), 0);
  assert.equal(await page.getAttribute("#docId", "aria-invalid"), "true");

  await addFiles(page, "docId", [jpeg("big.jpg", 10 * 1024 * 1024)]);
  assert.match(await text(page, "#docId-err"), /Each file must be 10 MB or smaller/);
  assert.equal(await page.locator("#docId-list li").count(), 0);

  await addFiles(page, "docId", [jpeg("id.jpg")]);
  assert.equal(await text(page, "#docId-err"), "");
  assert.equal(await page.getAttribute("#docId", "aria-invalid"), null);
  assert.equal(await text(page, "#docId-pick"), "Change");

  const seven = Array.from({ length: 7 }, (_, i) => pdf("st-" + (i + 1) + ".pdf", 100));
  await addFiles(page, "docBank", seven);
  assert.equal(await page.locator("#docBank-list li").count(), 6);
  assert.match(await text(page, "#docBank-err"), /up to 6 files here — “st-7\.pdf” was not added/);
  assert.equal(await page.isVisible("#docBank-pick"), false, "no Add button once 6 are in");
  await page.click("#docBank-list li:first-child .rm");
  assert.equal(await page.locator("#docBank-list li").count(), 5);
  assert.equal(await text(page, "#docBank-pick"), "Add more");

  // 40 MB in total: 4 × 9.5 MB fit, the next 3 MB does not. Big files go
  // in as temp files (by path), which is much faster than buffers.
  while (await page.locator("#docBank-list li").count()) await page.click("#docBank-list li:first-child .rm");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qs-apply-"));
  try {
    const onDisk = (f) => { const p = path.join(tmp, f.name); fs.writeFileSync(p, f.buffer); return p; };
    const big = Math.round(9.5 * 1024 * 1024);
    await addFiles(page, "docId", [onDisk(jpeg("id-big.jpg", big))]);
    await addFiles(page, "docPayslip", [onDisk(pdf("pay.pdf", big))]);
    await addFiles(page, "docBank", [onDisk(pdf("b1.pdf", big)), onDisk(pdf("b2.pdf", big))]);
    assert.equal(await page.locator("#docBank-list li").count(), 2);
    assert.match(await text(page, "#docs-total"), /Now 38\.0 MB of 40 MB\./);
    await addFiles(page, "docAddress", [onDisk(pdf("bill.pdf", 3 * 1024 * 1024))]);
    assert.match(await text(page, "#docAddress-err"), /All documents together must be 40 MB or less/);
    assert.equal(await page.locator("#docAddress-list li").count(), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await closeForm(page);
});

test("415 from the Worker: friendly message on the file, typed data kept, resend works", async () => {
  const page = await openForm();
  const calls = await fakeWorker(page, (call, n) => (n === 1
    ? { status: 415, body: { error: "unsupported_type", fields: ["docBank"] } }
    : { status: 201, body: { ok: true, reference: REF } }));
  await fillValid(page);
  await page.click("#submitBtn");
  await page.waitForFunction(() => document.getElementById("formAlert").textContent !== "");
  assert.match(await text(page, "#formAlert"), /One of your documents isn't a photo or PDF we can open\./);
  assert.match(await text(page, "#formAlert"), /Your details are still here/);
  assert.equal(await text(page, "#docBank-err"), "Please replace this with a JPG, PNG or HEIC photo, or a PDF.");
  assert.equal(await page.getAttribute("#docBank", "aria-invalid"), "true");
  assert.equal(await page.isVisible("#done"), false);
  assert.equal(await page.isDisabled("#submitBtn"), false);
  assert.equal(await text(page, "#submitBtn"), "Send application");
  assert.equal(await page.inputValue("#fullName"), "Selma Nangolo");
  assert.equal(await page.inputValue("#amountRequested"), "4000");
  assert.equal(await page.locator("#docBank-list li").count(), 3);

  await page.click("#submitBtn");
  await page.waitForSelector("#done", { state: "visible" });
  assert.equal(calls.length, 2);
  const parts = parseMultipart(calls[1].body, calls[1].contentType);
  assert.deepEqual(fieldsOf(parts), VALID_FIELDS, "the resend carries everything again");
  assert.equal(filesOf(parts, "docBank").length, 3);
  await closeForm(page);
});

test("429 from the Worker: rate-limit message, nothing lost", async () => {
  const page = await openForm();
  await fakeWorker(page, { status: 429, body: { error: "rate_limited" } });
  await fillValid(page);
  await page.click("#submitBtn");
  await page.waitForFunction(() => document.getElementById("formAlert").textContent !== "");
  const msg = await text(page, "#formAlert");
  assert.match(msg, /already received several applications from this internet connection/);
  assert.match(msg, /Please wait an hour and try again, or WhatsApp us on \+264 81 264 6222/);
  assert.equal(await page.getAttribute("#formAlert a", "href"), "https://wa.me/264812646222");
  assert.equal(await page.evaluate(() => document.activeElement.id), "formAlert");
  assert.equal(await page.inputValue("#kinPhone"), "+264 85 612 3390");
  assert.equal(await page.isDisabled("#submitBtn"), false);
  await closeForm(page);
});

test("400 with fields: the named fields are marked and focused", async () => {
  const page = await openForm();
  await fakeWorker(page, { status: 400, body: { error: "invalid", fields: ["phone", "amountRequested", "consentVersion"] } });
  await fillValid(page);
  await page.click("#submitBtn");
  await page.waitForFunction(() => document.getElementById("formAlert").textContent !== "");
  assert.match(await text(page, "#formAlert"), /^Some details need checking\./);
  for (const id of ["phone", "amountRequested"]) {
    assert.equal(await page.getAttribute("#" + id, "aria-invalid"), "true");
    assert.equal(await text(page, "#" + id + "-err"), "Please check this — it wasn't accepted.");
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), "amountRequested");
  await closeForm(page);
});

test("413, 500 and network errors: clear messages, button re-enabled", async () => {
  const cases = [
    [{ status: 413, body: { error: "too_large", fields: ["documents"] } }, /^Your documents are too large to send\./],
    [{ status: 500, body: { error: "server_error" } }, /^Sorry — something went wrong on our side and your application was not sent\./],
    ["abort", /^We couldn't reach QuickServe\./]
  ];
  for (const [reply, re] of cases) {
    const page = await openForm();
    await fakeWorker(page, reply);
    await fillValid(page);
    await page.click("#submitBtn");
    await page.waitForFunction(() => document.getElementById("formAlert").textContent !== "");
    assert.match(await text(page, "#formAlert"), re);
    assert.equal(await page.isDisabled("#submitBtn"), false);
    assert.equal(await page.inputValue("#purpose"), "School fees");
    if (reply.status === 413) assert.match(await text(page, "#documents-err"), /too large/);
    await closeForm(page);
  }
});

test("accessibility basics: labels, 16px inputs, 44px targets, honeypot hidden from people", async () => {
  const page = await openForm();
  await page.selectOption("#town", "Other");
  await page.click('label[for="otherLenderLoans-yes"]');
  await addFiles(page, "docBank", [pdf("s.pdf")]);
  const report = await page.evaluate(() => {
    const out = { unlabeled: [], small: [], tiny: [] };
    const visible = (el) => !el.closest("[hidden]") && !el.closest(".hp");
    for (const el of document.querySelectorAll("#applyForm input:not([type=hidden]), #applyForm select")) {
      if (!visible(el)) continue;
      const named = (el.labels && el.labels.length) || el.getAttribute("aria-labelledby");
      if (!named) out.unlabeled.push(el.id);
      if (el.type !== "radio" && el.type !== "checkbox" && el.type !== "file" && parseFloat(getComputedStyle(el).fontSize) < 16) out.small.push(el.id);
    }
    const targets = document.querySelectorAll("#applyForm button, .yn label, .pick, .cb, #applyForm .f, #applyForm select");
    for (const el of targets) {
      if (!visible(el) || el.hidden) continue;
      if (el.getBoundingClientRect().height < 44) out.tiny.push(el.id || el.className || el.tagName);
    }
    const hp = document.getElementById("website"), r = hp.getBoundingClientRect();
    out.honeypot = { name: hp.name, tabindex: hp.getAttribute("tabindex"), autocomplete: hp.getAttribute("autocomplete"),
      ariaHidden: hp.getAttribute("aria-hidden"), onScreen: r.right > 0 && r.bottom > 0 && r.width > 1 };
    out.hidden = { consentVersion: document.getElementById("consentVersion").type, value: document.getElementById("consentVersion").value };
    out.scrollX = document.documentElement.scrollWidth > window.innerWidth;
    return out;
  });
  assert.deepEqual(report.unlabeled, [], "every control has a label");
  assert.deepEqual(report.small, [], "inputs are 16px (no iOS zoom)");
  assert.deepEqual(report.tiny, [], "touch targets are at least 44px tall");
  assert.deepEqual(report.honeypot, { name: "website", tabindex: "-1", autocomplete: "off", ariaHidden: "true", onScreen: false });
  assert.deepEqual(report.hidden, { consentVersion: "hidden", value: "2026-10-v1" });
  assert.equal(report.scrollX, false, "no sideways scrolling on a 390px phone");

  // Keyboard focus is visible on the drawn yes/no buttons and file buttons.
  const ringAfterTab = async (from, shift) => {
    await page.focus(from);
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    return page.evaluate(() => {
      const el = document.activeElement;
      const label = document.querySelector('label[for="' + el.id + '"]');
      return { id: el.id, outline: getComputedStyle(label).outlineStyle };
    });
  };
  const yn = await ringAfterTab("#declaredIncome", true);
  assert.match(yn.id, /^salaryIntoAccount-(yes|no)$/);
  assert.equal(yn.outline, "solid", "focused yes/no shows an outline");
  const file = await ringAfterTab("#docId", false);
  assert.equal(file.id, "docPayslip");
  assert.equal(file.outline, "solid", "focused file picker shows an outline");
  await closeForm(page);
});

test("page loads nothing from other sites and ships a CSP", async () => {
  assert.ok(!/<script[^>]+src=/i.test(PAGE_SRC), "no external scripts");
  assert.ok(!/fonts\.googleapis|<link[^>]+stylesheet/i.test(PAGE_SRC), "no external fonts or stylesheets");
  assert.ok(!/sb_secret|service_role/i.test(PAGE_SRC), "no secret keys");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(PAGE_SRC);
  assert.ok(csp && csp[1].includes("connect-src " + new URL(ENDPOINT).origin), "CSP allows exactly the Worker");
  assert.ok(!/\balert\(/.test(PAGE_SRC.replace(/role="alert"/g, "")), "no alert() pop-ups");
});

// ── run ────────────────────────────────────────────────────────────────────
(async () => {
  server = await startServer();
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      console.log("ok   - " + t.name + " (" + (Date.now() - started) + " ms)");
    } catch (err) {
      failed += 1;
      console.log("FAIL - " + t.name);
      console.log(String((err && err.stack) || err).split("\n").map((l) => "       " + l).join("\n"));
    }
  }
  await browser.close();
  server.close();
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " apply-form tests passed");
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
