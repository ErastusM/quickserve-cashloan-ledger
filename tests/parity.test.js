// Integration parity: the credit desk against the phone app's own code.
//
// The phone app (app.js), the database (supabase/migrations/004_credit.sql) and
// the console's worksheet maths (admin/index.html <script id="credit-calc">)
// all do money maths on the same loan book. This test runs the REAL migrations
// on a throwaway Postgres (tests/sql/pg.js), drives applications end to end
// through the RPCs as the right people (website → analyst → owner → payout),
// then loads the REAL app.js in a VM sandbox — the way tests/money.test.js
// does — and checks that the two sides agree:
//
//   * app_disburse writes clients and loans that app.js reads back unchanged
//     (ids, refs, the extra fields, unknown top-level keys), with the next
//     QS-/QSL- numbers app.js itself would have picked;
//   * borrower_history (what the analyst sees, and B8) equals analyzeLoan for
//     every loan of every client;
//   * single cents: the SQL loan maths round like app.js roundMoney (binary
//     floats), and the desk refuses terms whose interest isn't a whole cent,
//     so on everything it books its E7 equals the phone app's total due;
//   * worksheet maths: every tests/fixtures/credit-cases.json case through the
//     SQL private.assessment_compute AND the console's QSCredit.compute equals
//     the expected values to the cent, in rule order; plus a seeded fuzz where
//     the two must agree exactly (PARITY_SEED / PARITY_FUZZ to vary it).
//
//   node tests/parity.test.js
//
// Needs only Node and the PostgreSQL server binaries (see tests/README.md).

"use strict";

// app.js takes "today" from the device clock; the SQL uses Windhoek's date
// (CONTRACT §1). Pin this process to Windhoek (UTC+2, no DST) before anything
// reads a Date, so "overdue" and "days late" mean the same day on both sides.
process.env.TZ = "Africa/Windhoek";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const assert = require("assert/strict");
const pg = require("./sql/pg.js");

const ROOT = path.resolve(__dirname, "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const ADMIN = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8");
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "credit-cases.json"), "utf8"));
const STORAGE_KEY = "quickserve_cashloan_v1"; // app.js's own key

const OWNER = "parity.owner@quickserve.test";
const ANALYST = "parity.analyst@quickserve.test";
const FUZZ_SEED = Number(process.env.PARITY_SEED || 20260928);
const FUZZ_CASES = Number(process.env.PARITY_FUZZ || 600);

// CONTRACT §4: the computed keys and the rules table, in order.
const COMPUTED_KEYS = ["a4", "a6", "a8", "b12", "c10", "d1", "d2", "d3", "d4", "d5", "d6", "e1", "e2", "e3", "e4", "e5",
  "e7", "e10", "f3", "f4", "f5", "g7", "flag_count", "rules", "hard_fail_codes", "owner_fail_codes", "soft_fail_codes"];
const RULES = [["D4", "hard"], ["DOCS", "hard"], ["G1", "hard"], ["G2", "hard"], ["G3", "hard"], ["G4", "hard"],
  ["G10", "hard"], ["G11", "hard"], ["F3", "owner"], ["G8", "owner"], ["G5", "soft"], ["G6", "soft"], ["G9", "soft"],
  ["FLAGS", "soft"], ["VERIFY", "soft"], ["G7", "info"]];
// CONTRACT §7: exactly what app_disburse may write, in app.js's shape.
const CLIENT_KEYS = ["id", "ref", "createdAt", "name", "phone", "nationalId", "employer", "address", "nextOfKin", "notes"];
const LOAN_KEYS = ["id", "ref", "createdAt", "status", "clientId", "principal", "interestRate", "serviceFee", "issueDate",
  "dueDate", "purpose", "applicationId", "applicationRef", "payoutMethod", "payoutReference"];

// ---- the phone app, loaded exactly like tests/money.test.js does ----------

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

// A fresh sandbox. `storage` pre-fills localStorage, i.e. what the phone has
// saved (cloud.js adoptRemote writes the cloud copy there, then reloads).
// Values cross the VM boundary as JSON so assert's deep equality sees plain
// objects of this realm.
function loadApp(storage) {
  const localStorage = memoryStorage(storage);
  const context = vm.createContext({
    console,
    Intl,
    Date,
    Math,
    JSON,
    localStorage,
    navigator: { language: "en-NA" }
  });
  vm.runInContext(APP_JS, context, { filename: "app.js" });
  return {
    localStorage,
    run: (expr) => vm.runInContext(expr, context),
    json: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context)),
    setState: (next) => vm.runInContext(`state = ${JSON.stringify(next)}`, context)
  };
}

// Every loan as the phone app sees it. paid_date / days_late are not stored by
// app.js, so they come from its own payment allocation: the payment that took
// the balance to 0, and whole local days against the due date (CONTRACT §6).
const PHONE_LOANS = `state.loans.map((loan) => {
  const a = analyzeLoan(loan);
  const cleared = a.allocations.find((row) => row.outstandingAfter <= 0);
  const paidDate = a.outstanding <= 0 && cleared ? cleared.payment.date : null;
  const dayDiff = (from, to) => Math.round((dateFromISO(to) - dateFromISO(from)) / 86400000);
  return {
    id: loan.id, ref: loan.ref || null, clientId: loan.clientId,
    issueDate: loan.issueDate, dueDate: loan.dueDate,
    principal: a.terms.principal, interestRate: Number(loan.interestRate || 0), interest: a.terms.interest,
    fees: a.terms.fees, extensionInterest: a.terms.extensionInterest, totalDue: a.terms.totalDue,
    paid: a.paid, outstanding: a.outstanding, status: a.status,
    collectable: a.collectableOutstanding, writtenOff: a.writtenOffOutstanding,
    paidDate, daysLate: paidDate ? Math.max(0, dayDiff(loan.dueDate, paidDate)) : Math.max(0, -a.daysUntilDue),
    extensions: loanExtensions(loan).length,
    payments: paymentsForLoan(loan.id).map((p) => ({ date: p.date, amount: roundMoney(p.amount), method: p.method }))
  };
})`;

function phoneLoans(data) {
  const app = loadApp();
  app.setState(data);
  return app.json(PHONE_LOANS);
}

// ---- the console's worksheet maths, taken from the page by its id --------

function loadQSCredit() {
  const m = /<script id="credit-calc">([\s\S]*?)<\/script>/.exec(ADMIN);
  assert.ok(m, 'admin/index.html has a <script id="credit-calc"> block');
  const fakeWindow = {};
  new Function("window", m[1])(fakeWindow);
  assert.equal(typeof (fakeWindow.QSCredit && fakeWindow.QSCredit.compute), "function", "window.QSCredit.compute");
  return fakeWindow.QSCredit;
}

// ---- the database ----------------------------------------------------------

let db = null;

function sqlValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return pg.lit(v);
  return pg.jsonLit(v);
}

function actAs(who) {
  return who === "anon" ? "select tests.as_anon();\n" : `select tests.as_user(${pg.lit(who)});\n`;
}

// An RPC call the way PostgREST makes it: named params, as that login.
function rpcSql(who, name, params) {
  const args = Object.entries(params || {}).map(([k, v]) => `${k} => ${sqlValue(v)}`).join(", ");
  return `${actAs(who)}select public.${name}(${args});`;
}

function rpc(who, name, params) {
  return pg.psqlJson(db, rpcSql(who, name, params));
}

// The call must be refused with a contract error; returns {code, message}.
function rpcError(who, name, params) {
  const r = pg.psqlRaw(db, ["-A", "-t"], rpcSql(who, name, params));
  assert.notEqual(r.code, 0, `${name} as ${who} should have been refused`);
  const m = /ERROR:\s+(QS_[A-Z_]+): ([^\n]*)/.exec(r.stderr);
  assert.ok(m, `${name}: expected a QS_ error, got: ${r.stderr.trim()}`);
  return { code: m[1], message: m[2] };
}

function ledgerRow() {
  return pg.psqlJson(db, "select jsonb_build_object('data', data, 'rev', rev, 'updated_by', updated_by) from public.ledger where id = 'main';");
}

// private.ledger_loans is what borrower_history, B8 and qs_balance are built on.
function sqlLoans(data) {
  return pg.psqlJson(db, `select coalesce(jsonb_agg(to_jsonb(l) order by l.ord), '[]'::jsonb)
    from private.ledger_loans(${pg.jsonLit(data)}, private.today_na()) l;`);
}

// ---- dates and the loan book ----------------------------------------------

let TODAY = null; // Windhoek, from the database

function day(n, base) {
  const [y, m, d] = (base || TODAY).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normPhone = (s) => String(s || "").replace(/[^0-9]/g, "").slice(-9);
const refNo = (ref) => Number((String(ref || "").match(/(\d+)/) || [0, 0])[1]);
const roundMoney = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100; // app.js's

// A realistic book in the phone app's shape: clients with and without refs,
// gaps in the ref numbers, a legacy spreadsheet client with ref-less loans,
// rollovers, part and full payments (with cents), overpayment, written-off
// loans (one fully recovered), a phone-only lookalike, a passport holder, a
// client with no loans, and top-level keys the credit desk has never heard of.
function buildBook() {
  const pay = (id, loanId, amount, date, method, extra) => ({
    id, loanId, amount, date, method: method || "Cash", reference: "", notes: "",
    createdAt: `${date}T09:30:00.000Z`, ...(extra || {})
  });
  const loan = (id, ref, clientId, principal, interestRate, serviceFee, issue, due, purpose, extra) => ({
    id, ...(ref ? { ref } : {}), createdAt: `${issue}T08:15:00.000Z`, status: "active", clientId,
    principal, interestRate, serviceFee, issueDate: issue, dueDate: due, purpose, ...(extra || {})
  });
  const ext = (id, date, addedInterest, previousDueDate, newDueDate) => ({
    id, date, addedInterest, previousDueDate, newDueDate, note: "Asked for more time", createdAt: `${date}T10:00:00.000Z`
  });

  return {
    version: 1,
    settings: {
      companyName: "QuickServe Cashloan", currency: "N$", startingCapital: 0, startingCapitalDate: "",
      lastBackupAt: `${day(-3)}T18:00:00.000Z`, lastBackupCount: 4,
      projection: { recoveryRate: 95, redeployRate: 80, monthlyCosts: 1500, months: 6 }
    },
    clients: [
      { id: "client_mb0k1a2b_x7p2qa", ref: "QS-0001", createdAt: "2025-10-02T07:15:00.000Z", name: "Ndapewa Shilongo",
        phone: "081 240 1111", nationalId: "85072300315", employer: "Namdeb", address: "Kuisebmund, Walvis Bay",
        nextOfKin: "Petrus Shilongo (081 240 2222)", notes: "Pays at the office on the 25th." },
      // The returning applicant: employer and address still empty in the book.
      { id: "client_mb0k3c4d_q9w8e7", ref: "QS-0002", createdAt: "2025-11-14T09:02:11.418Z", name: "Johannes Amutenya",
        phone: "081 555 0202", nationalId: "90050554321", employer: "", address: "",
        nextOfKin: "Maria Amutenya (081 555 0303)", notes: "" },
      // From the old spreadsheet, before refs existed: no ref, no ID.
      { id: "client_old-book-person", createdAt: "2025-06-01T08:00:00.000Z", name: "Old Book Person",
        phone: "0811112233", nationalId: "", employer: "", address: "", nextOfKin: "",
        notes: "Imported from cash_loan_clients_clean.xlsx." },
      { id: "client_mb0k5e6f_a1s2d3", ref: "QS-0005", createdAt: "2026-01-20T11:45:00.000Z", name: "Hilma Nghipondoka",
        phone: "+264 81 777 1234", nationalId: "780101 00456", employer: "Ministry of Education",
        address: "Katutura, Windhoek", nextOfKin: "", notes: "" },
      // Same phone as Hilma, different person: a lookalike, never her history.
      { id: "client_mb0k7g8h_z0x9c8", ref: "QS-0008", createdAt: "2026-02-03T08:00:00.000Z", name: "Selma Nghipondoka",
        phone: "0817771234", nationalId: "79020200111", employer: "Shoprite", address: "Katutura", nextOfKin: "", notes: "" },
      { id: "client_mb0k9i0j_v5b6n7", ref: "QS-0009", createdAt: "2026-02-10T08:00:00.000Z", name: "Tomas Kapembe",
        phone: "", nationalId: "N1234567", employer: "", address: "", nextOfKin: "", notes: "Passport holder." },
      { id: "client_mb0kakbl_m4n3b2", ref: "QS-0012", createdAt: "2026-04-01T08:00:00.000Z", name: "Frieda Haufiku",
        phone: "081 404 0404", nationalId: "88112200987", employer: "NamPower", address: "Otjomuise", nextOfKin: "", notes: "" }
    ],
    loans: [
      loan("loan_mb0l0001_aa1111", "QSL-0001", "client_mb0k1a2b_x7p2qa", 2000, 30, 0, day(-150), day(-120), "Rent"),
      loan("loan_mb0l0002_bb2222", "QSL-0002", "client_mb0k1a2b_x7p2qa", 1500, 30, 50, day(-90), day(-60), "Groceries"),
      loan("loan_row-3", null, "client_old-book-person", 500, 30, 0, day(-300), day(-270), "Legacy"),
      loan("loan_row-4", null, "client_old-book-person", 800, 30, 0, day(-240), day(-210), "Legacy", { status: "written-off" }),
      loan("loan_mb0l0003_cc3333", "QSL-0003", "client_mb0k7g8h_z0x9c8", 1500, 30, 0, day(-60), day(-30), "School"),
      // Rolled over once: +900 interest, due date moved on 30 days.
      loan("loan_mb0l0004_dd4444", "QSL-0004", "client_mb0k3c4d_q9w8e7", 3000, 30, 0, day(-40), day(10), "Car repair",
        { extensions: [ext("ext_mb0x0001_ee5555", day(-10), 900, day(-10), day(10))] }),
      loan("loan_mb0l0007_ff6666", "QSL-0007", "client_mb0k3c4d_q9w8e7", 1000, 30, 0, day(-42), day(-12), "Transport"),
      loan("loan_mb0l0008_gg7777", "QSL-0008", "client_mb0k3c4d_q9w8e7", 1200, 25, 0, day(-100), day(-70), "Funeral"),
      loan("loan_mb0l0010_hh8888", "QSL-0010", "client_mb0k5e6f_a1s2d3", 5000, 30, 100, day(-5), day(25), "School fees"),
      loan("loan_mb0l0011_ii9999", "QSL-0011", "client_mb0k5e6f_a1s2d3", 700, 30, 0, day(-200), day(-170), "Other",
        { status: "written-off" }),
      // Written off, then recovered in full: the phone app calls that paid.
      loan("loan_mb0l0013_jj0000", "QSL-0013", "client_mb0k1a2b_x7p2qa", 400, 30, 0, day(-60), day(-30), "Airtime",
        { status: "written-off" }),
      // Rolled over twice, part paid, now overdue.
      loan("loan_mb0l0014_kk1111", "QSL-0014", "client_mb0k5e6f_a1s2d3", 2000, 30, 0, day(-100), day(-40), "Stock",
        { extensions: [ext("ext_mb0x0002_ll2222", day(-70), 600, day(-70), day(-55)),
          ext("ext_mb0x0003_mm3333", day(-55), 600, day(-55), day(-40))] }),
      loan("loan_mb0l0015_nn4444", "QSL-0015", "client_mb0k9i0j_v5b6n7", 2500, 30, 0, day(-80), day(-50), "Travel")
    ],
    payments: [
      pay("payment_mb0p0001_p00001", "loan_mb0l0001_aa1111", 2600, day(-120)),
      pay("payment_mb0p0002_p00002", "loan_mb0l0002_bb2222", 1000, day(-70)),
      pay("payment_mb0p0003_p00003", "loan_mb0l0002_bb2222", 1000, day(-55), "Bank transfer", { reference: "FNB 0042", receipt: "R-0042" }),
      pay("payment_row-3", "loan_row-3", 650, day(-268), "Historical"),
      pay("payment_row-4", "loan_row-4", 200, day(-200), "Historical"),
      pay("payment_mb0p0005_p00005", "loan_mb0l0004_dd4444", 1200, day(-12), "E-wallet"),
      pay("payment_mb0p0006_p00006", "loan_mb0l0008_gg7777", 1600, day(-75)),
      pay("payment_mb0p0007_p00007", "loan_mb0l0013_jj0000", 520, day(-20)),
      pay("payment_mb0p0008_p00008", "loan_mb0l0014_kk1111", 1000, day(-80)),
      pay("payment_mb0p0009_p00009", "loan_mb0l0014_kk1111", 1000, day(-50)),
      pay("payment_mb0p0010_p00010", "loan_mb0l0015_nn4444", 866.67, day(-70)),
      pay("payment_mb0p0011_p00011", "loan_mb0l0015_nn4444", 866.67, day(-60)),
      pay("payment_mb0p0012_p00012", "loan_mb0l0015_nn4444", 1516.66, day(-45), "Bank transfer")
    ],
    expenses: [
      { id: "expense_mb0e0001_x00001", date: day(-3), amount: 120, category: "Airtime", note: "Office phone", createdAt: `${day(-3)}T12:00:00.000Z` },
      { id: "expense_mb0e0002_x00002", date: day(-30), amount: 450.5, category: "Transport", note: "", createdAt: `${day(-30)}T12:00:00.000Z` }
    ],
    capital: [
      { id: "capital_mb0c0001_k00001", direction: "in", amount: 60000, date: day(-365), note: "Opening float", createdAt: "" }
    ],
    imports: ["cash_loan_clients_clean_2026_march_july_v1"],
    // Keys neither side knows: both must carry them through untouched.
    customTopLevelKey: { keep: "me", nested: { list: [1, "two", { three: true }] } },
    reminderLog: [{ loanId: "loan_mb0l0007_ff6666", sentAt: `${day(-11)}T08:00:00.000Z`, via: "whatsapp" }],
    updatedAt: `${day(-1)}T17:04:09.221Z`
  };
}

// ---- applications, as the Worker sends them -------------------------------

let intakeKey = null;

function applicationPayload(p) {
  return {
    full_name: p.full_name, national_id: p.national_id, date_of_birth: p.date_of_birth || null,
    phone: p.phone, email: "applicant@example.com", address: p.address || "12 Sam Nujoma Ave", town: p.town || "Windhoek",
    dependants: 2, employer: p.employer || "NamWater", job_title: "Clerk", employment_type: "Permanent", pay_day: "25th",
    bank_name: "FNB Namibia", bank_account_holder: p.full_name, bank_account_no: "62001234567", salary_into_account: true,
    kin_name: p.kin_name || "Martha Kin", kin_relationship: "Sister", kin_phone: p.kin_phone || "085 612 3390",
    amount_requested: p.amount_requested || 1000, repay_date: day(30), purpose: p.purpose || "School fees",
    declared_income: 18400, declared_deductions: 1500, declared_expenses: 9000,
    other_lender_loans: true, other_lender_count: 1,
    consent_processing: true, consent_bureau: true, consent_version: "v2026-10",
    ip_hash: crypto.randomBytes(32).toString("hex")
  };
}

function docsPayload() {
  const folder = crypto.randomUUID();
  const doc = (kind, seq, ext, mime, bytes) => ({ kind, seq, r2_key: `apps/${folder}/${kind}-${seq}.${ext}`, mime, bytes, original_name: `${kind}-${seq}.${ext}` });
  return [doc("id", 1, "jpg", "image/jpeg", 120000), doc("payslip", 1, "pdf", "application/pdf", 240000),
    doc("bank", 1, "pdf", "application/pdf", 410000), doc("bank", 2, "pdf", "application/pdf", 395000),
    doc("bank", 3, "pdf", "application/pdf", 402000)];
}

function submit(applicant) {
  const res = rpc("anon", "intake_submit", { p_key: intakeKey, p_app: applicationPayload(applicant), p_docs: docsPayload() });
  assert.match(res.ref, /^QSA-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, "new application ref");
  return res;
}

const REASONS = "Income verified on the payslip and three bank statements; commitments checked against the statements.";
const MOTIVATION = "Twelve years with the same employer, salary paid into this account every month and a clean record with us.";
const OVERRIDE = "Accepted the analyst's motivation: stable employer and salary.";
const DECLARATION = { d12_1: true, d12_2: true, d12_3: true, d12_4: true, d12_5: true, d12_6: true, d12_7: true };
const CHECKLIST = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`13.${i + 1}`, true]));
const WORKSHEET = CASES.find((c) => c.name === "clean_pass").worksheet; // the contract §4 example

const appBits = (a) => ({ consent_bureau: a.consent_bureau, amount_requested: a.amount_requested, bank_account_no: a.bank_account_no,
  pay_day: a.pay_day, employer: a.employer, kin_name: a.kin_name, kin_phone: a.kin_phone });

// ---- tiny runner (as tests/money.test.js) ---------------------------------

const results = [];
const ctx = {};
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}
function need(...keys) {
  for (const k of keys) if (ctx[k] === undefined) throw new Error(`not run: an earlier step failed (${k} missing)`);
}

// ---------------------------------------------------------------------------

let QS = null;
try {
  pg.startCluster();
  db = pg.createDb("parity");
  QS = loadQSCredit();
} catch (e) {
  console.log(`FAIL  setup\n      ${String(e.stack || e).split("\n").join("\n      ")}`);
  pg.stop();
  process.exit(1);
}

test("setup: an owner and an analyst, and the owner's phone pushes the book (rev-guarded, like cloud.js)", () => {
  TODAY = pg.psql(db, "select to_char(private.today_na(), 'YYYY-MM-DD');").trim();
  assert.equal(loadApp().run("todayISO()"), TODAY, "app.js and the SQL agree on today's date (Windhoek)");

  // Seeded the way docs/credit-desk/RUNBOOK.md does it: logins first, the
  // owner by postgres, the analyst by the owner through the Team RPC.
  pg.psql(db, `select tests.create_user(${pg.lit(OWNER)}); select tests.create_user(${pg.lit(ANALYST)});
    select private.seed_owner(${pg.lit(OWNER)}, 'Parity Owner');`);
  const added = rpc(OWNER, "staff_add", { p_email: ANALYST, p_full_name: "Parity Analyst", p_role: "analyst" });
  assert.equal(added.role, "analyst");
  assert.equal(rpc(OWNER, "whoami").role, "owner");
  ctx.analystId = rpc(ANALYST, "whoami").user_id;
  assert.ok(ctx.analystId, "the analyst is staff");

  // The owner decided: D5 70 % (above it only with a motivation + override),
  // no credit bureau yet, N$100,000 at most.
  const policy = rpc(ANALYST, "policy_get");
  assert.equal(policy.max_share_disposable_pct, 70);
  assert.equal(policy.bureau_required, false);
  assert.equal(policy.max_principal, 100000);

  ctx.book = buildBook();
  const rev = pg.psqlJson(db, "select rev from public.ledger where id = 'main';");
  const pushed = pg.psqlJson(db, `${actAs(OWNER)}update public.ledger
      set data = ${pg.jsonLit(ctx.book)}, rev = rev + 1, updated_at = now(), updated_by = ${pg.lit(OWNER)}
    where id = 'main' and rev = ${rev} returning rev;`);
  assert.equal(pushed, rev + 1, "the owner's rev-guarded push went through RLS");
  assert.equal(pg.psqlJson(db, `${actAs(ANALYST)}select count(*) from public.ledger;`), 0, "the analyst never sees the ledger");
  const row = ledgerRow();
  assert.deepEqual(row.data, ctx.book, "stored exactly as pushed");
  ctx.row0 = row;
  intakeKey = pg.psql(db, "select private.intake_rotate_key();").trim();
});

test("returning client: website → analyst → owner → payout books the loan onto the existing client", () => {
  need("row0");
  const johannes = ctx.book.clients[1];
  const sub = submit({ full_name: "Johannes Amutenya", national_id: "900505 54321", date_of_birth: "1990-05-05",
    phone: "0815550202", address: "Erf 1234, Extension 3", town: "Ongwediva", employer: "NamWater",
    kin_name: "Maria Amutenya", kin_phone: "081 555 0303", amount_requested: 1000, purpose: "School uniforms" });
  const id = sub.id;

  let app = rpc(ANALYST, "app_claim", { p_app_id: id });
  assert.equal(app.status, "in_review");
  assert.equal(app.assigned_to, ctx.analystId);

  ctx.histA = rpc(ANALYST, "borrower_history", { p_app_id: id });
  assert.deepEqual(ctx.histA.matches.filter((m) => m.match === "id").map((m) => m.client.id), [johannes.id], "found by ID");

  const terms = { principal: 1000, interest_rate: 30, service_fee: 0, issue_date: TODAY, due_date: day(30) };
  ctx.saveA = rpc(ANALYST, "assessment_save", { p_app_id: id, p_worksheet: WORKSHEET, p_terms: terms });
  ctx.getA = rpc(ANALYST, "app_get", { p_app_id: id });
  assert.deepEqual(ctx.saveA.computed.hard_fail_codes, []);
  assert.deepEqual(ctx.saveA.computed.owner_fail_codes, [], "affordable even with B8 = the open QuickServe balance");

  const submitted = rpc(ANALYST, "assessment_submit", { p_app_id: id, p_recommendation: "approve", p_reasons: REASONS,
    p_motivation: null, p_declaration: DECLARATION });
  assert.equal(rpcError(ANALYST, "app_decide", { p_app_id: id, p_assessment_version: submitted.version, p_outcome: "approved" }).code,
    "QS_FORBIDDEN", "only an owner decides");
  ctx.decA = rpc(OWNER, "app_decide", { p_app_id: id, p_assessment_version: submitted.version, p_outcome: "approved",
    p_terms: null, p_reasons: null, p_reason_to_applicant: null, p_override_note: null });
  assert.equal(ctx.decA.outcome, "approved");
  assert.equal(ctx.decA.self_assessed, false);

  ctx.previewA = rpc(OWNER, "app_disburse_preview", { p_app_id: id, p_issue_date: TODAY, p_due_date: day(30) });
  assert.equal(ctx.previewA.client_match.mode, "existing");
  assert.deepEqual(ctx.previewA.client_match.candidates.map((c) => c.id), [johannes.id]);
  assert.deepEqual(ctx.previewA.checks, { G1: true, G2: true, G3: true, issue_not_future: true });

  ctx.resA = rpc(OWNER, "app_disburse", { p_app_id: id, p_checklist: CHECKLIST, p_issue_date: TODAY, p_due_date: day(30),
    p_method: "Bank transfer", p_reference: "FNB-778812", p_client_id: johannes.id, p_new_client: false });
  assert.equal(ctx.resA.client_id, johannes.id);
  assert.equal(ctx.resA.ledger_rev, ctx.row0.rev + 1);
  app = rpc(OWNER, "app_get", { p_app_id: id }).application;
  assert.equal(app.status, "disbursed");
  assert.equal(app.loan_ref, ctx.resA.loan_ref);
  ctx.appA = app;
  ctx.row1 = ledgerRow();
});

test("new client above the D5 limit: the analyst motivates, the owner overrides with a note, then pays out", () => {
  need("row1");
  const sub = submit({ full_name: "Rauha Iipinge", national_id: "92111500321", date_of_birth: "1992-11-15",
    phone: "081 999 4321", address: "House 7, Nkurenkuru Street", town: "Rundu", employer: "Namibia Breweries",
    kin_name: "Ester Iipinge", kin_phone: "081 999 1234", amount_requested: 4500, purpose: "Medical bills" });
  const id = sub.id;
  rpc(ANALYST, "app_claim", { p_app_id: id });

  // D6 is N$5,334; N$4,500 at 30 % is N$5,850 to repay: over the limit.
  const terms = { principal: 4500, interest_rate: 30, service_fee: 0, issue_date: TODAY, due_date: day(30) };
  ctx.saveB = rpc(ANALYST, "assessment_save", { p_app_id: id, p_worksheet: WORKSHEET, p_terms: terms });
  assert.deepEqual(ctx.saveB.computed.hard_fail_codes, []);
  assert.deepEqual(ctx.saveB.computed.owner_fail_codes, ["F3", "G8"]);
  assert.deepEqual(ctx.saveB.computed.soft_fail_codes, []);
  ctx.getB = rpc(ANALYST, "app_get", { p_app_id: id });

  const plain = { p_app_id: id, p_recommendation: "approve", p_reasons: REASONS, p_motivation: null, p_declaration: DECLARATION };
  assert.equal(rpcError(ANALYST, "assessment_submit", plain).code, "QS_OVERRIDE_REQUIRED", "a plain approve is refused above D5");
  const submitted = rpc(ANALYST, "assessment_submit", { ...plain, p_recommendation: "approve_above_limit", p_motivation: MOTIVATION });

  const decide = { p_app_id: id, p_assessment_version: submitted.version, p_outcome: "approved", p_terms: null,
    p_reasons: null, p_reason_to_applicant: null, p_override_note: null };
  assert.equal(rpcError(OWNER, "app_decide", decide).code, "QS_OVERRIDE_REQUIRED", "no override note, no approval");
  ctx.decB = rpc(OWNER, "app_decide", { ...decide, p_override_note: OVERRIDE });
  assert.equal(ctx.decB.outcome, "approved");
  assert.deepEqual(ctx.decB.overridden_codes, ["F3", "G8"]);

  ctx.previewB = rpc(OWNER, "app_disburse_preview", { p_app_id: id, p_issue_date: TODAY, p_due_date: day(30) });
  assert.equal(ctx.previewB.client_match.mode, "new");
  ctx.resB = rpc(OWNER, "app_disburse", { p_app_id: id, p_checklist: CHECKLIST, p_issue_date: TODAY, p_due_date: day(30),
    p_method: "Cash", p_reference: null, p_client_id: null, p_new_client: true });
  assert.equal(ctx.resB.ledger_rev, ctx.row1.rev + 1);
  ctx.appB = rpc(OWNER, "app_get", { p_app_id: id }).application;
  assert.equal(ctx.appB.status, "disbursed");
  ctx.row2 = ledgerRow();
});

test("refs: app_disburse picks the next QS-/QSL- numbers app.js would pick (gaps and ref-less records included)", () => {
  need("row0", "row1", "row2", "previewA", "previewB", "resA", "resB");
  const next = (row) => {
    const app = loadApp();
    app.setState(row.data); // as stored, before the phone backfills anything
    return { client: app.run("nextClientRef()"), loan: app.run("nextLoanRef()") };
  };
  const beforeA = next(ctx.row0);
  const beforeB = next(ctx.row1);
  assert.deepEqual(beforeA, { client: "QS-0013", loan: "QSL-0016" }, "app.js on the pushed book");
  assert.equal(ctx.previewA.next_loan_ref, beforeA.loan);
  assert.equal(ctx.previewA.next_client_ref, beforeA.client);
  assert.equal(ctx.resA.loan_ref, beforeA.loan, "returning client's loan");
  assert.equal(ctx.resA.client_ref, "QS-0002", "booked onto the existing client");
  assert.equal(ctx.previewB.next_loan_ref, beforeB.loan);
  assert.equal(ctx.previewB.next_client_ref, beforeB.client);
  assert.equal(ctx.resB.loan_ref, beforeB.loan, "new client's loan");
  assert.equal(ctx.resB.client_ref, beforeB.client, "new client");
  assert.equal(beforeB.loan, "QSL-0017");
});

test("app_disburse wrote exactly the app.js record shapes, and nothing else in the book moved", () => {
  need("row0", "row2", "resA", "resB", "appA", "appB");
  const before = ctx.row0.data;
  const after = ctx.row2.data;
  const started = Date.now();

  assert.equal(ctx.row2.rev, ctx.row0.rev + 2, "one rev per booking");
  assert.equal(ctx.row2.updated_by, OWNER, "updated_by is the owner who paid out");
  for (const key of Object.keys(before)) {
    if (!["clients", "loans", "updatedAt"].includes(key)) assert.deepEqual(after[key], before[key], `top-level ${key} untouched`);
  }
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "no top-level key added or dropped");
  assert.deepEqual(after.loans.slice(0, before.loans.length), before.loans, "existing loans untouched, in order");
  assert.equal(after.loans.length, before.loans.length + 2);
  assert.equal(after.clients.length, before.clients.length + 1);
  assert.equal(after.updatedAt, after.loans[after.loans.length - 1].createdAt, "data.updatedAt = the last booking");

  const [loanA, loanB] = after.loans.slice(-2);
  for (const [loan, res, app, method, reference] of [[loanA, ctx.resA, ctx.appA, "Bank transfer", "FNB-778812"],
                                                   [loanB, ctx.resB, ctx.appB, "Cash", ""]]) {
    assert.deepEqual(Object.keys(loan).sort(), [...LOAN_KEYS].sort(), "loan keys");
    assert.match(loan.id, /^loan_[0-9a-z]+_[0-9a-z]{6}$/, "loan_ + base36(ms) + _ + 6");
    assert.match(loan.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ms = parseInt(loan.id.split("_")[1], 36);
    assert.ok(Math.abs(ms - Date.parse(loan.createdAt)) < 1000, "the id's time part is the createdAt time");
    assert.ok(Math.abs(ms - started) < 10 * 60 * 1000, "the id's time part is now, in epoch ms");
    assert.equal(loan.id, res.loan_id);
    assert.equal(loan.ref, res.loan_ref);
    assert.equal(loan.clientId, res.client_id);
    assert.equal(loan.status, "active");
    assert.equal(loan.issueDate, TODAY);
    assert.equal(loan.dueDate, day(30));
    assert.equal(loan.applicationId, app.id);
    assert.equal(loan.applicationRef, app.ref);
    assert.equal(loan.payoutMethod, method);
    assert.equal(loan.payoutReference, reference);
    assert.equal(loan.purpose, app.purpose);
    for (const k of ["principal", "interestRate", "serviceFee"]) assert.equal(typeof loan[k], "number", `${k} is a JSON number`);
  }
  assert.deepEqual([loanA.principal, loanA.interestRate, loanA.serviceFee], [1000, 30, 0]);
  assert.deepEqual([loanB.principal, loanB.interestRate, loanB.serviceFee], [4500, 30, 0]);

  // The returning client: only the empty details were filled in.
  const was = before.clients[1];
  const now = after.clients[1];
  assert.deepEqual(now, { ...was, employer: "NamWater", address: "Erf 1234, Extension 3, Ongwediva" },
    "existing client: empty employer/address filled, name/phone/ID/next of kin/notes kept");
  assert.deepEqual(after.clients.filter((c, i) => i !== 1).slice(0, before.clients.length - 1),
    before.clients.filter((c, i) => i !== 1), "every other client untouched");

  // The new client, in the phone app's shape.
  const client = after.clients[after.clients.length - 1];
  assert.deepEqual(Object.keys(client).sort(), [...CLIENT_KEYS].sort(), "client keys");
  assert.match(client.id, /^client_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.deepEqual({ ...client, id: "", createdAt: "" }, {
    id: "", ref: ctx.resB.client_ref, createdAt: "", name: "Rauha Iipinge", phone: "081 999 4321", nationalId: "92111500321",
    employer: "Namibia Breweries", address: "House 7, Nkurenkuru Street, Rundu", nextOfKin: "Ester Iipinge (081 999 1234)",
    notes: `From application ${ctx.appB.ref} (${TODAY})`
  });
  assert.equal(loanB.clientId, client.id);
  assert.equal(loanA.clientId, was.id);
});

test("normalizeState keeps every SQL-written id, ref and field, and the unknown top-level keys", () => {
  need("row2");
  const data = ctx.row2.data;
  const app = loadApp();
  app.run(`state = normalizeState(${JSON.stringify(data)})`);
  const state = app.json("state");

  const refless = (list) => list.filter((r) => !r.ref).map((r) => r.id);
  for (const [kind, list] of [["client", data.clients], ["loan", data.loans]]) {
    const out = state[`${kind}s`];
    assert.deepEqual(out.map((r) => r.id), list.map((r) => r.id), `${kind} ids and order unchanged`);
    list.forEach((rec, i) => {
      if (rec.ref) assert.deepEqual(out[i], rec, `${kind} ${rec.ref} unchanged, every field kept`);
      else assert.deepEqual({ ...out[i], ref: undefined }, { ...rec, ref: undefined }, `ref-less ${kind} only gains a ref`);
    });
    const refs = out.map((r) => r.ref);
    assert.equal(new Set(refs).size, refs.length, `${kind} refs stay unique after the phone backfills the ref-less ones`);
    const sqlMax = Math.max(...list.filter((r) => r.ref).map((r) => refNo(r.ref)));
    for (const r of out.filter((x) => refless(list).includes(x.id))) {
      assert.ok(refNo(r.ref) > sqlMax, `backfilled ${kind} ref ${r.ref} goes after the SQL-written ones`);
    }
  }
  const sqlLoans = data.loans.slice(-2);
  for (const loan of sqlLoans) {
    const kept = state.loans.find((l) => l.id === loan.id);
    for (const k of ["applicationId", "applicationRef", "payoutMethod", "payoutReference", "ref"]) {
      assert.equal(kept[k], loan[k], `${loan.ref}.${k} kept`);
    }
  }
  assert.deepEqual(state.customTopLevelKey, data.customTopLevelKey, "unknown top-level key kept");
  assert.deepEqual(state.reminderLog, data.reminderLog, "second unknown top-level key kept");
  assert.deepEqual(state.settings, data.settings, "settings unchanged");
  for (const k of ["payments", "expenses", "capital", "imports"]) assert.deepEqual(state[k], data[k], `${k} unchanged`);
});

test("phone boot: app.js adopting the cloud copy keeps the SQL records and books the new loans like its own", () => {
  need("row2", "resA", "resB");
  const data = ctx.row2.data;
  // cloud.js adoptRemote(): the cloud JSON goes into app.js's storage, then the app reloads.
  const app = loadApp({ [STORAGE_KEY]: JSON.stringify(data) });
  const saved = JSON.parse(app.localStorage.getItem(STORAGE_KEY)); // what the phone will push back
  for (const res of [ctx.resA, ctx.resB]) {
    const want = data.loans.find((l) => l.id === res.loan_id);
    assert.deepEqual(saved.loans.find((l) => l.id === res.loan_id), want, `${res.loan_ref} saved back untouched`);
    assert.deepEqual(saved.clients.find((c) => c.id === res.client_id), data.clients.find((c) => c.id === res.client_id),
      `${res.client_ref} saved back untouched`);
  }
  assert.deepEqual(saved.customTopLevelKey, data.customTopLevelKey, "unknown key survives a phone save");
  assert.deepEqual(saved.reminderLog, data.reminderLog);

  const seen = app.json(`[${JSON.stringify(ctx.resA.loan_id)}, ${JSON.stringify(ctx.resB.loan_id)}].map((id) => {
    const loan = getLoan(id), a = analyzeLoan(loan);
    return { client: getClientName(loan.clientId), status: a.status, totalDue: a.terms.totalDue, outstanding: a.outstanding,
      out: cashMovements().filter((m) => m.kind === "loan-out" && m.createdAt === loan.createdAt).map((m) => [m.date, m.amount]) };
  })`);
  assert.deepEqual(seen, [
    { client: "Johannes Amutenya", status: "active", totalDue: 1300, outstanding: 1300, out: [[TODAY, -1000]] },
    { client: "Rauha Iipinge", status: "active", totalDue: 5850, outstanding: 5850, out: [[TODAY, -4500]] }
  ]);
  // "Will be booked as" (the desk's E7 on the final terms) = what the phone app will collect.
  assert.equal(ctx.decA.computed.e7, seen[0].totalDue);
  assert.equal(ctx.decB.computed.e7, seen[1].totalDue);
  assert.equal(ctx.previewA.terms.total_repayable, seen[0].totalDue);
  assert.equal(ctx.previewB.terms.total_repayable, seen[1].totalDue);
  ctx.phoneSaved = saved;
});

// Compare the SQL loan maths (private.ledger_loans) with app.js for every loan.
function compareAllLoans(data, label) {
  const phone = phoneLoans(data);
  const sql = sqlLoans(data);
  assert.deepEqual(sql.map((l) => l.loan_id), phone.map((l) => l.id), `${label}: same loans, same order`);
  const diffs = [];
  sql.forEach((s, i) => {
    const p = phone[i];
    const pairs = {
      principal: [s.principal, p.principal], interest: [s.interest, p.interest], fees: [s.fees, p.fees],
      extension_interest: [s.extension_interest, p.extensionInterest], total_due: [s.total_due, p.totalDue],
      paid: [s.paid, p.paid], outstanding: [s.outstanding, p.outstanding], status: [s.status, p.status],
      paid_date: [s.paid_date, p.paidDate], days_late: [s.days_late, p.daysLate], extensions: [s.extensions, p.extensions],
      payments: [JSON.stringify(s.payments), JSON.stringify(p.payments)]
    };
    for (const [k, [a, b]] of Object.entries(pairs)) {
      if (a !== b) diffs.push(`${p.ref || p.id}.${k}: SQL ${a} vs app.js ${b}`);
    }
  });
  assert.deepEqual(diffs, [], `${label}: SQL loan maths differ from app.js analyzeLoan`);
  return phone;
}

test("analyzeLoan equals the SQL loan maths for every loan in the book (before and after the bookings)", () => {
  need("row0", "row2");
  compareAllLoans(ctx.row0.data, "as pushed");
  const phone = compareAllLoans(ctx.row2.data, "after two bookings");
  // The book really does cover every status.
  assert.deepEqual([...new Set(phone.map((l) => l.status))].sort(), ["active", "overdue", "paid", "written-off"]);
  assert.ok(phone.some((l) => l.status === "paid" && l.daysLate > 0), "a loan paid late");
  assert.ok(phone.some((l) => l.extensions === 2), "a loan rolled over twice");
});

// borrower_history for an applicant with this ID/phone, checked against app.js.
function checkHistory(hist, data, applicant, label) {
  const phone = phoneLoans(data);
  const idKey = normId(applicant.national_id);
  const byRef = (a, b) => refNo(a.ref) - refNo(b.ref);
  const idClients = data.clients.filter((c) => idKey && normId(c.nationalId) === idKey).sort(byRef);
  const phoneKey = normPhone(applicant.phone);
  const lookalikes = data.clients.filter((c) => phoneKey.length >= 7 && normPhone(c.phone) === phoneKey
    && !(idKey && normId(c.nationalId) === idKey)).sort(byRef);

  assert.deepEqual(hist.matches.filter((m) => m.match === "id").map((m) => m.client.id), idClients.map((c) => c.id), `${label}: ID matches`);
  assert.deepEqual(hist.matches.filter((m) => m.match === "phone").map((m) => m.client.id), lookalikes.map((c) => c.id), `${label}: phone-only matches`);

  let balance = 0;
  for (const m of hist.matches) {
    assert.ok(!("notes" in m.client), `${label}: client notes are never returned`);
    if (m.match === "phone") {
      assert.deepEqual(m.loans, [], `${label}: a phone-only lookalike's loans stay hidden`);
      continue;
    }
    const c = data.clients.find((x) => x.id === m.client.id);
    assert.deepEqual(m.client, { id: c.id, ref: c.ref, name: c.name, phone: c.phone, national_id: c.nationalId,
      employer: c.employer, address: c.address, next_of_kin: c.nextOfKin }, `${label}: client ${c.ref}`);
    const mine = phone.filter((l) => l.clientId === c.id);
    assert.deepEqual(m.loans.map((l) => l.id).sort(), mine.map((l) => l.id).sort(), `${label}: ${c.ref}'s loans`);
    for (const l of m.loans) {
      const p = mine.find((x) => x.id === l.id);
      assert.deepEqual({
        ref: l.ref, issue_date: l.issue_date, due_date: l.due_date, principal: l.principal, interest_rate: l.interest_rate,
        service_fee: l.service_fee, extension_interest: l.extension_interest, total_due: l.total_due, paid: l.paid,
        outstanding: l.outstanding, status: l.status, paid_date: l.paid_date, days_late: l.days_late,
        extensions: l.extensions, payments: l.payments
      }, {
        ref: p.ref, issue_date: p.issueDate, due_date: p.dueDate, principal: p.principal, interest_rate: p.interestRate,
        service_fee: p.fees, extension_interest: p.extensionInterest, total_due: p.totalDue, paid: p.paid,
        outstanding: p.outstanding, status: p.status, paid_date: p.paidDate, days_late: p.daysLate,
        extensions: p.extensions, payments: p.payments
      }, `${label}: loan ${p.ref || p.id} = app.js analyzeLoan`);
    }
    const sum = (list, k) => roundMoney(list.reduce((s, x) => s + x[k], 0));
    const want = {
      loans: mine.length, borrowed: sum(mine, "principal"), repaid: sum(mine, "paid"),
      late_loans: mine.filter((x) => x.daysLate > 0).length, max_days_late: Math.max(0, ...mine.map((x) => x.daysLate)),
      outstanding: sum(mine, "collectable")
    };
    if ("written_off" in m.summary) want.written_off = sum(mine, "writtenOff");
    assert.deepEqual(m.summary, want, `${label}: ${c.ref} summary`);
    balance += want.outstanding;
  }
  assert.equal(hist.qs_balance, roundMoney(balance), `${label}: qs_balance = what the phone app says is collectable`);
  return hist.qs_balance;
}

test("borrower_history equals analyzeLoan for every client with an ID (loans, summary, qs_balance)", () => {
  need("row0", "row2", "histA");
  // What the analyst saw on the returning client's file, before the booking.
  checkHistory(ctx.histA, ctx.row0.data, { national_id: "900505 54321", phone: "0815550202" }, "returning client (before)");

  // After both bookings: a fresh application from each ID holder in the book
  // (using their own phone, so lookalikes show up too) and from the new client.
  const data = ctx.row2.data;
  const people = data.clients.filter((c) => normId(c.nationalId));
  assert.ok(people.length >= 6);
  for (const c of people) {
    const who = { full_name: c.name, national_id: c.nationalId, phone: normPhone(c.phone).length >= 7 ? c.phone : "081 000 0909" };
    const probe = submit(who);
    const hist = rpc(ANALYST, "borrower_history", { p_app_id: probe.id });
    checkHistory(hist, data, who, `${c.ref || c.id} (after)`);
  }
});

test("the worksheets the analyst saved: B8 = the phone app's balance, and the server's maths = QSCredit's", () => {
  need("saveA", "getA", "saveB", "getB", "decA", "decB", "row0");
  const johannes = phoneLoans(ctx.row0.data).filter((l) => l.clientId === ctx.book.clients[1].id);
  const b8 = roundMoney(johannes.reduce((s, l) => s + l.collectable, 0));
  assert.equal(b8, 4900, "3,600 on the rolled-over loan + 1,300 overdue; the paid loan counts 0");
  assert.equal(ctx.getA.assessment.worksheet.commitments.b8, b8, "B8 written server-side from the ledger");
  assert.equal(ctx.getB.assessment.worksheet.commitments.b8, 0, "a new client owes QuickServe nothing");

  for (const [label, save, got, dec] of [["returning", ctx.saveA, ctx.getA, ctx.decA], ["new", ctx.saveB, ctx.getB, ctx.decB]]) {
    const asm = got.assessment;
    const js = QS.compute(asm.worksheet, asm.terms, appBits(got.application), got.policy);
    assert.deepEqual(save.computed, js, `${label}: assessment_save computed = QSCredit.compute`);
    assert.deepEqual(asm.computed, js, `${label}: stored computed = QSCredit.compute`);
    assert.deepEqual(dec.computed, QS.compute(asm.worksheet, dec.terms, appBits(got.application), got.policy),
      `${label}: the owner's decision re-computed = QSCredit.compute on the final terms`);
  }
  assert.equal(ctx.saveA.computed.d4, 2720, "D4 with B8 = 4,900");
  assert.equal(ctx.saveB.computed.f5, 4100, "F5: the most that passes");
});

test("phone round trip: the phone pushes its saved book back; the SQL reads it the same and picks the next ref app.js would", () => {
  need("phoneSaved", "row2");
  const data = ctx.phoneSaved; // refs now backfilled by the phone
  const pushed = pg.psqlJson(db, `${actAs(OWNER)}update public.ledger
      set data = ${pg.jsonLit(data)}, rev = rev + 1, updated_at = now(), updated_by = ${pg.lit(OWNER)}
    where id = 'main' and rev = ${ctx.row2.rev} returning rev;`);
  assert.equal(pushed, ctx.row2.rev + 1);
  compareAllLoans(ledgerRow().data, "after the phone's push");
  const app = loadApp();
  app.setState(data);
  const sql = pg.psqlJson(db, `select jsonb_build_array(private.next_ref(data -> 'clients', 'QS-'), private.next_ref(data -> 'loans', 'QSL-'))
    from public.ledger where id = 'main';`);
  assert.deepEqual(sql, [app.run("nextClientRef()"), app.run("nextLoanRef()")]);
});

test("credit-cases.json: SQL assessment_compute and QSCredit.compute both equal expected, to the cent and in rule order", () => {
  assert.ok(CASES.length >= 28, "the shared fixture file");
  const sql = pg.psqlJson(db, `select jsonb_agg(private.assessment_compute(c -> 'worksheet', c -> 'terms', c -> 'application', c -> 'policy') order by n)
    from jsonb_array_elements(${pg.jsonLit(CASES)}) with ordinality as x(c, n);`);
  CASES.forEach((c, i) => {
    const expected = c.expected;
    assert.deepEqual(Object.keys(expected).sort(), [...COMPUTED_KEYS].sort(), `${c.name}: the contract's computed keys`);
    assert.deepEqual(expected.rules.map((r) => [r.code, r.class]), RULES, `${c.name}: rules in the contract's table order`);
    for (const [key, cls] of [["hard_fail_codes", "hard"], ["owner_fail_codes", "owner"], ["soft_fail_codes", "soft"]]) {
      assert.deepEqual(expected[key], expected.rules.filter((r) => r.class === cls && r.result === "fail").map((r) => r.code),
        `${c.name}: ${key} follow the rules`);
    }
    assert.deepEqual(sql[i], expected, `${c.name}: SQL private.assessment_compute`);
    assert.deepEqual(QS.compute(c.worksheet, c.terms, c.application, c.policy), expected, `${c.name}: console QSCredit.compute`);
  });
  // The live policy row is the one the fixtures assume (70 %, no bureau, N$100,000).
  const policy = pg.psqlJson(db, "select private.policy_json();");
  for (const [k, v] of Object.entries(CASES[0].policy)) assert.equal(policy[k], v, `credit_policy.${k}`);
});

// ---- seeded fuzz: the two implementations must agree on anything ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two kinds of case: "ordinary" ones shaped like a real payslip and budget
// (so plenty pass, fail only on affordability, or sit on a rule's edge) and
// "wild" ones with the inputs nobody should send (text, null, missing
// sections, impossible dates) — both sides must still agree on those.
function fuzzCases(seed, count) {
  const rnd = mulberry32(seed);
  const chance = (p) => rnd() < p;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  // A figure to the N$50, the dollar, the cent, or a third decimal (half cents).
  const shape = (x) => pick([() => Math.round(x / 50) * 50, () => Math.round(x), () => Math.round(x * 100) / 100,
    () => Math.round(x), () => Math.round(x * 1000) / 1000])();
  const money = (max) => shape(rnd() * max);
  const odd = (max) => pick([0, null, undefined, String(Math.round(rnd() * max)), -Math.round(rnd() * 100), money(max)]);
  const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const addMonthsClamped = (s, n) => {
    const [y, m, d] = s.split("-").map(Number);
    const k = y * 12 + (m - 1) + n, ny = Math.floor(k / 12), nm = k - ny * 12 + 1;
    return iso(ny, nm, Math.min(d, lastDay(ny, nm)));
  };
  const date = () => {
    const y = pick([2026, 2027, 2028]), m = int(1, 12), last = lastDay(y, m);
    return iso(y, m, chance(0.3) ? last : int(1, last));
  };
  const badDate = () => pick(["", null, undefined, "2026-02-30", "2026-9-1", "28/09/2026", 20261028, "2026-13-01"]);
  const range = (prefix, from, to, gen) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [`${prefix}${from + i}`, gen(i)]));

  const out = [];
  for (let n = 0; n < count; n += 1) {
    const wild = chance(0.3);
    const bool = (pTrue) => (wild && chance(0.15) ? pick([null, "true", 1, "yes", undefined]) : chance(pTrue));
    const num = (x) => (wild && chance(0.15) ? odd(x) : shape(x));
    const section = (build) => (wild && chance(0.06) ? pick([null, undefined, [], "x"]) : build());

    // A payslip and a budget that hang together.
    const gross = 6000 + rnd() * 54000;
    const net = gross * (0.72 + rnd() * 0.16);
    const living = net * (0.2 + rnd() * 0.35);
    const shares = range("c", 1, 9, () => rnd());
    const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
    const worksheet = {
      docs: section(() => ({ ...range("d2_", 1, 5, () => bool(0.985)), d2_6: pick([true, false, null]), d2_7: pick([true, false, null]) })),
      verify: section(() => ({ v2_8: bool(0.95), v2_9: bool(0.95), v2_10: bool(0.95), v2_11: "" })),
      bureau: section(() => ({ used: pick([null, true, true, false, "yes"]), date: pick([null, "", "   ", "2026-09-01", "2026-09-01", 0, 20260901]),
        ref: pick([null, "", "TU-12345", "TU-12345", "\n", 0, 7, true]), open_accounts: null, monthly_commitments: null, adverse: null,
        enquiries_3m: null, agrees: null, explain: "" })),
      income: section(() => ({ a1: num(gross), a2: num(gross * (0.08 + rnd() * 0.12)), a3: num(gross * rnd() * 0.08),
        a5: num(net * (0.85 + rnd() * 0.2)), a7: chance(0.8) ? 0 : num(3000), irregular: bool(0.06), a11: num(net * 0.8), notes: "" })),
      commitments: section(() => ({ ...range("b", 1, 11, () => (chance(0.8) ? 0 : num(net * 0.08))), b11_desc: "" })),
      living: section(() => ({ ...range("c", 1, 9, (i) => num((living * shares[`c${i + 1}`]) / shareSum)), c9_desc: "",
        dependants: int(0, 6), credible: true, adjust_note: "" })),
      flags: section(() => ({ ...range("f8_", 1, 7, () => bool(0.08)), detail: "" })),
      conduct: section(() => ({ g9: wild ? pick(["na", "yes", "no", "", null, "NA", "Yes"]) : pick(["na", "na", "yes", "no"]),
        g10: bool(0.97), g11: bool(0.97) }))
    };

    const issue = wild && chance(0.15) ? badDate() : date();
    let due;
    const mode = rnd();
    if (typeof issue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(issue) || issue === "2026-02-30" || issue === "2026-13-01") due = date();
    else if (mode < 0.6) due = addDays(issue, pick([7, 14, 30, 30, 31, 45, 60, 90, 120, 149, 150, 151, 152, 153, 154, 180, 0, -3]));
    else if (mode < 0.9) due = addDays(addMonthsClamped(issue, int(1, 6)), pick([-1, 0, 0, 1]));
    else due = wild ? badDate() : addDays(issue, 30);
    const rate = wild ? pick([30, 25, 27.5, 12.5, 33.33, 0, 29.995, 30.01, null]) : pick([30, 30, 30, 25, 27.5, 20, 12.5, 29.99]);
    const terms = {
      principal: wild && chance(0.3) ? pick([0, null, "4000", 100000, 100000.01, 100000.005, 99999.995, 50.5, -500])
        : money(chance(0.9) ? net * 0.6 : 150000),
      interest_rate: rate,
      // A fee fits under the 30 % cap only at a lower rate; sometimes it doesn't.
      service_fee: wild ? pick([0, 50, 99.99, 0.005, null, 400]) : (rate <= 25 && chance(0.5) ? pick([50, 99.99, 150]) : pick([0, 0, 0, 0, 0, 25])),
      issue_date: issue,
      due_date: due
    };
    const application = wild ? {
      consent_bureau: pick([true, false, null, "yes"]),
      amount_requested: pick([4000, 1500.5, 0, null, "4000", 100000]),
      bank_account_no: pick(["62001234567", "", "  ", "\t", null, 0, 62001234567]),
      pay_day: pick(["25th", "", " \t ", null, 25, "Last working day"]),
      employer: pick(["Namdeb", "", null, " ", "NamPower"]),
      kin_name: pick(["Martha", "", null, "Petrus"]),
      kin_phone: pick(["085 612 3390", "", null, 815550101])
    } : {
      consent_bureau: chance(0.9), amount_requested: money(20000), bank_account_no: "62001234567", pay_day: "25th",
      employer: pick(["Namdeb", "NamPower", "Ministry of Health"]), kin_name: "Martha", kin_phone: chance(0.95) ? "085 612 3390" : ""
    };
    const policy = { ...CASES[0].policy };
    if (chance(0.3)) {
      Object.assign(policy, {
        max_share_disposable_pct: pick([70, 50, 100, 30, 65.5, 80]),
        cost_cap_pct: pick([30, 25, 30, 20]),
        max_principal: pick([100000, 50000, 20000, 5000, 2000, 100000]),
        max_term_months: pick([5, 1, 3, 4, 5]),
        bureau_required: chance(0.3),
        red_flag_threshold: pick([2, 1, 3, 2]),
        principal_round_step: pick([50, 100, 10, 1, 0.5, 50])
      });
    }
    // Round-trip through JSON so both sides see byte-identical input.
    out.push(JSON.parse(JSON.stringify({ name: `fuzz-${seed}-${n}${wild ? "-wild" : ""}`, worksheet, terms, application, policy })));
  }
  return out;
}

test(`seeded fuzz: SQL and QSCredit agree exactly on ${FUZZ_CASES} generated worksheets (seed ${FUZZ_SEED})`, () => {
  const cases = fuzzCases(FUZZ_SEED, FUZZ_CASES);
  const sql = pg.psqlJson(db, `select jsonb_agg(private.assessment_compute(c -> 'worksheet', c -> 'terms', c -> 'application', c -> 'policy') order by n)
    from jsonb_array_elements(${pg.jsonLit(cases)}) with ordinality as x(c, n);`);
  const bad = [];
  cases.forEach((c, i) => {
    const js = QS.compute(c.worksheet, c.terms, c.application, c.policy);
    try {
      assert.deepEqual(js, sql[i]);
    } catch (e) {
      const keys = COMPUTED_KEYS.filter((k) => JSON.stringify(js[k]) !== JSON.stringify(sql[i][k]));
      bad.push(`${c.name}: ${keys.map((k) => `${k} SQL ${JSON.stringify(sql[i][k])} vs JS ${JSON.stringify(js[k])}`).join("; ")}`
        + `\n  input ${JSON.stringify(c)}`);
    }
  });
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${cases.length} cases differ (first 5 shown)`);

  // And the fuzz really reaches the interesting places (only meaningful for
  // the default size; a tiny PARITY_FUZZ skips this).
  if (cases.length >= 300) {
    const seen = (pred) => sql.filter(pred).length;
    const share = (pred) => seen(pred) / cases.length;
    assert.ok(share((r) => r.hard_fail_codes.length === 0 && r.owner_fail_codes.length === 0) > 0.1, "clean passes");
    assert.ok(share((r) => r.hard_fail_codes.length === 0 && r.owner_fail_codes.length > 0) > 0.05, "above the D5 limit only");
    assert.ok(seen((r) => r.rules[4].result === "fail" && r.e10 !== null) > 10, "G3 fails with real dates");
    assert.ok(seen((r) => r.rules[2].result === "fail" && r.e1 > 0) > 10, "G1 (charges cap) fails");
    assert.ok(seen((r) => r.soft_fail_codes.length > 0) > 20, "soft fails");
  }
});

// ---- cents: the phone app's rounding on amounts it accepts -----------------
// app.js rounds with roundMoney (binary floats); the SQL rounds exact decimals
// (CONTRACT §4 r2). The phone app's loan form takes principal and rate to the
// cent (step 0.01), so a half-cent interest (N$500.05 or N$117 at 27.5 %) is a
// real input. CONTRACT §6: the per-loan maths ARE app.js loanTerms/analyzeLoan,
// so the SQL must land on the phone app's cent, not the exact one.
const EDGE_TERMS = [[500.05, 30], [117, 27.5], [1234.55, 30], [2000.1, 30], [1000, 30], [333.33, 12.5]];

test("cents: SQL loan maths (borrower history, B8) round a half-cent interest exactly like app.js (CONTRACT §6)", () => {
  need("row0");
  const data = {
    clients: [{ id: "client_edge", ref: "QS-0001", name: "Edge Case", nationalId: "80010100001", phone: "", createdAt: "" }],
    loans: EDGE_TERMS.map(([principal, rate], i) => ({ id: `loan_edge_${i}`, ref: `QSL-000${i + 1}`, status: "active",
      clientId: "client_edge", principal, interestRate: rate, serviceFee: 0, issueDate: day(-5), dueDate: day(25), createdAt: "" })),
    payments: [{ id: "payment_edge", loanId: "loan_edge_4", amount: 433.33, date: day(-1), method: "Cash", createdAt: "" }],
    expenses: [], capital: []
  };
  const phone = phoneLoans(data);
  const sql = sqlLoans(data);
  const diffs = [];
  sql.forEach((s, i) => {
    for (const [k, pk] of [["interest", "interest"], ["total_due", "totalDue"], ["outstanding", "outstanding"]]) {
      if (s[k] !== phone[i][pk]) diffs.push(`N$${EDGE_TERMS[i][0]} at ${EDGE_TERMS[i][1]}%: ${k} SQL ${s[k]} vs app.js ${phone[i][pk]}`);
    }
  });
  assert.deepEqual(diffs, [], "private.ledger_loans differs from app.js loanTerms/analyzeLoan");
});

// The desk's E7 is exact r2 (CONTRACT §4), the phone's total due is roundMoney
// (§6); on a half-cent interest they part by N$0.01 (N$500.05 at 30 %: desk
// 650.07, phone 650.06). So the desk refuses such terms where they become
// binding (recommending approval, approving, paying out:
// private.check_bookable_terms), and on every term it accepts the two agree.
const notes = [];
function deskAccepts(terms) {
  const r = pg.psqlRaw(db, ["-A", "-t"], `select private.check_bookable_terms(${pg.jsonLit(terms)});`);
  if (r.code === 0) return true;
  assert.match(r.stderr, /QS_INVALID: At [0-9.]+% the interest on N\$[0-9,.]+ comes to N\$[0-9.]+, which is not a whole number of cents/,
    "refused with the plain-English QS_INVALID");
  return false;
}
test("cents: the desk only books terms the phone app collects to the same cent (E7 = total due; half-cent interest refused)", () => {
  need("row0");
  const app = loadApp();
  EDGE_TERMS.forEach(([principal, rate]) => {
    const e7 = QS.compute({}, { principal, interest_rate: rate, service_fee: 0 }, {}, CASES[0].policy).e7;
    const due = app.run(`loanTerms({ principal: ${principal}, interestRate: ${rate}, serviceFee: 0 }).totalDue`);
    // Exact: principal (cents) × rate (hundredths of a percent) is a whole
    // number of cents when divisible by 10,000.
    const whole = (Math.round(principal * 100) * Math.round(rate * 100)) % 10000 === 0;
    const ok = deskAccepts({ principal, interest_rate: rate, service_fee: 0 });
    assert.equal(ok, whole, `N$${principal} at ${rate}%: accepted exactly when the interest is a whole cent`);
    if (ok) assert.equal(e7, due, `N$${principal} at ${rate}%: desk E7 = phone total due`);
    else notes.push(`N$${principal} at ${rate}%: refused by the desk, the interest is not a whole cent (desk E7 ${e7}, phone ${due})`);
  });
  // A sweep in plain JS: whenever the interest is a whole number of cents,
  // app.js roundMoney lands on the exact figure too, so the guard is enough.
  let checked = 0;
  for (const R of [3000, 2750, 2500, 2222, 1999, 1250, 100]) {
    for (let P = 1; P <= 10000000; P += 97) {
      if ((P * R) % 10000 !== 0) continue;
      const principal = P / 100, rate = R / 100;
      const interest = roundMoney((roundMoney(principal) * rate) / 100);
      const total = roundMoney(roundMoney(principal) + roundMoney(interest));
      assert.equal(Math.round(total * 100), P + (P * R) / 10000, `N$${principal} at ${rate}%`);
      checked += 1;
    }
  }
  assert.ok(checked > 10000, `sweep covered ${checked} bookable terms`);
});

// ---- report ----------------------------------------------------------------

pg.stop();
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`      ${String(r.error.message).split("\n").join("\n      ")}`);
});
for (const n of notes) console.log(`NOTE  ${n}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
