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

test("cash trail: clean history never dips below zero", () => {
  const app = loadApp();
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 15000, date: "2026-01-05", note: "", createdAt: "" }],
    loans: [loan({ principal: 1000, issueDate: "2026-03-01" })]
  }));
  const trail = JSON.parse(app.run(`JSON.stringify(cashTrail())`));
  assert.strictEqual(trail.dips.length, 0, "no negative dips");
  assert.strictEqual(trail.lowest.balance, 14000, "lowest is after the loan goes out");
  assert.strictEqual(trail.closing, 14000);
});

test("cash trail: lending before the money arrives is caught", () => {
  const app = loadApp();
  // A 5,000 loan on 1 Mar, but capital only recorded on 1 Jun — impossible.
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 15000, date: "2026-06-01", note: "", createdAt: "" }],
    loans: [loan({ principal: 5000, issueDate: "2026-03-01" })]
  }));
  const trail = JSON.parse(app.run(`JSON.stringify(cashTrail())`));
  assert.strictEqual(trail.dips.length, 1, "one movement leaves the float negative");
  assert.strictEqual(trail.firstDip.balance, -5000, "shortfall equals the unfunded loan");
  assert.strictEqual(trail.firstDip.date, "2026-03-01", "flags the date money must have gone in by");
  assert.strictEqual(trail.closing, 10000, "closing still reconciles despite the dip");
});

test("starting capital folds into the ledger without moving any balance", () => {
  const app = loadApp();
  const legacy = baseState({
    settings: { ...baseState().settings, startingCapital: 5000, startingCapitalDate: "2026-01-01" },
    loans: [loan({ principal: 1000, issueDate: "2026-03-01" })]
  });
  app.run(`state = normalizeState(${JSON.stringify(legacy)})`);
  const after = JSON.parse(app.run(`JSON.stringify({
    setting: state.settings.startingCapital,
    capital: state.capital,
    cash: cashOnHand(),
    injected: capitalInjected(),
    net: netCapital()
  })`));

  assert.strictEqual(after.setting, 0, "legacy setting cleared");
  assert.strictEqual(after.capital.length, 1, "one opening entry created");
  assert.strictEqual(after.capital[0].amount, 5000);
  assert.strictEqual(after.capital[0].date, "2026-01-01", "keeps the recorded as-of date");
  assert.strictEqual(after.capital[0].origin, "starting-capital");
  // The whole point: representation changed, money did not.
  assert.strictEqual(after.cash, 4000, "5000 opening less 1000 lent — same as before the move");
  assert.strictEqual(after.injected, 5000, "opening float now counts as capital added");
  assert.strictEqual(after.net, 5000);
});

test("starting capital migration is idempotent", () => {
  const app = loadApp();
  const legacy = baseState({
    settings: { ...baseState().settings, startingCapital: 5000, startingCapitalDate: "2026-01-01" }
  });
  app.run(`state = normalizeState(normalizeState(${JSON.stringify(legacy)}))`);
  assert.strictEqual(app.run(`state.capital.length`), 1, "a second pass must not add a duplicate");
  assert.strictEqual(app.run(`cashOnHand()`), 5000);
});

test("no legacy starting capital leaves existing entries untouched", () => {
  const app = loadApp();
  const current = baseState({
    capital: [{ id: "k1", direction: "in", amount: 15000, date: "2026-06-26", note: "Business", createdAt: "" }]
  });
  app.run(`state = normalizeState(${JSON.stringify(current)})`);
  assert.strictEqual(app.run(`state.capital.length`), 1, "nothing invented");
  assert.strictEqual(app.run(`capitalInjected()`), 15000);
  assert.strictEqual(app.run(`cashOnHand()`), 15000);
});

test("opening float with no as-of date lands before the first movement", () => {
  const app = loadApp();
  const legacy = baseState({
    settings: { ...baseState().settings, startingCapital: 2000, startingCapitalDate: "" },
    loans: [loan({ principal: 500, issueDate: "2026-03-10" })]
  });
  app.run(`state = normalizeState(${JSON.stringify(legacy)})`);
  const date = app.run(`state.capital[0].date`);
  assert.strictEqual(date, "2026-03-09", "dated a day before the first loan, so the ledger never dips");
  const trail = JSON.parse(app.run(`JSON.stringify(cashTrail())`));
  assert.strictEqual(trail.dips.length, 0, "migrated opening float must not create a phantom negative dip");
});

test("projection: overdue money is expected now, not left in the past", () => {
  const app = loadApp();
  // Due in March, still unpaid. "Now" is whatever today is, always later.
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30, dueDate: "2026-03-31" })],
    settings: { ...baseState().settings, projection: { recoveryRate: 100, redeployRate: 0, monthlyCosts: 0, months: 3 } }
  }));
  const { rows } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(rows[0].due, 1300, "arrears surface in the first month, not a past one");
  const later = rows.slice(1).reduce((sum, r) => sum + r.due, 0);
  assert.strictEqual(later, 0, "and are not double-counted later");
});

test("projection: a loan due next month lands in that month", () => {
  const app = loadApp();
  const nextMonth = app.run(`addMonths(monthKey(new Date()), 1) + "-15"`);
  app.setState(baseState({
    loans: [loan({ principal: 2000, interestRate: 30, dueDate: nextMonth })],
    settings: { ...baseState().settings, projection: { recoveryRate: 100, redeployRate: 0, monthlyCosts: 0, months: 3 } }
  }));
  const { rows } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(rows[0].due, 0, "nothing due this month");
  assert.strictEqual(rows[1].due, 2600, "2000 principal + 30% lands next month");
});

test("projection: recovery rate is a real loss, not a deferral", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30, dueDate: "2026-03-31" })],
    settings: { ...baseState().settings, projection: { recoveryRate: 50, redeployRate: 0, monthlyCosts: 0, months: 4 } }
  }));
  const { rows } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(rows[0].inflow, 650, "half of 1300 arrives");
  const totalIn = rows.reduce((sum, r) => sum + r.inflow, 0);
  assert.strictEqual(totalIn, 650, "the other half is lost, never collected later");
});

test("projection: recycling compounds at the book's own rate", () => {
  const app = loadApp();
  // No loans at all: pure recycling of cash, so the maths is checkable by hand.
  app.setState(baseState({
    settings: {
      ...baseState().settings,
      startingCapital: 0,
      projection: { recoveryRate: 100, redeployRate: 100, monthlyCosts: 0, months: 3 }
    },
    capital: [{ id: "k1", direction: "in", amount: 1000, date: "2026-01-01", note: "", createdAt: "" }]
  }));
  const { rows, ratePercent } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(ratePercent, 30, "no loans on the book falls back to 30%");
  // Month 0: lend all 1000. Month 1: 1300 back, lend all. Month 2: 1690 back.
  assert.strictEqual(rows[0].lend, 1000);
  assert.strictEqual(rows[1].inflow, 1300);
  assert.strictEqual(rows[2].inflow, 1690);
  assert.strictEqual(rows[2].working, 1690, "working capital tracks the compounding");
});

test("projection: costs and idle cash are not lent out twice", () => {
  const app = loadApp();
  app.setState(baseState({
    settings: {
      ...baseState().settings,
      projection: { recoveryRate: 100, redeployRate: 50, monthlyCosts: 100, months: 2 }
    },
    capital: [{ id: "k1", direction: "in", amount: 1000, date: "2026-01-01", note: "", createdAt: "" }]
  }));
  const { rows } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  // 1000 available, lend 50% = 500, costs 100 -> cash 400.
  assert.strictEqual(rows[0].lend, 500);
  assert.strictEqual(rows[0].closing, 400);
  assert.strictEqual(rows[0].working, 900, "cash 400 + 500 out on loan");
});

test("projection: settings are clamped, so bad input cannot invent money", () => {
  const app = loadApp();
  app.setState(baseState({
    settings: {
      ...baseState().settings,
      projection: { recoveryRate: 900, redeployRate: -50, monthlyCosts: -100, months: 999 }
    }
  }));
  const cfg = JSON.parse(app.run(`JSON.stringify(projectionSettings())`));
  assert.strictEqual(cfg.recoveryRate, 100, "cannot collect more than is owed");
  assert.strictEqual(cfg.redeployRate, 0, "cannot lend a negative share");
  assert.strictEqual(cfg.monthlyCosts, 0, "costs cannot be negative income");
  assert.strictEqual(cfg.months, 24, "horizon capped");
});

test("projection: paid and written-off loans are not projected as income", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [
      loan({ id: "l1", principal: 1000, interestRate: 30, dueDate: "2026-03-31" }),
      loan({ id: "l2", principal: 5000, interestRate: 30, dueDate: "2026-03-31", status: "written-off" })
    ],
    payments: [payment({ id: "p1", loanId: "l1", amount: 1300, date: "2026-03-31" })],
    settings: { ...baseState().settings, projection: { recoveryRate: 100, redeployRate: 0, monthlyCosts: 0, months: 2 } }
  }));
  const { rows } = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  const totalDue = rows.reduce((sum, r) => sum + r.due, 0);
  assert.strictEqual(totalDue, 0, "settled loan brings nothing more, written-off brings nothing at all");
});

test("projection presets: 'all paid' really does mean nothing is written off", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30, dueDate: "2026-03-31" })]
  }));

  app.run(`applyProjectionPreset("high")`);
  const high = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(high.cfg.recoveryRate, 100);
  assert.strictEqual(high.rows[0].inflow, 1300, "the whole balance arrives");

  app.run(`applyProjectionPreset("low")`);
  const low = JSON.parse(app.run(`JSON.stringify(projectionRows())`));
  assert.strictEqual(low.cfg.recoveryRate, 70);
  assert.strictEqual(low.rows[0].inflow, 910, "70% of 1300");

  // The headline must actually move, or the control is decorative.
  assert.ok(
    high.rows[high.rows.length - 1].working > low.rows[low.rows.length - 1].working * 2,
    "collecting everything should be worth far more by the horizon"
  );
});

test("projection presets: switching does not clobber costs or horizon", () => {
  const app = loadApp();
  app.setState(baseState({
    settings: { ...baseState().settings, projection: { recoveryRate: 85, redeployRate: 85, monthlyCosts: 400, months: 9 } }
  }));
  app.run(`applyProjectionPreset("high")`);
  const cfg = JSON.parse(app.run(`JSON.stringify(projectionSettings())`));
  assert.strictEqual(cfg.monthlyCosts, 400, "costs preserved");
  assert.strictEqual(cfg.months, 9, "horizon preserved");
  assert.strictEqual(cfg.recoveryRate, 100, "only the scenario changed");
});

test("projection presets: the active one is detected, custom stays custom", () => {
  const app = loadApp();
  app.setState(baseState());
  app.run(`applyProjectionPreset("mid")`);
  assert.strictEqual(app.run(`activeProjectionPreset()`), "mid");
  app.run(`state.settings.projection = { recoveryRate: 91, redeployRate: 77, monthlyCosts: 0, months: 6 }`);
  assert.strictEqual(app.run(`activeProjectionPreset()`), "custom", "hand-set values are not mislabelled as a preset");
});

test("reconcile: a matching count reconciles to zero with no suspects", () => {
  const app = loadApp();
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 5000, date: "2026-03-01", note: "", createdAt: "" }],
    loans: [loan({ principal: 1000, issueDate: "2026-03-05" })],
    payments: [payment({ amount: 300, date: "2026-03-20" })]
  }));
  const report = JSON.parse(app.run(`JSON.stringify(reconcileReport(4300))`));
  assert.strictEqual(report.cashOnHand, 4300, "5000 in - 1000 out + 300 back");
  assert.strictEqual(report.difference, 0);
  assert.strictEqual(report.matches.length, 0, "a zero gap matches nothing");
  assert.strictEqual(report.duplicates.length, 0);
});

test("reconcile: the gap names movements of exactly its size", () => {
  const app = loadApp();
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 5000, date: "2026-03-01", note: "", createdAt: "" }],
    loans: [loan({ principal: 1000, issueDate: "2026-03-05" })],
    payments: [payment({ amount: 300, date: "2026-03-20" })]
  }));
  // Counted 300 less than the app: the 300 repayment is the prime suspect.
  const report = JSON.parse(app.run(`JSON.stringify(reconcileReport(4000))`));
  assert.strictEqual(report.difference, -300);
  assert.strictEqual(report.matches.length, 1);
  assert.strictEqual(report.matches[0].kind, "repayment");
  assert.strictEqual(report.matches[0].amount, 300);
});

test("reconcile: the same movement entered twice within days is flagged, instalments are not", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, issueDate: "2026-03-01" })],
    payments: [
      payment({ id: "p1", amount: 500, date: "2026-03-10" }),
      payment({ id: "p2", amount: 500, date: "2026-03-11" }), // suspicious echo
      payment({ id: "p3", amount: 150, date: "2026-03-17" }),
      payment({ id: "p4", amount: 150, date: "2026-03-24" }) // a week apart: instalments
    ]
  }));
  const pairs = JSON.parse(app.run(`JSON.stringify(duplicateSuspects())`));
  assert.strictEqual(pairs.length, 1, "only the day-apart echo is flagged");
  assert.strictEqual(pairs[0][0].amount, 500);
  assert.strictEqual(pairs[0][1].date, "2026-03-11");
});

test("reconcile: loans paid beyond what was due surface the excess", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30, serviceFee: 0 })], // totalDue 1300
    payments: [payment({ amount: 1500 })]
  }));
  const overpaid = JSON.parse(app.run(`JSON.stringify(overpaidLoans())`));
  assert.strictEqual(overpaid.length, 1);
  assert.strictEqual(overpaid[0].excess, 200, "1500 paid on 1300 due");
});

test("reconcile: payments with no loan still count as cash and are flagged", () => {
  const app = loadApp();
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 1000, date: "2026-03-01", note: "", createdAt: "" }],
    payments: [payment({ loanId: "ghost", amount: 250, date: "2026-03-10" })]
  }));
  assert.strictEqual(app.run(`cashOnHand()`), 1250, "the orphan moves cash");
  const orphans = JSON.parse(app.run(`JSON.stringify(orphanPayments())`));
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].amount, 250);
});

test("reconcile: the direction of the gap is counted minus cash on hand", () => {
  const app = loadApp();
  app.setState(baseState({
    capital: [{ id: "k1", direction: "in", amount: 2000, date: "2026-03-01", note: "", createdAt: "" }]
  }));
  const short = JSON.parse(app.run(`JSON.stringify(reconcileReport(1500))`));
  assert.strictEqual(short.difference, -500, "less real cash than recorded");
  const over = JSON.parse(app.run(`JSON.stringify(reconcileReport(2600))`));
  assert.strictEqual(over.difference, 600, "more real cash than recorded");
});

test("client references: backfilled in creation order, oldest gets the lowest number", () => {
  const app = loadApp();
  app.setState(baseState({
    clients: [
      { id: "c1", name: "Bravo", createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "c2", name: "Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c3", name: "Charlie", createdAt: "2026-03-01T00:00:00.000Z" }
    ]
  }));
  app.run(`assignClientRefs(state)`);
  const refs = JSON.parse(app.run(`JSON.stringify(state.clients.map((c) => [c.id, c.ref]))`));
  const byId = Object.fromEntries(refs);
  assert.strictEqual(byId.c2, "QS-0001", "earliest createdAt is QS-0001");
  assert.strictEqual(byId.c1, "QS-0002");
  assert.strictEqual(byId.c3, "QS-0003");
});

test("client references: existing refs are kept and never renumber on delete", () => {
  const app = loadApp();
  app.setState(baseState({
    clients: [
      { id: "c1", name: "Alpha", ref: "QS-0001", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c3", name: "Charlie", ref: "QS-0003", createdAt: "2026-03-01T00:00:00.000Z" }
    ]
  }));
  // c2 (QS-0002) was deleted. Backfilling must not renumber the survivors.
  app.run(`assignClientRefs(state)`);
  const refs = JSON.parse(app.run(`JSON.stringify(state.clients.map((c) => c.ref))`));
  assert.deepStrictEqual(refs, ["QS-0001", "QS-0003"]);
  // The next new client continues past the highest, not into the gap.
  assert.strictEqual(app.run(`nextClientRef()`), "QS-0004");
});

test("client references: a new client with no refs yet starts at QS-0001", () => {
  const app = loadApp();
  app.setState(baseState({ clients: [] }));
  assert.strictEqual(app.run(`nextClientRef()`), "QS-0001");
});

test("loan references: backfilled in creation order, oldest gets QSL-0001", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [
      loan({ id: "l2", createdAt: "2026-02-01T00:00:00.000Z" }),
      loan({ id: "l1", createdAt: "2026-01-01T00:00:00.000Z" }),
      loan({ id: "l3", createdAt: "2026-03-01T00:00:00.000Z" })
    ]
  }));
  app.run(`assignLoanRefs(state)`);
  const byId = Object.fromEntries(JSON.parse(app.run(`JSON.stringify(state.loans.map((l) => [l.id, l.ref]))`)));
  assert.strictEqual(byId.l1, "QSL-0001");
  assert.strictEqual(byId.l2, "QSL-0002");
  assert.strictEqual(byId.l3, "QSL-0003");
  assert.strictEqual(app.run(`nextLoanRef()`), "QSL-0004");
});

test("loan references: existing refs are kept and the next continues past the highest", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [
      loan({ id: "l1", ref: "QSL-0001", createdAt: "2026-01-01T00:00:00.000Z" }),
      loan({ id: "l3", ref: "QSL-0003", createdAt: "2026-03-01T00:00:00.000Z" })
    ]
  }));
  app.run(`assignLoanRefs(state)`);
  assert.deepStrictEqual(JSON.parse(app.run(`JSON.stringify(state.loans.map((l) => l.ref))`)), ["QSL-0001", "QSL-0003"]);
  assert.strictEqual(app.run(`nextLoanRef()`), "QSL-0004", "continues past the highest, not into the gap");
});

test("projection: an explicit cfg override models a scenario without touching saved settings", () => {
  const app = loadApp();
  app.setState(baseState({
    loans: [loan({ principal: 1000, interestRate: 30, dueDate: "2026-03-31" })],
    settings: { ...baseState().settings, projection: { recoveryRate: 100, redeployRate: 0, monthlyCosts: 0, months: 3 } }
  }));
  const override = JSON.parse(app.run(
    `JSON.stringify(projectionRows({ recoveryRate: 50, redeployRate: 0, monthlyCosts: 0, months: 3 }))`
  ));
  assert.strictEqual(override.cfg.recoveryRate, 50, "override drives the run");
  assert.strictEqual(override.rows[0].inflow, 650, "only half of 1300 arrives under the override");
  // Saved settings are left exactly as they were.
  const saved = JSON.parse(app.run(`JSON.stringify(projectionSettings())`));
  assert.strictEqual(saved.recoveryRate, 100, "saved projection settings are untouched");
});

// A fixed book with a paid loan, an overdue loan and a written-off loan, so
// every headline the investor report leans on has a hand-checkable value.
function investorState() {
  return baseState({
    clients: [
      { id: "c1", name: "SECRET_NAME_ALPHA", phone: "264811111111", nationalId: "ID-AAA-111", createdAt: "" },
      { id: "c2", name: "SECRET_NAME_BRAVO", phone: "264822222222", nationalId: "ID-BBB-222", createdAt: "" },
      { id: "c3", name: "SECRET_NAME_CHARLIE", phone: "264833333333", nationalId: "ID-CCC-333", createdAt: "" }
    ],
    loans: [
      loan({ id: "l1", clientId: "c1", principal: 1000, interestRate: 30, issueDate: "2026-03-01", dueDate: "2026-03-31" }),
      loan({ id: "l2", clientId: "c2", principal: 2000, interestRate: 30, issueDate: "2026-04-01", dueDate: "2026-04-30" }),
      loan({ id: "l3", clientId: "c3", principal: 500, interestRate: 30, issueDate: "2026-05-01", dueDate: "2026-05-31", status: "written-off" })
    ],
    payments: [payment({ id: "p1", loanId: "l1", amount: 1300, date: "2026-03-20" })],
    expenses: [{ id: "x1", amount: 120, date: "2026-03-25", category: "Transport", note: "", createdAt: "" }],
    capital: [{ id: "k1", direction: "in", amount: 5000, date: "2026-01-01", note: "", createdAt: "" }]
  });
}

test("investor report: lifetime and position figures reconcile", () => {
  const app = loadApp();
  app.setState(investorState());
  const r = JSON.parse(app.run(`JSON.stringify(investorReport())`));

  assert.strictEqual(r.isEmpty, false);
  // Lifetime activity
  assert.strictEqual(r.advanced, 3500, "1000 + 2000 + 500 lent");
  assert.strictEqual(r.collected, 1300);
  assert.strictEqual(r.revenue, 300, "interest portion collected on the paid loan");
  assert.strictEqual(r.expenses, 120);
  assert.strictEqual(r.netProfit, 180, "300 revenue - 120 expenses");
  assert.strictEqual(r.principalRecovered, 1000);
  assert.strictEqual(r.loansIssued, 3);
  assert.strictEqual(r.clientsServed, 3);
  assert.strictEqual(r.paidLoans, 1);

  // Position today
  assert.strictEqual(r.outstanding, 2600, "only the overdue loan is still collectable");
  assert.strictEqual(r.capitalOut, 2000, "written-off principal excluded");
  assert.strictEqual(r.overdue, 2600);
  assert.strictEqual(r.overdueLoans, 1);
  assert.strictEqual(r.activeClients, 1, "only the client with an open balance");

  // Capital and cash
  assert.strictEqual(r.capitalInjected, 5000);
  assert.strictEqual(r.netCapital, 5000);
  assert.strictEqual(r.cashOnHand, 2680, "5000 in + 1300 back - 3500 out - 120 costs");
  assert.strictEqual(r.outOnLoan, 2000);
  assert.strictEqual(r.totalFunds, 4680, "cash on hand + out on loan");
});

test("investor report: quality and return ratios", () => {
  const app = loadApp();
  app.setState(investorState());
  const r = JSON.parse(app.run(`JSON.stringify(investorReport())`));

  assert.strictEqual(r.repaidRate, 33.33, "1 of 3 loans fully paid");
  assert.strictEqual(r.overdueShare, 100, "all of what is outstanding is overdue");
  assert.strictEqual(r.writeOffRate, 14.29, "500 lost of 3500 lent");
  assert.strictEqual(r.writtenOffPrincipal, 500);
  assert.strictEqual(r.writtenOffLoans, 1);
  assert.strictEqual(r.collectionRate, 28.57, "1300 paid of 4550 total due");
  assert.strictEqual(r.grossYield, 8.57, "300 revenue per 3500 lent");
  assert.strictEqual(r.returnOnCapital, 3.6, "180 profit on 5000 capital");
  assert.strictEqual(r.avgMonthlyProfit, roundish(180 / r.monthsActive), "profit spread over months active");
  assert.strictEqual(r.trailSound, true, "the recorded float never goes negative");
});

test("investor report: carries no client PII, in the data or the rendered text", () => {
  const app = loadApp();
  app.setState(investorState());

  const asJson = app.run(`JSON.stringify(investorReport())`);
  const asText = app.run(`investorReportText(investorReport())`);
  const asDoc = app.run(`investorReportDocument(investorReport())`);

  ["SECRET_NAME_ALPHA", "SECRET_NAME_BRAVO", "SECRET_NAME_CHARLIE",
   "264811111111", "264822222222", "264833333333",
   "ID-AAA-111", "ID-BBB-222", "ID-CCC-333"].forEach((secret) => {
    assert.ok(!asJson.includes(secret), `report object must not leak ${secret}`);
    assert.ok(!asText.includes(secret), `report text must not leak ${secret}`);
    assert.ok(!asDoc.includes(secret), `report document must not leak ${secret}`);
  });
});

test("investor report: an empty book reports nothing rather than dividing by zero", () => {
  const app = loadApp();
  app.setState(baseState({ clients: [], loans: [], payments: [], expenses: [], capital: [] }));
  const r = JSON.parse(app.run(`JSON.stringify(investorReport())`));
  assert.strictEqual(r.isEmpty, true);
  assert.strictEqual(r.loansIssued, 0);
  assert.strictEqual(r.returnOnCapital, 0, "no capital, no divide-by-zero");
  assert.strictEqual(r.collectionRate, 0);
  assert.strictEqual(r.avgMonthlyProfit, 0);
  assert.ok(r.monthsActive >= 1, "months active never drops below one");
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
