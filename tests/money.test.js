// Money-maths regression tests.
//
// These load the real app.js in a VM sandbox (no DOM) and drive its actual
// functions, so they test the shipped code rather than a copy of the logic.
// app.js only boots when `document` exists, which is why this works.
//
//   node tests/money.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const APP = path.join(__dirname, "..", "app.js");

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

// Fresh sandbox per test so state never leaks between cases.
function loadApp() {
  const context = vm.createContext({
    console,
    Intl,
    Date,
    Math,
    JSON,
    localStorage: memoryStorage(),
    navigator: { language: "en-NA" }
  });
  vm.runInContext(fs.readFileSync(APP, "utf8"), context, { filename: "app.js" });
  return {
    run: (expr) => vm.runInContext(expr, context),
    setState: (next) => vm.runInContext(`state = ${JSON.stringify(next)}`, context)
  };
}

const ISO = (d) => d;

function baseState(overrides = {}) {
  return {
    version: 1,
    settings: {
      companyName: "Quickserve",
      currency: "N$",
      startingCapital: 0,
      startingCapitalDate: "",
      lastBackupAt: "",
      lastBackupCount: 0
    },
    clients: [{ id: "c1", name: "Test Client", createdAt: "2026-01-01T00:00:00.000Z" }],
    loans: [],
    payments: [],
    expenses: [],
    capital: [],
    imports: [],
    ...overrides
  };
}

function loan(props = {}) {
  return {
    id: "l1",
    status: "active",
    clientId: "c1",
    principal: 1000,
    interestRate: 30,
    serviceFee: 0,
    issueDate: ISO("2026-03-01"),
    dueDate: ISO("2026-03-31"),
    purpose: "Test",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...props
  };
}

function payment(props = {}) {
  return {
    id: "p1",
    loanId: "l1",
    amount: 100,
    date: ISO("2026-03-10"),
    method: "Cash",
    reference: "",
    notes: "",
    createdAt: "2026-03-10T00:00:00.000Z",
    ...props
  };
}

// ---- tiny runner ----
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ---------------------------------------------------------------------------

test("loan terms: interest is a flat % of principal, plus fees", () => {
  const app = loadApp();
  app.setState(baseState({ loans: [loan({ principal: 1000, interestRate: 30, serviceFee: 50 })] }));
  const terms = app.run(`JSON.stringify(loanTerms(getLoan("l1")))`);
  const t = JSON.parse(terms);
  assert.strictEqual(t.interest, 300, "30% of 1000");
  assert.strictEqual(t.fees, 50);
  assert.strictEqual(t.revenueDue, 350, "interest + fees");
  assert.strictEqual(t.totalDue, 1350, "principal + revenue due");
});

test("allocation: payments clear interest and fees before principal", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30 })], // revenueDue 300, totalDue 1300
    payments: [
      payment({ id: "p1", amount: 200, date: "2026-03-05" }),
      payment({ id: "p2", amount: 200, date: "2026-03-06" })
    ]
  }));
  const rows = JSON.parse(app.run(
    `JSON.stringify(allocateLoanPayments(getLoan("l1")).map(r => ({ revenue: r.revenue, principal: r.principal })))`
  ));
  assert.deepStrictEqual(rows[0], { revenue: 200, principal: 0 }, "first 200 is all revenue");
  assert.deepStrictEqual(rows[1], { revenue: 100, principal: 100 }, "revenue tops out at 300, rest is principal");
});

test("overpayment: outstanding floors at zero and excess is tracked", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30 })], // totalDue 1300
    payments: [payment({ amount: 1500 })]
  }));
  const row = JSON.parse(app.run(`JSON.stringify(analyzeLoan(getLoan("l1")))`));
  assert.strictEqual(row.outstanding, 0, "never negative");
  assert.strictEqual(row.status, "paid");
  assert.strictEqual(row.allocations[0].excess, 200, "1500 - 1300");
});

test("rollover: adds an interest cycle without inventing cash movement", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({
      principal: 1000,
      interestRate: 30,
      extensions: [{ id: "e1", date: "2026-04-01", addedInterest: 300, previousDueDate: "2026-03-31", newDueDate: "2026-04-30" }]
    })]
  }));
  const terms = JSON.parse(app.run(`JSON.stringify(loanTerms(getLoan("l1")))`));
  assert.strictEqual(terms.extensionInterest, 300);
  assert.strictEqual(terms.revenueDue, 600, "base 300 + rollover 300");
  assert.strictEqual(terms.totalDue, 1600);

  // The rollover must not look like a second disbursement.
  const outflows = JSON.parse(app.run(
    `JSON.stringify(cashMovements().filter(m => m.kind === "loan-out").map(m => m.amount))`
  ));
  assert.deepStrictEqual(outflows, [-1000], "exactly one loan-out, unchanged by the rollover");
});

test("written-off principal leaves the float", () => {
  const app = loadApp();
  app.setState(baseState({ loans: [loan({ status: "written-off", principal: 1000 })] }));
  const outOnLoan = app.run(`outOnLoan()`);
  const analysis = JSON.parse(app.run(`JSON.stringify(analyzeLoan(getLoan("l1")))`));
  assert.strictEqual(analysis.status, "written-off");
  assert.strictEqual(analysis.collectableOutstanding, 0, "not collectable");
  assert.strictEqual(outOnLoan, 0, "written-off principal is a realised loss, not float");
});

test("float reconciles: total funds == capital + profit collected - expenses", () => {
  const app = loadApp();
  app.setState(baseState({
    settings: { ...baseState().settings, startingCapital: 500 },
    loans: [
      loan({ id: "l1", principal: 1000, interestRate: 30, issueDate: "2026-03-01" }),
      loan({ id: "l2", principal: 400, interestRate: 30, issueDate: "2026-04-01", dueDate: "2026-04-30" })
    ],
    payments: [payment({ id: "p1", loanId: "l1", amount: 1300, date: "2026-03-20" })],
    expenses: [{ id: "x1", amount: 120, date: "2026-03-25", category: "Transport", createdAt: "" }],
    capital: [{ id: "k1", direction: "in", amount: 2000, date: "2026-03-02", note: "", createdAt: "" }]
  }));

  const totalFunds = app.run(`totalFunds()`);
  const cash = app.run(`cashOnHand()`);
  const out = app.run(`outOnLoan()`);
  const profit = app.run(
    `roundMoney(allPaymentAllocations().reduce((s, r) => s + r.revenue, 0))`
  );

  assert.strictEqual(roundish(cash + out), roundish(totalFunds), "total funds is cash + out on loan");

  const expected = 500 /* starting */ + 2000 /* capital in */ - 0 /* capital out */
    + profit - 120 /* expenses */;
  assert.strictEqual(
    roundish(totalFunds),
    roundish(expected),
    `float must reconcile: got ${totalFunds}, expected ${expected}`
  );
});

test("period figures: collections, revenue and cash out are scoped to the month", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [
      loan({ id: "l1", principal: 1000, interestRate: 30, issueDate: "2026-03-01" }),
      loan({ id: "l2", principal: 500, interestRate: 30, issueDate: "2026-04-01", dueDate: "2026-04-30" })
    ],
    payments: [
      payment({ id: "p1", loanId: "l1", amount: 1300, date: "2026-03-20" }),
      payment({ id: "p2", loanId: "l2", amount: 100, date: "2026-04-05" })
    ]
  }));
  const march = JSON.parse(app.run(`JSON.stringify(figuresFor("month", "2026-03", "2026"))`));
  assert.strictEqual(march.collections, 1300, "only March money in");
  assert.strictEqual(march.cashOut, 1000, "only March loans issued");
  assert.strictEqual(march.revenue, 300, "interest+fees portion collected in March");
  assert.strictEqual(march.principalRecovered, 1000);
});

test("phone normalising keeps explicit country codes intact", () => {
  const app = loadApp();
  app.setState(baseState());
  assert.strictEqual(app.run(`normalisePhone("0811234567")`), "264811234567", "local NA");
  assert.strictEqual(app.run(`normalisePhone("+27 82 555 1234")`), "27825551234", "explicit +27 not forced to 264");
  assert.strictEqual(app.run(`normalisePhone("00264811234567")`), "264811234567");
  assert.strictEqual(app.run(`normalisePhone("")`), "");
});

test("backup staleness escalates with age", () => {
  const app = loadApp();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  app.setState(baseState({ loans: [loan()] , settings: { ...baseState().settings, lastBackupAt: "", lastBackupCount: 0 } }));
  assert.strictEqual(JSON.parse(app.run(`JSON.stringify(backupStatus())`)).level, "danger", "never backed up");

  app.setState(baseState({ loans: [loan()], settings: { ...baseState().settings, lastBackupAt: daysAgo(9), lastBackupCount: 2 } }));
  assert.strictEqual(JSON.parse(app.run(`JSON.stringify(backupStatus())`)).level, "warn", "9 days");

  app.setState(baseState({ loans: [loan()], settings: { ...baseState().settings, lastBackupAt: daysAgo(20), lastBackupCount: 2 } }));
  assert.strictEqual(JSON.parse(app.run(`JSON.stringify(backupStatus())`)).level, "danger", "20 days");

  // Genuinely empty ledger — clients count as records, so clear them too.
  app.setState(baseState({ clients: [], settings: { ...baseState().settings, lastBackupAt: daysAgo(60) } }));
  assert.strictEqual(app.run(`backupStatus()`), null, "no records means nothing to warn about");
});

// Money comparisons: guard against float dust.
function roundish(value) {
  return Math.round(value * 100) / 100;
}

// ---- report ----
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`      ${r.error.message}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
