// Admin console core (admin/index.html) — browser tests.
//
// Serves the repo root with a tiny static server so the console loads at
// /admin/, and stands in for Supabase (auth, RPCs, the ledger row) and the
// intake Worker with page.route. Checks the credit-desk infrastructure against
// docs/credit-desk/CONTRACT.md §2, §4, §5 and §9: role gating (an analyst never
// touches the ledger), the session key and sign-out, whoami, Team, Audit trail,
// Credit policy, My account, the legacy import, CSV hardening, and that the
// QSCredit worksheet maths match tests/fixtures/credit-cases.json to the cent.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/ui/admin-core.test.js

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8");
const SB_URL = (/url:"(https:\/\/[a-z0-9]+\.supabase\.co)"/.exec(SRC) || [])[1];
const WORKER = (/var WORKER_BASE = "([^"]+)"/.exec(SRC) || [])[1];
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "credit-cases.json"), "utf8"));
const NOW = new Date("2026-09-28T10:00:00+02:00");
const SESSION_KEY = "quickserve_admin_session_v1";
const PHONE_KEY = "quickserve_cloud_v1";
const PHONE_VALUE = JSON.stringify({ access_token: "phone-token", email: "erastusmatheus3@gmail.com", cursor: { rev: 41 } });
const NOT_ENABLED = "Your login isn't enabled for the credit desk — ask the owner.";
const APP_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
// Documents the fake Worker serves: a PNG, a PDF, and an HTML file posing as a document.
const DOCS = {
  "0d000000-0000-4000-8000-000000000001": ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
  "0d000000-0000-4000-8000-000000000002": ["application/pdf", Buffer.from("%PDF-1.4\n%fake\n")],
  "0d000000-0000-4000-8000-000000000003": ["text/html; charset=utf-8", Buffer.from("<script>parent.__xss=2</script>")]
};
assert.ok(SB_URL && WORKER, "Supabase URL and WORKER_BASE found in admin/index.html");

// ── people (tokens map to logins; `staff` is what whoami returns) ──────────
const PEOPLE = {
  owner: { email: "erastusmatheus3@gmail.com", password: "owner-pass-123", token: "tok-owner",
    staff: { user_id: "11111111-1111-4111-8111-111111111111", email: "erastusmatheus3@gmail.com", full_name: "Erastus Matheus", role: "owner", active: true } },
  analyst: { email: "tuyeni@quickserve.group", password: "analyst-pass-123", token: "tok-analyst",
    staff: { user_id: "22222222-2222-4222-8222-222222222222", email: "tuyeni@quickserve.group", full_name: "Tuyeni Shikongo", role: "analyst", active: true } },
  stranger: { email: "stranger@example.com", password: "stranger-pass-1", token: "tok-stranger", staff: null },
  former: { email: "former@quickserve.group", password: "former-pass-123", token: "tok-former",
    staff: { user_id: "33333333-3333-4333-8333-333333333333", email: "former@quickserve.group", full_name: "Former Analyst", role: "analyst", active: false } }
};

// ── a small ledger (same shape as the phone app writes) ─────────────────────
const LEDGER = {
  clients: [
    { id: "client_a", ref: "QS-0001", name: "Selma Nangolo", phone: "081 555 0101", nationalId: "86010112345", employer: "Rössing Uranium" },
    { id: "client_b", ref: "QS-0002", name: "Johannes Amutenya", phone: "081 555 0202", nationalId: "90050554321", employer: "NamPower" },
    { id: "client_c", ref: "QS-0003", name: "=HYPERLINK(\"http://evil.example\",\"x\")", phone: "+264 81 555 0303", nationalId: "", employer: "" }
  ],
  loans: [
    { id: "loan_1", clientId: "client_a", principal: 4000, interestRate: 30, serviceFee: 0, issueDate: "2026-09-01", dueDate: "2026-10-01", status: "active", purpose: "School fees" },
    { id: "loan_2", clientId: "client_b", principal: 2000, interestRate: 30, serviceFee: 0, issueDate: "2026-08-01", dueDate: "2026-09-01", status: "active", purpose: "Transport" },
    { id: "loan_3", clientId: "client_a", principal: 1000, interestRate: 30, serviceFee: 0, issueDate: "2026-07-01", dueDate: "2026-08-01", status: "active", purpose: "Groceries" }
  ],
  payments: [
    { id: "payment_1", loanId: "loan_2", amount: 500, date: "2026-09-01", method: "Cash" },
    { id: "payment_2", loanId: "loan_3", amount: 1300, date: "2026-07-30", method: "Bank transfer" }
  ],
  capital: [{ id: "capital_1", direction: "in", amount: 20000, date: "2026-06-01" }],
  expenses: [{ id: "expense_1", date: "2026-09-05", amount: 300, category: "Transport", note: "Fuel" }],
  settings: { currency: "N$" },
  updatedAt: "2026-09-27T08:00:00.000Z"
};
const POLICY = {
  max_share_disposable_pct: 70, default_interest_rate: 30, default_service_fee: 0, cost_cap_pct: 30, max_principal: 100000,
  max_term_months: 5, bureau_required: false, red_flag_threshold: 2, principal_round_step: 50, min_age: 18, max_age: 70,
  sla_pickup_hours: 24, sla_approval_hours: 24, idle_minutes: 20
};
const COUNTS = { open: 9, submitted: 3, in_review: 2, info_requested: 1, awaiting_approval: 2, approved: 1, closed: 14 };

// 203 audit entries, newest first: 200 on the first page, 3 older ones behind "Load older".
function auditRows() {
  const cats = [["application", "app.claimed"], ["decision", "decision.approved"], ["ledger", "ledger.updated"], ["document", "doc.viewed"], ["access", "access.signed_in"]];
  const out = [];
  for (let i = 0; i < 203; i++) {
    const [category, action] = cats[i % cats.length];
    out.push({ id: 1000 - i, at: new Date(NOW.getTime() - (i + 1) * 60000).toISOString(), actor_name: "Tuyeni Shikongo",
      actor_email: "tuyeni@quickserve.group", actor_role: "analyst", action, category, application_ref: category === "application" ? "QSA-7K2M9P" : null,
      detail: action === "ledger.updated" ? { rev_from: 7, rev_to: 8, counts: { clients: 0, loans: 0, payments: 1, expenses: 0, capital: 0 } }
        : action === "decision.approved" ? { principal: 4000, overridden_codes: [], self_assessed: false } : { kind: "payslip", seq: 1, email: "tuyeni@quickserve.group" } });
  }
  // Hostile text in the newest entry: must be escaped on screen and defused in the CSV.
  out[0] = Object.assign({}, out[0], { action: "note.added", category: "application", actor_name: "<img src=x onerror=\"window.__xss=1\">",
    detail: { text: "=HYPERLINK(\"http://evil.example\",\"x\")" } });
  return out;
}

// ── tiny static server for the repo root ────────────────────────────────────
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400).end(); return; }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── fake Supabase + Worker ─────────────────────────────────────────────────
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "apikey,authorization,content-type,prefer,x-client-info" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const qsError = (code, message) => ({ status: 400, body: { code: "P0001", message: code + ": " + message, details: null, hint: null } });

async function fakeBackend(page, opts = {}) {
  const db = {
    staff: [clone(PEOPLE.owner.staff), clone(PEOPLE.analyst.staff)].map((s, i) => Object.assign(s, { created_at: "2026-09-20T08:00:00Z", last_sign_in_at: i ? "2026-09-28T07:02:00Z" : "2026-09-28T09:40:00Z" })),
    policy: clone(POLICY), audit: auditRows(), ledger: { rev: 7, data: clone(LEDGER) }
  };
  const log = { rpc: [], ledger: [], logout: [], userPut: [], refresh: 0, worker: [] };
  const rpcNames = () => log.rpc.map((c) => c.name);

  function rpc(name, params, who) {
    const staff = who && who.staff && who.staff.active ? who.staff : null;
    const owner = staff && staff.role === "owner";
    const deny = qsError("QS_FORBIDDEN", staff ? "Only an owner can do this." : NOT_ENABLED);
    if (opts.rpc && opts.rpc[name]) return opts.rpc[name](params, who, db);
    switch (name) {
      case "whoami": return { status: 200, body: who && who.staff ? clone(who.staff) : null };
      case "staff_role": return { status: 200, body: staff ? staff.role : null };
      case "app_queue": return staff ? { status: 200, body: { counts: COUNTS, rows: [] } } : deny;
      case "policy_get": return staff ? { status: 200, body: db.policy } : deny;
      case "policy_update":
        if (!owner) return deny;
        Object.assign(db.policy, params.p_patch);
        return { status: 200, body: db.policy };
      case "staff_list": return owner ? { status: 200, body: db.staff } : deny;
      case "staff_add": {
        if (!owner) return deny;
        if (params.p_email === "nobody@quickserve.group") return qsError("QS_NOT_FOUND", "No Supabase login exists for nobody@quickserve.group. Create it under Authentication → Users first, then add them here.");
        const row = { user_id: "44444444-4444-4444-8444-444444444444", email: params.p_email, full_name: params.p_full_name, role: params.p_role, active: true, created_at: NOW.toISOString(), last_sign_in_at: null };
        db.staff.push(row);
        return { status: 200, body: row };
      }
      case "staff_set_active": {
        if (!owner) return deny;
        const row = db.staff.find((s) => s.user_id === params.p_user_id);
        if (!row) return qsError("QS_NOT_FOUND", "That person isn't on the team.");
        row.active = params.p_active;
        return { status: 200, body: row };
      }
      case "audit_list": {
        if (!owner) return deny;
        let list = db.audit.filter((r) => !params.p_category || r.category === params.p_category);
        if (params.p_before) list = list.filter((r) => r.at < params.p_before);
        return { status: 200, body: list.slice(0, params.p_limit || 200) };
      }
      default: return { status: 404, body: { code: "PGRST202", message: "Could not find the function public." + name } };
    }
  }

  await page.route((u) => u.href.startsWith(SB_URL + "/"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const auth = (req.headers().authorization || "").replace(/^Bearer /, "");
    const who = Object.values(PEOPLE).find((p) => p.token === auth) || null;
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const reply = (status, json) => route.fulfill({ status, headers: CORS, contentType: "application/json", body: json === undefined ? "" : JSON.stringify(json) });
    assert.equal(req.headers().apikey, "sb_publishable_jy5bMPcZ9uIwXHV2M7Sq0g_5uYtWcZH", "publishable apikey on every Supabase call");

    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "refresh_token") {
        log.refresh += 1;
        const p = Object.values(PEOPLE).find((x) => "r-" + x.token === body.refresh_token);
        return p ? reply(200, { access_token: p.token, refresh_token: "r-" + p.token, expires_in: 3600 }) : reply(400, { error_description: "Invalid Refresh Token" });
      }
      const p = Object.values(PEOPLE).find((x) => x.email === body.email && x.password === body.password);
      if (!p) return reply(400, { error_description: "Invalid login credentials" });
      return reply(200, { access_token: p.token, refresh_token: "r-" + p.token, expires_in: opts.expiresIn || 3600, user: { email: p.email } });
    }
    if (url.pathname === "/auth/v1/logout") { log.logout.push({ token: auth, scope: url.searchParams.get("scope") }); return route.fulfill({ status: 204, headers: CORS }); }
    if (url.pathname === "/auth/v1/user" && method === "PUT") {
      log.userPut.push({ token: auth, body });
      return reply(200, { id: who && who.staff && who.staff.user_id, email: who && who.email });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      log.rpc.push({ name, params: body, token: auth });
      if (!who) return reply(401, { code: "PGRST301", message: "JWT invalid" });
      const r = rpc(name, body || {}, who);
      return reply(r.status, r.body);
    }
    if (url.pathname === "/rest/v1/ledger") {
      log.ledger.push({ method, token: auth, search: url.search, body });
      const owner = who && who.staff && who.staff.active && who.staff.role === "owner";
      if (method === "GET") return reply(200, owner ? [{ data: db.ledger.data, rev: db.ledger.rev }] : []);
      if (method === "PATCH") {
        if (!owner || url.searchParams.get("rev") !== "eq." + db.ledger.rev) return reply(200, []);
        db.ledger = { rev: body.rev, data: body.data };
        return reply(200, [{ data: db.ledger.data, rev: db.ledger.rev }]);
      }
    }
    return reply(404, { message: "not mocked: " + method + " " + url.pathname });
  });

  await page.route((u) => u.href.startsWith(WORKER + "/"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    log.worker.push({ method: req.method(), path: url.pathname, auth: req.headers().authorization || "" });
    if (url.pathname === "/legacy/migrate" && req.method() === "POST") {
      if (req.headers().authorization !== "Bearer old-inbox-password") return route.fulfill({ status: 401, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ imported: 3, skipped: 1 }) });
    }
    const doc = /^\/docs\/([^/]+)$/.exec(url.pathname);
    if (doc && req.method() === "GET") {
      if (!/^Bearer tok-(owner|analyst)$/.test(req.headers().authorization || "")) return route.fulfill({ status: 401, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
      const d = DOCS[doc[1]];
      if (d) return route.fulfill({ status: 200, headers: Object.assign({ "Content-Type": d[0], "X-Content-Type-Options": "nosniff" }, CORS), body: d[1] });
    }
    return route.fulfill({ status: 404, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });

  return { db, log, rpcNames };
}

// ── harness ────────────────────────────────────────────────────────────────
let browser, server, base;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Opens the console with the fake backend. `clock`: "fixed" (default) or "install".
async function openConsole(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "Africa/Windhoek", acceptDownloads: true });
  if (opts.clock === "install") await context.clock.install({ time: NOW });
  else await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.problems = [];
  page.requests = [];
  page.on("pageerror", (e) => page.problems.push("page error: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) page.problems.push("console error: " + m.text());
  });
  page.on("request", (r) => {
    const u = r.url();
    page.requests.push(r.method() + " " + u);
    if (!u.startsWith(base) && !u.startsWith(SB_URL) && !u.startsWith(WORKER) && !u.startsWith("blob:") && !u.startsWith("data:")) page.problems.push("unexpected external request: " + u);
  });
  page.on("dialog", (d) => { (page.dialogs = page.dialogs || []).push(d.message()); d.accept(); });
  const backend = await fakeBackend(page, opts);
  await page.goto(base + "/admin/" + (opts.hash || ""));
  // The phone app's own session lives on this origin too; the console must never touch it.
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PHONE_KEY, PHONE_VALUE]);
  return { context, page, backend };
}
async function signIn(page, who) {
  await page.fill("#email", who.email);
  await page.fill("#password", who.password);
  await page.click("#signInBtn");
}
async function signedIn(page, who) {
  await signIn(page, who);
  await page.waitForFunction(() => window.__admin && window.__admin.me() && window.__admin.route().name);
}
async function closeConsole(page) {
  const problems = page.problems;
  await page.context().close();
  assert.deepEqual(problems, [], "browser reported problems");
}
const visibleNav = (page) => page.$$eval(".navitem", (els) => els.filter((e) => !e.classList.contains("hidden") && e.offsetParent !== null)
  .map((e) => Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
const hash = (page) => page.evaluate(() => location.hash);
async function goHash(page, h) {
  await page.evaluate((x) => { location.hash = x; }, h);
  await page.waitForTimeout(60);
}
const title = (page) => page.locator("#pageTitle").innerText();
const ledgerHits = (page) => page.requests.filter((r) => r.includes("/rest/v1/ledger"));

// ── QSCredit (Node side): the pure block, extracted by its id ──────────────
function creditBlock() {
  const m = /<script id="credit-calc">([\s\S]*?)<\/script>/.exec(SRC);
  assert.ok(m, "<script id=\"credit-calc\"> block present");
  return m[1];
}

test("QSCredit block is pure and matches every fixture to the cent", async () => {
  const code = creditBlock();
  assert.ok(!/document\.|localStorage|fetch\(|XMLHttpRequest/.test(code), "no DOM, storage or network in the maths block");
  // In a bare context it may only add window.QSCredit.
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(code, ctx);
  assert.deepEqual(Object.keys(ctx), ["window"], "no stray globals");
  assert.deepEqual(Object.keys(ctx.window), ["QSCredit"], "only window.QSCredit");

  const win = {};
  new Function("window", code)(win);
  const Q = win.QSCredit;
  for (const c of CASES) assert.deepStrictEqual(Q.compute(c.worksheet, c.terms, c.application, c.policy), c.expected, "fixture " + c.name);

  // The contract §4 example.
  const ex = CASES.find((c) => c.name === "clean_pass");
  const got = Q.compute(ex.worksheet, ex.terms, ex.application, ex.policy);
  assert.equal(got.d4, 7620); assert.equal(got.d6, 5334); assert.equal(got.e7, 5200); assert.equal(got.f3, true); assert.equal(got.f5, 4100);
  assert.deepEqual(got.rules.map((r) => r.code), ["D4", "DOCS", "G1", "G2", "G3", "G4", "G10", "G11", "F3", "G8", "G5", "G6", "G9", "FLAGS", "VERIFY", "G7"]);

  // Garbage in: missing sections count as 0, strings are not numbers (like private.jnum).
  const empty = Q.compute(null, { principal: "4000" }, undefined, {});
  assert.equal(empty.e1, 0); assert.equal(empty.e10, null); assert.deepEqual(empty.hard_fail_codes, ["D4", "DOCS", "G1", "G2", "G3", "G10", "G11"]);

  // Round half away from zero, exactly (floats would get 5.005 wrong).
  assert.equal(Q.r2(5.005), 5.01); assert.equal(Q.r2(-5.005), -5.01); assert.equal(Q.r2(1.004999), 1); assert.equal(Q.r2(0.125), 0.13);
  assert.equal(Q.addMonths("2026-09-30", 5), "2027-02-28"); assert.equal(Q.addMonths("2027-10-31", 4), "2028-02-29");
  assert.equal(Q.daysBetween("2026-09-28", "2026-10-28"), 30); assert.equal(Q.daysBetween("2026-09-28", "nope"), null);

  // Namibian ID: 11 digits, YYMMDD, century from this year's two digits.
  assert.deepEqual(Q.nidCheck("860101 12345", "2026-09-28"), { isNamibian: true, valid: true, dob: "1986-01-01", age: 40 });
  assert.deepEqual(Q.nidCheck("08092912345", "2026-09-28"), { isNamibian: true, valid: true, dob: "2008-09-29", age: 17 });
  assert.deepEqual(Q.nidCheck("08092812345", "2026-09-28"), { isNamibian: true, valid: true, dob: "2008-09-28", age: 18 });
  assert.deepEqual(Q.nidCheck("27010112345", "2026-09-28"), { isNamibian: true, valid: true, dob: "1927-01-01", age: 99 });
  assert.deepEqual(Q.nidCheck("86023012345", "2026-09-28"), { isNamibian: true, valid: false, dob: null, age: null });
  assert.deepEqual(Q.nidCheck("P1234567", "2026-09-28"), { isNamibian: false, valid: false, dob: null, age: null });
});

// ── role gating ────────────────────────────────────────────────────────────
test("analyst: rail is Credit queue + My account; owner routes redirect to #credit; the ledger is never requested", async () => {
  const { page, backend } = await openConsole({ hash: "#loans" });
  // The old inbox (same origin) may have stored its owner password after this page loaded.
  await page.evaluate(() => localStorage.setItem("qs_owner_token", "old-inbox-password"));
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('[data-page="credit"]');
  assert.equal(await page.evaluate(() => localStorage.getItem("qs_owner_token")), null, "an analyst sign-in removes the old inbox password");
  assert.equal(await hash(page), "#credit", "a deep link to #loans lands on the queue");
  assert.deepEqual(await visibleNav(page), ["Credit queue", "My account"]);
  assert.ok(await page.locator(".locknote").isVisible(), "the owner-only note is shown");
  assert.equal(await page.locator("#whoName").innerText(), "Tuyeni Shikongo");
  assert.equal(await page.locator("#whoRole").innerText(), "Credit analyst");
  assert.equal(await page.locator("#badge_credit").innerText(), "9", "queue badge from app_queue counts");

  for (const h of ["#dashboard", "#loans", "#clients", "#payments", "#expenses", "#reports", "#projections", "#settings",
    "#team", "#audit", "#disburse", "#approval/" + APP_ID, "#credit/awaiting_approval/../../dashboard", "#nonsense"]) {
    await goHash(page, h);
    await page.waitForFunction(() => location.hash.indexOf("#credit") === 0);
    assert.equal((await hash(page)).split("/")[0], "#credit", h + " is refused");
    assert.equal(await title(page), "Credit queue");
  }
  // Staff routes stay open to the analyst, with their parameters.
  await goHash(page, "#credit/in_review");
  assert.equal(await page.locator('[data-page="credit"]').getAttribute("data-arg"), "in_review");
  await goHash(page, "#app/" + APP_ID.toUpperCase());
  assert.equal(await hash(page), "#app/" + APP_ID);
  assert.equal(await page.locator('[data-page="app"]').getAttribute("data-arg"), APP_ID);
  await goHash(page, "#worksheet/" + APP_ID);
  assert.equal(await title(page), "Affordability worksheet");
  assert.ok(await page.locator('.navitem[data-route="credit"]').evaluate((e) => e.classList.contains("active")), "worksheet highlights Credit queue");
  await goHash(page, "#app/not-a-uuid");
  await page.waitForFunction(() => location.hash === "#credit");
  await goHash(page, "#account");
  assert.equal(await title(page), "My account");
  assert.match(await page.locator("#content").innerText(), /tuyeni@quickserve\.group/);

  // Refresh and a reload must not touch the ledger either.
  await page.click("#refreshBtn");
  await page.reload();
  await page.waitForFunction(() => window.__admin && window.__admin.me());
  await page.waitForTimeout(150);
  await page.click("#signOutBtn");
  await page.locator("#loginView:not(.hidden)").waitFor();
  await page.waitForFunction(() => document.readyState === "complete");
  assert.deepEqual(backend.log.logout.map((l) => l.token), ["tok-analyst"]);
  assert.deepEqual(ledgerHits(page), [], "no request to /rest/v1/ledger in the whole analyst session");
  assert.deepEqual(backend.log.ledger, []);
  assert.ok(!backend.rpcNames().some((n) => ["staff_list", "audit_list", "policy_update"].includes(n)), "no owner RPCs");
  await closeConsole(page);
});

test("owner: every page opens; dashboard, clients and loans render from the ledger; credit attention items", async () => {
  const { page, backend } = await openConsole();
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#content .card .ledger");
  assert.equal(await hash(page), "#dashboard");
  assert.deepEqual(await visibleNav(page), ["Dashboard", "Credit queue", "Approvals", "Ready to disburse", "Clients", "Loans", "Payments",
    "Expenses", "Reports", "Projections", "Team & access", "Audit trail", "My account", "Settings"]);
  assert.equal(await page.locator(".navitem", { hasText: "Applications" }).count(), 0, "old OWNER_TOKEN tab is gone");
  assert.equal(await page.locator("#whoName").innerText(), "Erastus Matheus");
  assert.equal(await page.locator("#whoRole").innerText(), "Owner · final approver");
  assert.deepEqual([await page.locator("#badge_credit").innerText(), await page.locator("#badge_approvals").innerText(), await page.locator("#badge_disburse").innerText()], ["9", "2", "1"]);

  // Statement of position from the mocked ledger: 20,000 in + 1,800 collected − 7,000 lent − 300 costs.
  const dash = await page.locator("#content").innerText();
  assert.match(dash, /Cash on hand[\s\S]*N\$ 14,500\.00/);
  assert.match(dash, /Out on loan[\s\S]*N\$ 6,000\.00/);
  await page.waitForSelector("text=2 applications");
  const attn = await page.locator(".attn").innerText();
  assert.match(attn, /2 applications\s+awaiting your approval/);
  assert.match(attn, /1 approved loan\s+ready to disburse/);
  assert.match(attn, /1 loan\s+past due/);
  await page.locator(".arow", { hasText: "awaiting your approval" }).click();
  assert.equal(await hash(page), "#credit/awaiting_approval");
  assert.ok(await page.locator('.navitem[data-route="credit/awaiting_approval"]').evaluate((e) => e.classList.contains("active")), "Approvals is highlighted");

  const pages = [["#dashboard", "Dashboard"], ["#credit", "Credit queue"], ["#disburse", "Ready to disburse"], ["#clients", "Clients"], ["#loans", "Loans"],
    ["#payments", "Payments"], ["#expenses", "Expenses"], ["#reports", "Reports"], ["#projections", "Projections"], ["#team", "Team & access"],
    ["#audit", "Audit trail"], ["#account", "My account"], ["#settings", "Settings"], ["#app/" + APP_ID, "Application"],
    ["#worksheet/" + APP_ID, "Affordability worksheet"], ["#approval/" + APP_ID, "Approval"]];
  for (const [h, t] of pages) {
    await goHash(page, h);
    assert.equal(await hash(page), h, h + " is allowed for an owner");
    assert.equal(await title(page), t);
  }
  await goHash(page, "#applications");
  await page.waitForFunction(() => location.hash === "#credit");

  // Existing loan-book pages still work as before.
  await page.click('.navitem[data-route="clients"]');
  assert.equal(await page.locator("#content tbody tr.rowlink").count(), 3);
  assert.match(await page.locator("#content").innerText(), /Johannes Amutenya[\s\S]*Selma Nangolo/, "sorted by name");
  await page.locator("tr.rowlink", { hasText: "Selma Nangolo" }).click();
  await page.waitForSelector("#drawer.open");
  assert.match(await page.locator("#drawerBody").innerText(), /Loans \(2\)/i);
  await page.keyboard.press("Escape");
  await page.click('.navitem[data-route="loans"]');
  assert.equal(await page.locator("#content tbody tr.rowlink").count(), 2, "open loans: one active, one overdue");
  assert.match(await page.locator("#content").innerText(), /overdue/i);
  await page.click('.navitem[data-route="payments"]');
  assert.equal(await page.locator("#content tbody tr").count(), 2);

  // A write still goes through the rev-guarded PATCH.
  await page.click('.navitem[data-route="clients"]');
  await page.click("#newClientBtn");
  await page.fill("#f_name", "Martha Nangolo"); await page.fill("#f_phone", "085 612 3390"); await page.fill("#f_id", "90010154321");
  await page.click("#modalSave");
  await page.waitForSelector("text=Client added.");
  const patch = backend.log.ledger.find((r) => r.method === "PATCH");
  assert.ok(patch, "ledger PATCH sent");
  assert.equal(patch.search, "?id=eq.main&rev=eq.7");
  assert.equal(patch.body.rev, 8);
  assert.equal(patch.body.data.clients.length, 4);
  assert.equal(await page.locator("#content tbody tr.rowlink").count(), 4);
  await closeConsole(page);
});

test("owner dashboard tolerates app_queue failing", async () => {
  const { page } = await openConsole({ rpc: { app_queue: () => ({ status: 404, body: { code: "PGRST202", message: "Could not find the function public.app_queue" } }) } });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector(".attn .arow");
  await page.waitForTimeout(150);
  const attn = await page.locator(".attn").innerText();
  assert.ok(!/awaiting your approval|ready to disburse/.test(attn), "no credit items without counts");
  assert.match(attn, /past due/, "the ledger items still show");
  assert.ok(await page.locator("#badge_credit").evaluate((e) => e.classList.contains("hidden")));
  await closeConsole(page);
});

// ── session ────────────────────────────────────────────────────────────────
test("sign-out calls /auth/v1/logout (this session only) and leaves quickserve_cloud_v1 untouched", async () => {
  const { page, backend } = await openConsole();
  await signedIn(page, PEOPLE.owner);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SESSION_KEY);
  assert.equal(stored.access_token, "tok-owner");
  assert.equal(stored.email, PEOPLE.owner.email);
  assert.ok(stored.refresh_token && stored.expires_at > NOW.getTime() && stored.last_active, "session record shape");
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), PHONE_KEY), PHONE_VALUE, "sign-in leaves the phone key alone");
  // e.g. the old inbox in another tab stored its password while the owner was signed in
  await page.evaluate(() => localStorage.setItem("qs_owner_token", "old-inbox-password"));
  await page.click("#signOutBtn");
  await page.locator("#loginView:not(.hidden)").waitFor();
  await page.waitForFunction(() => document.readyState === "complete");
  assert.deepEqual(backend.log.logout, [{ token: "tok-owner", scope: "local" }]);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY), null, "our session is gone");
  assert.equal(await page.evaluate(() => localStorage.getItem("qs_owner_token")), null, "the old inbox password is gone");
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), PHONE_KEY), PHONE_VALUE, "the phone app's key is untouched");
  assert.ok(await page.locator("#appView").evaluate((e) => e.classList.contains("hidden")));
  await closeConsole(page);
});

test("whoami null or inactive → not-enabled message, signed out, nothing loaded", async () => {
  for (const who of [PEOPLE.stranger, PEOPLE.former]) {
    const { page, backend } = await openConsole({ hash: "#dashboard" });
    await signIn(page, who);
    await page.locator("#loginMsg", { hasText: NOT_ENABLED }).waitFor();
    assert.deepEqual(backend.log.logout.map((l) => l.token), [who.token]);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY), null);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), PHONE_KEY), PHONE_VALUE);
    assert.deepEqual(ledgerHits(page), [], "no ledger request for " + who.email);
    assert.deepEqual(backend.rpcNames(), ["whoami"], "only whoami was asked");
    await closeConsole(page);
  }
});

test("idle 20 minutes signs out; reopening after the idle limit signs out too", async () => {
  const { page, backend } = await openConsole({ clock: "install" });
  await signedIn(page, PEOPLE.analyst);
  await page.clock.fastForward("19:00");
  await page.waitForTimeout(100);
  assert.deepEqual(backend.log.logout, [], "still signed in after 19 minutes");
  await page.clock.fastForward("02:30");
  await page.locator("#loginMsg", { hasText: "20 minutes without activity" }).waitFor();
  assert.equal(backend.log.logout.length, 1);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), PHONE_KEY), PHONE_VALUE);
  await closeConsole(page);

  const second = await openConsole();
  await signedIn(second.page, PEOPLE.analyst);
  await second.page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.last_active = Date.now() - 25 * 60000; localStorage.setItem(k, JSON.stringify(s)); }, SESSION_KEY);
  await second.page.reload();
  await second.page.locator("#loginMsg", { hasText: "20 minutes without activity" }).waitFor();
  assert.equal(second.backend.log.logout.length, 1);
  await closeConsole(second.page);
});

test("an expiring token is refreshed before RPCs; a QS_ error surfaces as {code, message}", async () => {
  const { page, backend } = await openConsole({ expiresIn: 30 });
  await signedIn(page, PEOPLE.analyst);
  assert.ok(backend.log.refresh >= 1, "refresh_token grant used");
  const err = await page.evaluate(() => window.__admin.rpc("staff_list").then(() => null, (e) => ({ code: e.code, message: e.message, status: e.status })));
  assert.deepEqual(err, { code: "QS_FORBIDDEN", message: "Only an owner can do this.", status: 400 });
  const missing = await page.evaluate(() => window.__admin.rpc("no_such_fn").then(() => null, (e) => e.code));
  assert.equal(missing, "NOT_DEPLOYED");
  await closeConsole(page);
});

test("fetchDoc: the user's token goes to the Worker; the blob is re-wrapped with a whitelisted type", async () => {
  const { page, backend } = await openConsole();
  await signedIn(page, PEOPLE.analyst);
  const ids = Object.keys(DOCS);
  const got = await page.evaluate((list) => Promise.all(list.map((id) => window.__admin.fetchDoc(id).then(
    (d) => ({ type: d.type, blobType: d.blob.type, inline: d.inline, blobUrl: d.url.indexOf("blob:") === 0, size: d.blob.size }),
    (e) => ({ code: e.code })))), ids.concat(["0d000000-0000-4000-8000-00000000dead", "../../applications"]));
  assert.deepEqual(got, [
    { type: "image/png", blobType: "image/png", inline: true, blobUrl: true, size: 11 },
    { type: "application/pdf", blobType: "application/pdf", inline: true, blobUrl: true, size: 15 },
    { type: "application/octet-stream", blobType: "application/octet-stream", inline: false, blobUrl: true, size: 31 },
    { code: "QS_NOT_FOUND" },
    { code: "QS_INVALID" }
  ]);
  const docCalls = backend.log.worker.filter((w) => w.path.indexOf("/docs/") === 0);
  assert.equal(docCalls.length, 4, "an invalid id never leaves the page");
  assert.ok(docCalls.every((w) => w.auth === "Bearer tok-analyst"), "the signed-in person's token");
  assert.deepEqual(ledgerHits(page), []);
  await closeConsole(page);
});

// ── owner control pages ────────────────────────────────────────────────────
test("Team: lists people, adds with staff_add, deactivates with staff_set_active", async () => {
  const { page, backend } = await openConsole({ hash: "#team" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#teamPeople tbody tr[data-person]");
  assert.equal(await page.locator("#teamPeople tbody tr").count(), 2);
  assert.match(await page.locator("#pageSub").innerText(), /2 active logins/);
  assert.match(await page.locator('tr[data-person="erastusmatheus3@gmail.com"]').innerText(), /You/);
  assert.equal(await page.locator('tr[data-person="erastusmatheus3@gmail.com"] button').count(), 0, "can't deactivate yourself");
  assert.equal(await page.locator("#permMatrix .pm:not(.h)").count(), 13, "permissions matrix");
  assert.match(await page.locator(".step").first().innerText(), /Add user/);
  await page.waitForSelector("#policyCard .pol");
  assert.match(await page.locator("#policyCard").innerText(), /70%[\s\S]*N\$100,000[\s\S]*5 months[\s\S]*N\/A/);

  // Deactivate the analyst.
  await page.locator('tr[data-person="tuyeni@quickserve.group"] button', { hasText: "Deactivate" }).click();
  await page.waitForSelector('tr[data-person="tuyeni@quickserve.group"] >> text=Reactivate');
  const setActive = backend.log.rpc.find((c) => c.name === "staff_set_active");
  assert.deepEqual(setActive.params, { p_user_id: PEOPLE.analyst.staff.user_id, p_active: false });
  assert.match(page.dialogs[0], /Deactivate Tuyeni Shikongo/);

  // Add: the button waits for a valid email and name; owner role warns.
  assert.ok(await page.locator("#t_add").isDisabled());
  await page.fill("#t_email", "nobody@quickserve.group");
  await page.fill("#t_name", "No Body");
  await page.click("#t_add");
  await page.waitForSelector("#t_err >> text=No Supabase login exists");
  assert.ok(!/QS_NOT_FOUND/.test(await page.locator("#t_err").innerText()), "only the plain-English part is shown");
  await page.selectOption("#t_role", "owner");
  assert.ok(await page.locator("#t_warn").isVisible(), "owner warning");
  await page.selectOption("#t_role", "analyst");
  assert.ok(await page.locator("#t_warn").isHidden());
  await page.fill("#t_email", " Ndapewa@QuickServe.group ");
  await page.fill("#t_name", "Ndapewa <b>Iipinge</b>");
  await page.click("#t_add");
  await page.waitForSelector('tr[data-person="ndapewa@quickserve.group"]');
  const add = backend.log.rpc.filter((c) => c.name === "staff_add").pop();
  assert.deepEqual(add.params, { p_email: "ndapewa@quickserve.group", p_full_name: "Ndapewa <b>Iipinge</b>", p_role: "analyst" });
  assert.equal(await page.locator("#teamPeople b b").count(), 0, "names are escaped");
  assert.match(await page.locator('tr[data-person="ndapewa@quickserve.group"]').innerText(), /Ndapewa <b>Iipinge<\/b>/);
  await closeConsole(page);
});

test("Audit trail: category tabs, Load older with p_before, escaped text, CSV export with formula guard", async () => {
  const { page, backend } = await openConsole({ hash: "#audit" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#auditPanel tbody tr >> nth=199");
  const first = backend.log.rpc.filter((c) => c.name === "audit_list")[0];
  assert.deepEqual(first.params, { p_limit: 200 }, "Everything: no category, no cursor");
  assert.equal(await page.locator("#auditPanel tbody tr").count(), 200);
  assert.match(await page.locator("#pageSub").innerText(), /200 entries shown/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, "hostile actor name not executed");
  assert.equal(await page.locator("#auditPanel img").count(), 0);
  assert.match(await page.locator("#auditPanel tbody tr").first().innerText(), /<img src=x/);

  await page.click("#auditMore");
  await page.waitForSelector("#auditPanel tbody tr >> nth=202");
  const older = backend.log.rpc.filter((c) => c.name === "audit_list")[1];
  assert.equal(older.params.p_before, backend.db.audit[199].at, "p_before = the oldest row shown");
  assert.equal(await page.locator("#auditMore").count(), 0, "everything loaded");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#auditCsv")]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  assert.equal(csv.split("\r\n").length, 204, "header + 203 rows");
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"",""x"")"'), "formula cell defused");

  await page.locator("[data-acat]", { hasText: "Decisions" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#auditPanel tbody tr").length === 41);
  const dec = backend.log.rpc.filter((c) => c.name === "audit_list").pop();
  assert.deepEqual(dec.params, { p_limit: 200, p_category: "decision" });
  assert.match(await page.locator("#auditPanel tbody tr").first().innerText(), /approved[\s\S]*N\$ 4,000\.00/i);
  for (const [tab, cat] of [["Ledger", "ledger"], ["Documents viewed", "document"], ["Access & policy", "access"], ["Applications", "application"]]) {
    await page.locator("[data-acat]", { hasText: tab }).click();
    await page.waitForTimeout(80);
    assert.equal(backend.log.rpc.filter((c) => c.name === "audit_list").pop().params.p_category, cat);
  }
  await closeConsole(page);
});

test("Credit policy (Settings): owner-only edit with validation, sends only the changed keys", async () => {
  const { page, backend } = await openConsole({ hash: "#settings" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#policyCard [data-policy-edit]");
  const tryValue = async (sel, value, error) => {
    await page.evaluate(() => { document.getElementById("f_err").textContent = ""; });
    await page.fill(sel, String(value));
    await page.click("#modalSave");
    await page.waitForSelector("#f_err >> text=" + error);
    await page.fill(sel, sel === "#f_p_d5" ? "70" : sel === "#f_p_cap" ? "30" : sel === "#f_p_max" ? "100000" : "5");
  };
  await page.click("#policyCard [data-policy-edit]");
  await tryValue("#f_p_d5", 20, "between 30% and 100%");
  await tryValue("#f_p_d5", 101, "between 30% and 100%");
  await tryValue("#f_p_cap", 31, "at most 30%");
  await tryValue("#f_p_max", 100001, "at most N$100,000");
  await tryValue("#f_p_term", 6, "1 to 5 whole months");
  assert.ok(!backend.rpcNames().includes("policy_update"), "nothing sent while invalid");
  await page.fill("#f_p_d5", "65");
  await page.click("#modalSave");
  await page.waitForSelector("text=Credit policy updated.");
  const upd = backend.log.rpc.find((c) => c.name === "policy_update");
  assert.deepEqual(upd.params, { p_patch: { max_share_disposable_pct: 65 } });
  await page.waitForSelector("#policyCard .pol >> text=65%");
  await closeConsole(page);
});

test("Settings: legacy import keeps the old inbox password in memory only — never in browser storage", async () => {
  const { page, backend } = await openConsole({ hash: "#settings" });
  // Everything in this origin's browser storage, as one string (anyone at the browser can read it).
  const storage = () => page.evaluate(() => [localStorage, sessionStorage]
    .map((s) => Array.from({ length: s.length }, (_, i) => s.key(i) + "=" + s.getItem(s.key(i))).join("\n")).join("\n"));
  // A copy left behind by the old console's Applications tab is removed as soon as the page loads.
  await page.evaluate(() => localStorage.setItem("qs_owner_token", "old-inbox-password"));
  await page.reload();
  await page.waitForSelector("#loginView:not(.hidden)");
  assert.equal(await page.evaluate(() => localStorage.getItem("qs_owner_token")), null, "a leftover copy is removed on load");
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#legacyBtn");
  await page.click("#legacyBtn");
  await page.waitForSelector("#f_ownerpw");                  // the removed leftover is not used
  assert.match(await page.locator("#modalBody").innerText(), /not saved on this device/);
  await page.fill("#f_ownerpw", "wrong-password");
  await page.click("#modalSave");
  await page.waitForSelector("#f_err >> text=wasn't accepted");
  await page.fill("#f_ownerpw", "old-inbox-password");
  await page.click("#modalSave");
  await page.waitForSelector("#legacyOut >> text=3 applications imported · 1 skipped");
  const after = await storage();
  assert.ok(!after.includes("old-inbox-password") && !after.includes("wrong-password"), "no password in browser storage:\n" + after);
  assert.equal(await page.evaluate(() => localStorage.getItem("qs_owner_token")), null);
  await page.click("#legacyBtn");                            // second run in this session: confirm dialog, no password prompt
  await page.waitForFunction(() => document.querySelector("#legacyBtn") && !document.querySelector("#legacyBtn").disabled);
  await page.waitForTimeout(100);
  assert.equal((page.dialogs || []).filter((m) => /Import the applications from the old inbox now/.test(m)).length, 1);
  assert.ok(!(await page.locator("#modalScrim").evaluate((e) => e.classList.contains("open"))));
  let calls = backend.log.worker.filter((w) => w.path === "/legacy/migrate");
  assert.deepEqual(calls.map((w) => w.auth), ["Bearer wrong-password", "Bearer old-inbox-password", "Bearer old-inbox-password"]);
  // Signing out forgets it: the next sign-in on this browser is asked again.
  await page.click("#signOutBtn");
  await page.locator("#loginView:not(.hidden)").waitFor();
  await page.waitForFunction(() => document.readyState === "complete");
  assert.ok(!(await storage()).includes("old-inbox-password"), "nothing kept after sign-out");
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#legacyBtn");
  await page.click("#legacyBtn");
  await page.waitForSelector("#f_ownerpw");
  await page.click("#modalCancel");
  calls = backend.log.worker.filter((w) => w.path === "/legacy/migrate");
  assert.equal(calls.length, 3, "no import runs without the password after sign-out");
  await closeConsole(page);
});

test("My account: password change validates, then PUTs /auth/v1/user", async () => {
  const { page, backend } = await openConsole({ hash: "#account" });
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector("#a_pw1");
  const card = await page.locator("#content").innerText();
  assert.match(card, /Tuyeni Shikongo[\s\S]*tuyeni@quickserve\.group[\s\S]*Credit analyst/);
  await page.fill("#a_pw1", "short"); await page.fill("#a_pw2", "short"); await page.click("#a_save");
  assert.match(await page.locator("#a_err").innerText(), /at least 10/);
  await page.fill("#a_pw1", "a-long-new-password"); await page.fill("#a_pw2", "a-long-new-passwort"); await page.click("#a_save");
  assert.match(await page.locator("#a_err").innerText(), /don't match/);
  assert.equal(backend.log.userPut.length, 0);
  await page.fill("#a_pw2", "a-long-new-password"); await page.click("#a_save");
  await page.waitForSelector("text=Password changed.");
  assert.deepEqual(backend.log.userPut, [{ token: "tok-analyst", body: { password: "a-long-new-password" } }]);
  await closeConsole(page);
});

// ── hardening ──────────────────────────────────────────────────────────────
test("CSP, no secrets, CSV guard on the loan-book exports, and QSCredit in the page", async () => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(SRC);
  assert.ok(csp, "CSP meta present");
  const dirs = Object.fromEntries(csp[1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
  assert.equal(dirs["default-src"], "'self'");
  assert.equal(dirs["connect-src"], SB_URL + " " + WORKER);
  assert.equal(dirs["img-src"], "'self' blob: data:");
  assert.equal(dirs["font-src"], "data:");
  assert.equal(dirs["style-src"], "'unsafe-inline'");
  assert.equal(dirs["script-src"], "'unsafe-inline'");
  assert.equal(dirs["object-src"], "'none'");
  assert.equal(dirs["base-uri"], "'none'");
  assert.equal(dirs["frame-src"], "blob:");
  assert.ok(SRC.indexOf("Content-Security-Policy") < SRC.indexOf("<script"), "CSP comes before any script");
  assert.ok(!/<script[^>]+src=/i.test(SRC), "no external scripts");
  assert.ok(!/sb_secret|service_role/i.test(SRC), "no secret keys");
  assert.ok(/var SESSION_KEY = "quickserve_admin_session_v1";/.test(SRC), "the console's own session key");
  const phoneKeyLines = SRC.split("\n").filter((l) => l.includes(PHONE_KEY));
  assert.ok(phoneKeyLines.length > 0 && phoneKeyLines.every((l) => /^\s*\/\//.test(l)), "quickserve_cloud_v1 appears only in comments");

  const { page } = await openConsole({ hash: "#settings" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#expClients");
  const cells = await page.evaluate(() => ["=1+1", "+27 81", "-2", "@SUM(A1)", "\t=x", " =x", "Selma", "", 5, -340].map(window.__admin.csvCell));
  assert.deepEqual(cells, ["'=1+1", "'+27 81", "'-2", "'@SUM(A1)", "'\t=x", "' =x", "Selma", "", "5", "-340"]);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#expClients")]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"",""x"")"'), "client name defused");
  assert.ok(csv.includes("'+264 81 555 0303"), "leading + defused");

  const ex = CASES.find((c) => c.name === "clean_pass");
  const got = await page.evaluate((c) => window.QSCredit.compute(c.worksheet, c.terms, c.application, c.policy), ex);
  assert.deepStrictEqual(got, ex.expected, "in-page QSCredit matches the contract example");
  await closeConsole(page);
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
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " admin-core tests passed");
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
