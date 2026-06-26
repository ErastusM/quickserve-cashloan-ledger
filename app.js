const STORAGE_KEY = "quickserve_cashloan_v1";
const UI_STORAGE_KEY = "quickserve_cashloan_ui_v1";
const currency = "N$";
const moneyFormat = new Intl.NumberFormat("en-NA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const dateFormat = new Intl.DateTimeFormat("en-NA", {
  day: "2-digit",
  month: "short",
  year: "numeric"
});
const monthFormat = new Intl.DateTimeFormat("en-NA", {
  month: "long",
  year: "numeric"
});
const monthShortFormat = new Intl.DateTimeFormat("en-NA", {
  month: "short"
});
const percentFormat = new Intl.NumberFormat("en-NA", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const icons = {
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M5 7v12h14V7"/><path d="M8 7V4h8v3"/><path d="M10 12h4"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-15.2 6.5"/><path d="M3 12A9 9 0 0 1 18.2 5.5"/><path d="M3 19v-5h5"/><path d="M21 5v5h-5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M3 21a6 6 0 0 1 12 0"/><path d="M19 8v6"/><path d="M16 11h6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M3 21a6 6 0 0 1 12 0"/><path d="M16 11a4 4 0 0 0 0-6"/><path d="M18 21a6 6 0 0 0-3-5.2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13"/><path d="M16 13h5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6"/><path d="M10 17h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 11 7.6-3.8"/><path d="m8.2 13 7.6 3.8"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12 12 3h7v7l-9 9z"/><circle cx="15.5" cy="8.5" r="1.4"/></svg>',
  backspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8L2 12Z"/><path d="m11 9 6 6"/><path d="m17 9-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="9" cy="6.5" rx="6" ry="3"/><path d="M3 6.5v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/><path d="M9 14.5v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.7-2.7-3-6-3"/></svg>',
  arrowIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 7 8 16"/><path d="M16 16H8V8"/></svg>',
  arrowOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 17 9-9"/><path d="M8 8h8v8"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>'
};

const aliasIcons = {
  "user-plus": icons.userPlus,
  "file-text": icons.fileText
};

const SPREADSHEET_IMPORT_ID = "cash_loan_clients_clean_2026_march_july_v1";
const viewRoutes = {
  dashboardView: "dashboard",
  clientsView: "clients",
  loansView: "loans",
  paymentsView: "payments",
  reportsView: "reports"
};
const routeViews = Object.fromEntries(Object.entries(viewRoutes).map(([view, route]) => [route, view]));

let state = loadState();
applySpreadsheetImport();
const savedUi = loadUiState();
const ui = {
  activeView: initialView(savedUi),
  clientSearch: "",
  loanFilter: "all",
  loanMonth: savedUi.loanMonth || "all",
  paymentMonth: savedUi.paymentMonth || "all",
  reportMonth: savedUi.reportMonth || monthKey(new Date()),
  reportYear: savedUi.reportYear || String(new Date().getFullYear()),
  reportScope: ["month", "year", "all"].includes(savedUi.reportScope) ? savedUi.reportScope : "month",
  theme: ["light", "dark", "auto"].includes(savedUi.theme) ? savedUi.theme : "auto"
};

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

function emptyState() {
  return {
    version: 1,
    settings: { companyName: "Quickserve", currency, startingCapital: 0, startingCapitalDate: "" },
    clients: [],
    loans: [],
    payments: [],
    expenses: [],
    capital: [],
    imports: []
  };
}

function normalizeState(value) {
  const base = emptyState();
  return {
    ...base,
    ...value,
    settings: { ...base.settings, ...(value.settings || {}) },
    clients: Array.isArray(value.clients) ? value.clients : [],
    loans: Array.isArray(value.loans) ? value.loans : [],
    payments: Array.isArray(value.payments) ? value.payments : [],
    expenses: Array.isArray(value.expenses) ? value.expenses : [],
    capital: Array.isArray(value.capital) ? value.capital : [],
    imports: Array.isArray(value.imports) ? value.imports : []
  };
}

function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function initialView(saved = {}) {
  const route = location.hash.replace("#", "").trim();
  if (routeViews[route]) return routeViews[route];
  if (viewRoutes[saved.activeView]) return saved.activeView;
  return "dashboardView";
}

function saveUiState() {
  localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
    activeView: ui.activeView,
    loanMonth: ui.loanMonth,
    paymentMonth: ui.paymentMonth,
    reportMonth: ui.reportMonth,
    reportYear: ui.reportYear,
    reportScope: ui.reportScope,
    theme: ui.theme
  }));
}

function applySpreadsheetImport() {
  const rows = Array.isArray(window.quickserveHistoricalRows) ? window.quickserveHistoricalRows : [];
  if (!rows.length) return false;

  const now = new Date().toISOString();
  const clientIds = new Map(state.clients.map((client) => [client.name.toLowerCase(), client.id]));
  let changed = false;

  rows.forEach((row) => {
    const clientName = cleanText(row.client);
    const clientKey = clientName.toLowerCase();
    let clientId = clientIds.get(clientKey);

    if (!clientId) {
      clientId = uniqueRecordId("client", clientName, state.clients);
      state.clients.push({
        id: clientId,
        createdAt: now,
        name: clientName,
        phone: "",
        nationalId: "",
        employer: "",
        address: "",
        nextOfKin: "",
        notes: "Imported from cash_loan_clients_clean.xlsx."
      });
      clientIds.set(clientKey, clientId);
      changed = true;
    }

    const loanId = `loan_${slug(row.loanId)}`;
    const paymentId = `payment_${slug(row.loanId)}`;
    if (!state.loans.some((loan) => loan.id === loanId)) {
      const principal = roundMoney(row.principal);
      const toReturn = roundMoney(row.toReturn);
      const interestRate = roundMoney(row.interestRate ?? 30);
      const interest = roundMoney((principal * interestRate) / 100);
      const serviceFee = roundMoney(toReturn - principal - interest);
      const issueDate = `2026-${String(row.monthNumber).padStart(2, "0")}-01`;
      const dueDate = monthEnd(2026, row.monthNumber);

      state.loans.push({
        id: loanId,
        createdAt: now,
        status: "active",
        clientId,
        principal,
        interestRate,
        serviceFee,
        issueDate,
        dueDate,
        purpose: `${row.month} cashloan`
      });
      changed = true;
    }

    if (roundMoney(row.returned) > 0 && !state.payments.some((payment) => payment.id === paymentId)) {
      state.payments.push({
        id: paymentId,
        loanId,
        amount: roundMoney(row.returned),
        date: monthEnd(2026, row.monthNumber),
        method: "Historical",
        reference: row.loanId,
        notes: importNote(row),
        createdAt: now
      });
      changed = true;
    }
  });

  if (!state.imports.includes(SPREADSHEET_IMPORT_ID)) {
    state.imports.push(SPREADSHEET_IMPORT_ID);
    changed = true;
  }

  if (changed) saveState();
  return changed;
}

function importNote(row) {
  return [
    "Imported from cash_loan_clients_clean.xlsx.",
    row.paymentStatus ? `Payment status: ${row.paymentStatus}.` : "",
    row.returnDataStatus ? `Return data status: ${row.returnDataStatus}.` : "",
    row.note || ""
  ].filter(Boolean).join(" ");
}

function uniqueRecordId(prefix, label, records) {
  const base = `${prefix}_${slug(label)}`;
  let candidate = base;
  let count = 2;
  while (records.some((record) => record.id === candidate)) {
    candidate = `${base}_${count}`;
    count += 1;
  }
  return candidate;
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function money(value) {
  return `${currency} ${moneyFormat.format(roundMoney(value))}`;
}

function percent(value) {
  return `${percentFormat.format(roundMoney(value))}%`;
}

function todayISO() {
  const now = new Date();
  return toISODate(now);
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromISO(value) {
  if (!value) return new Date();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : dateFromISO(value);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function monthKey(value) {
  const date = value instanceof Date ? value : dateFromISO(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value) {
  return monthFormat.format(dateFromISO(`${value}-01`));
}

function monthShort(value) {
  return monthShortFormat.format(dateFromISO(`${value}-01`));
}

function addMonths(month, offset) {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(year, index - 1 + offset, 1);
  return monthKey(date);
}

function monthEnd(year, monthNumber) {
  return toISODate(new Date(Number(year), Number(monthNumber), 0));
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "record";
}

function formatDate(value) {
  if (!value) return "No date";
  return dateFormat.format(dateFromISO(value));
}

function daysUntil(value) {
  const today = dateFromISO(todayISO());
  const target = dateFromISO(value);
  return Math.ceil((target - today) / 86400000);
}

function cleanText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function iconSvg(name) {
  return icons[name] || aliasIcons[name] || "";
}

function hydrateIcons(root = document) {
  qsa("[data-icon]", root).forEach((slot) => {
    const name = slot.dataset.icon;
    slot.innerHTML = iconSvg(name);
  });
}

function getClient(clientId) {
  return state.clients.find((client) => client.id === clientId);
}

function getLoan(loanId) {
  return state.loans.find((loan) => loan.id === loanId);
}

function getClientName(clientId) {
  return getClient(clientId)?.name || "Unknown client";
}

function paymentsForLoan(loanId) {
  return state.payments
    .filter((payment) => payment.loanId === loanId)
    .sort((a, b) => {
      const byDate = String(a.date).localeCompare(String(b.date));
      if (byDate !== 0) return byDate;
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
}

function loanTerms(loan) {
  const principal = roundMoney(loan.principal);
  const interest = roundMoney((principal * Number(loan.interestRate || 0)) / 100);
  const fees = roundMoney(loan.serviceFee);
  const revenueDue = roundMoney(interest + fees);
  return {
    principal,
    interest,
    fees,
    revenueDue,
    totalDue: roundMoney(principal + revenueDue)
  };
}

function allocateLoanPayments(loan) {
  const terms = loanTerms(loan);
  let revenueLeft = terms.revenueDue;
  let principalLeft = terms.principal;
  let paidRunning = 0;

  return paymentsForLoan(loan.id).map((payment) => {
    const amount = roundMoney(payment.amount);
    const revenue = roundMoney(Math.min(amount, Math.max(0, revenueLeft)));
    revenueLeft = roundMoney(revenueLeft - revenue);
    const principal = roundMoney(Math.min(Math.max(0, amount - revenue), Math.max(0, principalLeft)));
    principalLeft = roundMoney(principalLeft - principal);
    const excess = roundMoney(Math.max(0, amount - revenue - principal));
    paidRunning = roundMoney(paidRunning + amount);

    return {
      payment,
      revenue,
      principal,
      excess,
      outstandingAfter: roundMoney(Math.max(0, terms.totalDue - paidRunning))
    };
  });
}

function analyzeLoan(loan) {
  const terms = loanTerms(loan);
  const allocations = allocateLoanPayments(loan);
  const paid = roundMoney(allocations.reduce((sum, row) => sum + Number(row.payment.amount || 0), 0));
  const revenueCollected = roundMoney(allocations.reduce((sum, row) => sum + row.revenue, 0));
  const principalRecovered = roundMoney(allocations.reduce((sum, row) => sum + row.principal, 0));
  const revenueOutstanding = roundMoney(Math.max(0, terms.revenueDue - revenueCollected));
  const principalOutstanding = roundMoney(Math.max(0, terms.principal - principalRecovered));
  const outstanding = roundMoney(Math.max(0, terms.totalDue - paid));
  const writtenOff = loan.status === "written-off" && outstanding > 0;
  const dayCount = daysUntil(loan.dueDate);
  let status = "active";

  if (outstanding <= 0) status = "paid";
  else if (writtenOff) status = "written-off";
  else if (dayCount < 0) status = "overdue";

  return {
    loan,
    terms,
    paid,
    revenueCollected,
    principalRecovered,
    revenueOutstanding,
    principalOutstanding,
    outstanding,
    collectableOutstanding: writtenOff ? 0 : outstanding,
    writtenOffOutstanding: writtenOff ? outstanding : 0,
    status,
    daysUntilDue: dayCount,
    allocations
  };
}

function allAnalyses() {
  return state.loans.map(analyzeLoan);
}

function allPaymentAllocations() {
  const rows = [];
  state.loans.forEach((loan) => {
    allocateLoanPayments(loan).forEach((allocation) => {
      rows.push({
        ...allocation,
        loan,
        client: getClient(loan.clientId)
      });
    });
  });
  return rows.sort((a, b) => String(b.payment.date).localeCompare(String(a.payment.date)));
}

function totalsFor(month = ui.reportMonth, year = ui.reportYear) {
  const analyses = allAnalyses();
  const payments = allPaymentAllocations();
  const currentMonth = month || monthKey(new Date());
  const currentYear = String(year || new Date().getFullYear());

  const paymentMonthRows = payments.filter((row) => monthKey(row.payment.date) === currentMonth);
  const paymentYearRows = payments.filter((row) => String(dateFromISO(row.payment.date).getFullYear()) === currentYear);
  const issuedMonthLoans = state.loans.filter((loan) => monthKey(loan.issueDate) === currentMonth);
  const issuedYearLoans = state.loans.filter((loan) => String(dateFromISO(loan.issueDate).getFullYear()) === currentYear);
  const issuedMonthAnalyses = analyses.filter((row) => monthKey(row.loan.issueDate) === currentMonth);
  const issuedYearAnalyses = analyses.filter((row) => String(dateFromISO(row.loan.issueDate).getFullYear()) === currentYear);
  const dueThisMonth = analyses.filter((row) => row.status !== "paid" && row.status !== "written-off" && monthKey(row.loan.dueDate) === currentMonth);
  const activeClientIds = new Set(
    analyses
      .filter((row) => row.status === "active" || row.status === "overdue")
      .map((row) => row.loan.clientId)
  );
  const monthProfitCollected = roundMoney(paymentMonthRows.reduce((sum, row) => sum + row.revenue, 0));
  const monthRevenueCollected = roundMoney(paymentMonthRows.reduce((sum, row) => sum + Number(row.payment.amount || 0), 0));
  const monthPrincipalRecovered = roundMoney(paymentMonthRows.reduce((sum, row) => sum + row.principal, 0));
  const monthAdvanced = roundMoney(issuedMonthLoans.reduce((sum, loan) => sum + Number(loan.principal || 0), 0));
  const yearProfitCollected = roundMoney(paymentYearRows.reduce((sum, row) => sum + row.revenue, 0));
  const yearRevenueCollected = roundMoney(paymentYearRows.reduce((sum, row) => sum + Number(row.payment.amount || 0), 0));
  const yearPrincipalRecovered = roundMoney(paymentYearRows.reduce((sum, row) => sum + row.principal, 0));
  const yearAdvanced = roundMoney(issuedYearLoans.reduce((sum, loan) => sum + Number(loan.principal || 0), 0));
  const monthExpectedProfit = roundMoney(issuedMonthAnalyses.reduce((sum, row) => sum + row.terms.revenueDue, 0));
  const yearExpectedProfit = roundMoney(issuedYearAnalyses.reduce((sum, row) => sum + row.terms.revenueDue, 0));
  const monthProfitOutstanding = roundMoney(issuedMonthAnalyses.reduce((sum, row) => sum + row.revenueOutstanding, 0));
  const yearProfitOutstanding = roundMoney(issuedYearAnalyses.reduce((sum, row) => sum + row.revenueOutstanding, 0));
  const monthInterestRate = monthAdvanced ? roundMoney((monthExpectedProfit / monthAdvanced) * 100) : 0;
  const yearInterestRate = yearAdvanced ? roundMoney((yearExpectedProfit / yearAdvanced) * 100) : 0;
  const monthProfitReturn = monthAdvanced ? roundMoney((monthProfitCollected / monthAdvanced) * 100) : 0;
  const yearProfitReturn = yearAdvanced ? roundMoney((yearProfitCollected / yearAdvanced) * 100) : 0;
  const monthExpenses = roundMoney(
    state.expenses
      .filter((expense) => monthKey(expense.date) === currentMonth)
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0)
  );
  const yearExpenses = roundMoney(
    state.expenses
      .filter((expense) => String(dateFromISO(expense.date).getFullYear()) === currentYear)
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0)
  );
  const monthNetProfit = roundMoney(monthProfitCollected - monthExpenses);
  const yearNetProfit = roundMoney(yearProfitCollected - yearExpenses);

  return {
    activeLoans: analyses.filter((row) => row.status === "active").length,
    overdueLoans: analyses.filter((row) => row.status === "overdue").length,
    paidLoans: analyses.filter((row) => row.status === "paid").length,
    activeClients: activeClientIds.size,
    capitalOut: roundMoney(analyses.reduce((sum, row) => sum + (row.status === "written-off" ? 0 : row.principalOutstanding), 0)),
    totalOutstanding: roundMoney(analyses.reduce((sum, row) => sum + row.collectableOutstanding, 0)),
    overdueOutstanding: roundMoney(analyses.filter((row) => row.status === "overdue").reduce((sum, row) => sum + row.outstanding, 0)),
    writtenOffOutstanding: roundMoney(analyses.reduce((sum, row) => sum + row.writtenOffOutstanding, 0)),
    expectedThisMonth: roundMoney(dueThisMonth.reduce((sum, row) => sum + row.collectableOutstanding, 0)),
    monthProfitCollected,
    monthRevenueCollected,
    monthPrincipalRecovered,
    monthAdvanced,
    monthExpectedProfit,
    monthProfitOutstanding,
    monthNetCash: roundMoney(monthRevenueCollected - monthAdvanced),
    monthInterestRate,
    monthProfitReturn,
    monthExpenses,
    monthNetProfit,
    monthRevenue: monthProfitCollected,
    monthCollections: monthRevenueCollected,
    yearProfitCollected,
    yearRevenueCollected,
    yearPrincipalRecovered,
    yearAdvanced,
    yearExpectedProfit,
    yearProfitOutstanding,
    yearNetCash: roundMoney(yearRevenueCollected - yearAdvanced),
    yearInterestRate,
    yearProfitReturn,
    yearExpenses,
    yearNetProfit,
    yearRevenue: yearProfitCollected,
    yearCollections: yearRevenueCollected
  };
}

function render() {
  qs("#todayPill").textContent = formatDate(todayISO());
  renderPeriodControl();
  renderDashboard();
  renderClients();
  renderLoans();
  renderPayments();
  renderReports();
  hydrateIcons();
}

function renderPeriodControl() {
  qsa("[data-report-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.reportScope === ui.reportScope);
  });
  qs("#periodStepper").hidden = ui.reportScope === "all";
  qs("#periodLabel").textContent = currentPeriodLabel();
}

function currentPeriodLabel() {
  if (ui.reportScope === "all") return "All time";
  if (ui.reportScope === "year") return String(ui.reportYear);
  return monthLabel(ui.reportMonth);
}

function stepPeriod(delta) {
  if (ui.reportScope === "all") return;
  if (ui.reportScope === "year") {
    ui.reportYear = String(Number(ui.reportYear) + delta);
  } else {
    ui.reportMonth = addMonths(ui.reportMonth, delta);
    ui.reportYear = ui.reportMonth.slice(0, 4);
  }
  saveUiState();
  renderPeriodControl();
  renderReports();
}

// Period-aware figures. Flows (collections, revenue, cash out, expenses) are
// summed over the chosen period; matches by payment/issue/expense date.
function figuresFor(scope, month, year) {
  const match = (dateValue) => {
    if (scope === "all") return true;
    if (scope === "year") return String(dateFromISO(dateValue).getFullYear()) === String(year);
    return monthKey(dateValue) === month;
  };
  const payRows = allPaymentAllocations().filter((row) => match(row.payment.date));
  const issued = state.loans.filter((loan) => match(loan.issueDate));
  const issuedAnalyses = issued.map(analyzeLoan);
  const expenseRows = state.expenses.filter((expense) => match(expense.date));

  const collections = roundMoney(payRows.reduce((sum, row) => sum + Number(row.payment.amount || 0), 0));
  const revenue = roundMoney(payRows.reduce((sum, row) => sum + row.revenue, 0));
  const principalRecovered = roundMoney(payRows.reduce((sum, row) => sum + row.principal, 0));
  const cashOut = roundMoney(issued.reduce((sum, loan) => sum + Number(loan.principal || 0), 0));
  const expectedRevenue = roundMoney(issuedAnalyses.reduce((sum, row) => sum + row.terms.revenueDue, 0));
  const expectedTotal = roundMoney(issuedAnalyses.reduce((sum, row) => sum + row.terms.totalDue, 0));
  const issuedPaid = roundMoney(issuedAnalyses.reduce((sum, row) => sum + row.paid, 0));
  const expenses = roundMoney(expenseRows.reduce((sum, expense) => sum + Number(expense.amount || 0), 0));

  return {
    collections,
    revenue,
    principalRecovered,
    cashOut,
    expectedRevenue,
    expenses,
    profit: roundMoney(revenue - expenses),
    netCash: roundMoney(collections - cashOut),
    interestRate: cashOut ? roundMoney((expectedRevenue / cashOut) * 100) : 0,
    profitReturn: cashOut ? roundMoney((revenue / cashOut) * 100) : 0,
    collectionRate: expectedTotal ? roundMoney((issuedPaid / expectedTotal) * 100) : 0,
    loansIssued: issued.length
  };
}

// ---- Cash / float engine ----
// Cash on hand is a real running bank-style balance. Profit stays separate.
// Cash on hand = starting capital + capital in - capital out + repayments
//                - loans paid out - expenses
// Out on loan  = principal still in clients' hands (written-off principal is a
//                realised loss, so it leaves the float and is excluded here)
// Total funds  = cash on hand + out on loan (working capital)

function startingCapital() {
  return roundMoney(state.settings.startingCapital || 0);
}

function cashIconFor(kind) {
  return {
    "loan-out": "arrowOut",
    repayment: "arrowIn",
    expense: "tag",
    "capital-in": "coins",
    "capital-out": "arrowOut"
  }[kind] || "wallet";
}

// Every movement of actual cash, before sorting. amount is signed (+ in / - out).
function cashMovements() {
  const rows = [];

  state.loans.forEach((loan) => {
    rows.push({
      date: loan.issueDate,
      kind: "loan-out",
      label: getClientName(loan.clientId),
      sub: loan.purpose ? loan.purpose : "Loan paid out",
      amount: -roundMoney(loan.principal),
      createdAt: loan.createdAt || ""
    });
  });

  state.payments.forEach((payment) => {
    const loan = getLoan(payment.loanId);
    rows.push({
      date: payment.date,
      kind: "repayment",
      label: loan ? getClientName(loan.clientId) : "Repayment",
      sub: `Repayment · ${payment.method || "Cash"}`,
      amount: roundMoney(payment.amount),
      createdAt: payment.createdAt || ""
    });
  });

  state.expenses.forEach((expense) => {
    rows.push({
      date: expense.date,
      kind: "expense",
      label: expense.category || "Expense",
      sub: expense.note ? expense.note : "Business expense",
      amount: -roundMoney(expense.amount),
      createdAt: expense.createdAt || ""
    });
  });

  state.capital.forEach((entry) => {
    const out = entry.direction === "out";
    rows.push({
      date: entry.date,
      kind: out ? "capital-out" : "capital-in",
      label: out ? "Capital withdrawn" : "Capital added",
      sub: entry.note ? entry.note : (out ? "Money taken out of the float" : "Money put into the float"),
      amount: (out ? -1 : 1) * roundMoney(entry.amount),
      createdAt: entry.createdAt || ""
    });
  });

  return rows;
}

// Chronological ledger with a running balance starting from starting capital.
function sortedLedger() {
  const rows = cashMovements().sort((a, b) => {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate !== 0) return byDate;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  let balance = startingCapital();
  return rows.map((row) => {
    balance = roundMoney(balance + row.amount);
    return { ...row, balance };
  });
}

function cashOnHand() {
  const ledger = sortedLedger();
  return ledger.length ? ledger[ledger.length - 1].balance : startingCapital();
}

function outOnLoan() {
  return roundMoney(
    allAnalyses().reduce((sum, row) => sum + (row.status === "written-off" ? 0 : row.principalOutstanding), 0)
  );
}

function totalFunds() {
  return roundMoney(cashOnHand() + outOnLoan());
}

function capitalInjected() {
  return roundMoney(
    state.capital.filter((c) => c.direction !== "out").reduce((sum, c) => sum + Number(c.amount || 0), 0)
  );
}

function capitalWithdrawn() {
  return roundMoney(
    state.capital.filter((c) => c.direction === "out").reduce((sum, c) => sum + Number(c.amount || 0), 0)
  );
}

// Opening/closing balances and money in/out for the selected report period.
function cashFlowFor(scope, month, year) {
  const periodOf = (dateValue) => {
    if (scope === "all") return "in";
    if (scope === "year") {
      const y = Number(dateFromISO(dateValue).getFullYear());
      const target = Number(year);
      if (y < target) return "before";
      return y > target ? "after" : "in";
    }
    const key = monthKey(dateValue);
    if (key < month) return "before";
    return key > month ? "after" : "in";
  };

  let before = 0;
  let moneyIn = 0;
  let moneyOut = 0;
  cashMovements().forEach((row) => {
    const place = periodOf(row.date);
    if (place === "before") {
      before += row.amount;
    } else if (place === "in") {
      if (row.amount >= 0) moneyIn += row.amount;
      else moneyOut += row.amount;
    }
  });

  const opening = roundMoney(startingCapital() + before);
  const inflow = roundMoney(moneyIn);
  const outflow = roundMoney(Math.abs(moneyOut));
  const net = roundMoney(inflow - outflow);
  return {
    opening,
    moneyIn: inflow,
    moneyOut: outflow,
    net,
    closing: roundMoney(opening + net)
  };
}

function reportCardHtml([label, value, note]) {
  return `
    <article class="report-card">
      <span class="mini-label">${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <p class="item-meta">${escapeHtml(note)}</p>
    </article>
  `;
}

function reportYears() {
  const years = new Set([String(new Date().getFullYear())]);
  state.loans.forEach((loan) => years.add(String(dateFromISO(loan.issueDate).getFullYear())));
  state.payments.forEach((payment) => years.add(String(dateFromISO(payment.date).getFullYear())));
  return Array.from(years);
}

function dashboardActionText(action) {
  return {
    "capital-out": "View open loans",
    outstanding: "View balances",
    overdue: "View overdue loans",
    "profit-month": "View month report",
    "revenue-month": "View month payments",
    "due-month": "View due loans",
    "profit-year": "View year report",
    "active-clients": "View clients"
  }[action] || "Open";
}

function renderFloat() {
  const grid = qs("#floatGrid");
  if (!grid) return;
  const cash = cashOnHand();
  const cards = [
    ["Cash on hand", money(cash), "Available now", cash < 0 ? "negative" : "cash"],
    ["Out on loan", money(outOnLoan()), "In clients' hands", "out"],
    ["Total funds", money(totalFunds()), "Working capital", "total"]
  ];
  grid.innerHTML = cards
    .map(([label, value, note, tone]) => `
      <button class="float-card ${tone}" type="button" data-cash-action="statement">
        <span class="float-label">${label}</span>
        <strong class="float-value">${value}</strong>
        <span class="float-note">${note}</span>
        <span class="float-go" aria-hidden="true">${iconSvg("chevronRight")}</span>
      </button>
    `)
    .join("");
}

function renderDashboard() {
  const dashboardMonth = monthKey(new Date());
  const dashboardYear = String(new Date().getFullYear());
  const totals = totalsFor(dashboardMonth, dashboardYear);

  renderFloat();

  const metrics = [
    ["outstanding", "Outstanding", money(totals.totalOutstanding), "Collectable balance", ""],
    ["overdue", "Overdue", money(totals.overdueOutstanding), `${totals.overdueLoans} loan${totals.overdueLoans === 1 ? "" : "s"}`, totals.overdueLoans ? "danger" : "success"],
    ["due-month", "Due this month", money(totals.expectedThisMonth), "Expected in", totals.expectedThisMonth ? "warning" : ""],
    ["revenue-month", "Collected (mo)", money(totals.monthRevenueCollected), "Money in", ""],
    ["profit-month", "Revenue (mo)", money(totals.monthProfitCollected), "Interest + fees", "success"],
    ["profit-month", "Net profit (mo)", money(totals.monthNetProfit), "After expenses", totals.monthNetProfit >= 0 ? "success" : "danger"],
    ["profit-year", "Revenue (yr)", money(totals.yearProfitCollected), "Interest + fees", "success"],
    ["active-clients", "Active clients", String(totals.activeClients), `${state.clients.length} total`, ""]
  ];

  qs("#metricGrid").innerHTML = metrics
    .map(([action, label, value, trend, tone]) => `
      <button class="metric-card ${tone}" type="button" data-dashboard-action="${action}">
        <span class="mini-label">${label}</span>
        <strong>${value}</strong>
        <span class="trend">${trend}</span>
        <span class="card-action-text">${dashboardActionText(action)}</span>
      </button>
    `)
    .join("");

  const dueSoon = allAnalyses()
    .filter((row) => row.status === "active" || row.status === "overdue")
    .sort((a, b) => dateFromISO(a.loan.dueDate) - dateFromISO(b.loan.dueDate))
    .slice(0, 5);

  qs("#dueSoonList").innerHTML = dueSoon.length
    ? dueSoon.map((row) => loanMiniCard(row)).join("")
    : emptyHtml("No active due dates yet.");

  const recent = allPaymentAllocations().slice(0, 5);
  qs("#recentPaymentsList").innerHTML = recent.length
    ? recent.map((row) => paymentMiniCard(row)).join("")
    : emptyHtml("No payments recorded yet.");
}

function renderClients() {
  const term = ui.clientSearch.toLowerCase();
  const clients = state.clients
    .filter((client) => {
      const haystack = [client.name, client.phone, client.nationalId, client.employer].join(" ").toLowerCase();
      return haystack.includes(term);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  qs("#clientList").innerHTML = clients.length
    ? clients.map(clientCard).join("")
    : emptyHtml(state.clients.length ? "No clients match that search." : "No clients added yet.");
}

function renderLoans() {
  const analyses = allAnalyses()
    .filter((row) => {
      const statusMatch = ui.loanFilter === "all" || row.status === ui.loanFilter || (ui.loanFilter === "open" && (row.status === "active" || row.status === "overdue"));
      const monthMatch = ui.loanMonth === "all" || monthKey(row.loan.issueDate) === ui.loanMonth;
      return statusMatch && monthMatch;
    })
    .sort((a, b) => dateFromISO(a.loan.dueDate) - dateFromISO(b.loan.dueDate));

  qsa("[data-loan-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.loanFilter === ui.loanFilter);
  });
  renderLoanMonthStrip();

  qs("#loanList").innerHTML = analyses.length
    ? analyses.map(loanCard).join("")
    : emptyHtml("No loans in this view.");
}

function renderPayments() {
  const rows = allPaymentAllocations()
    .filter((row) => ui.paymentMonth === "all" || monthKey(row.payment.date) === ui.paymentMonth);
  renderPaymentMonthStrip();
  qs("#paymentList").innerHTML = rows.length
    ? rows.map(paymentCard).join("")
    : emptyHtml("No payments recorded yet.");
}

function renderLoanMonthStrip() {
  const months = availableLoanMonths();
  qs("#loanMonthStrip").innerHTML = monthButtonsHtml(months, ui.loanMonth, "loan-month", "Loans");
}

function renderPaymentMonthStrip() {
  const months = availablePaymentMonths();
  qs("#paymentMonthStrip").innerHTML = monthButtonsHtml(months, ui.paymentMonth, "payment-month", "Payments");
}

function monthButtonsHtml(months, activeMonth, type, label) {
  const allActive = activeMonth === "all" ? "active" : "";
  const buttons = [`<button class="${allActive}" type="button" data-${type}="all">All ${label}</button>`];
  months.forEach((row) => {
    const active = row.month === activeMonth ? "active" : "";
    buttons.push(`<button class="${active}" type="button" data-${type}="${row.month}">${monthLabel(row.month)} <span>${row.count}</span></button>`);
  });
  return buttons.join("");
}

function availableLoanMonths() {
  const counts = new Map();
  state.loans.forEach((loan) => {
    const key = monthKey(loan.issueDate);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts, ([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month));
}

function availablePaymentMonths() {
  const counts = new Map();
  state.payments.forEach((payment) => {
    const key = monthKey(payment.date);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts, ([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month));
}

function renderReports() {
  const f = figuresFor(ui.reportScope, ui.reportMonth, ui.reportYear);
  const position = totalsFor();

  qs("#reportGrid").innerHTML = [
    ["Collections", money(f.collections), "Money in (incl. capital)"],
    ["Revenue", money(f.revenue), "Interest + fees earned"],
    ["Expenses", money(f.expenses), "Business costs"],
    ["Profit", money(f.profit), "Revenue minus expenses"],
    ["Cash out", money(f.cashOut), "Loans issued"],
    ["Principal recovered", money(f.principalRecovered), "Capital returned"],
    ["Net cash", money(f.netCash), "Collections minus cash out"],
    ["Collection rate", percent(f.collectionRate), "Paid / total due on loans issued"]
  ].map(reportCardHtml).join("");

  qs("#positionGrid").innerHTML = [
    ["Outstanding now", money(position.totalOutstanding), "Still collectable"],
    ["Capital out", money(position.capitalOut), "Principal still lent out"],
    ["Overdue", money(position.overdueOutstanding), `${position.overdueLoans} loan${position.overdueLoans === 1 ? "" : "s"}`],
    ["Written off", money(position.writtenOffOutstanding), "Tracked separately"]
  ].map(reportCardHtml).join("");

  renderCashReport();
  renderCapital();
  renderTrendChart();
  renderBreakdownTable();
  renderExpenses();
  renderDataStatus();

  const overdue = allAnalyses()
    .filter((row) => row.status === "overdue")
    .sort((a, b) => dateFromISO(a.loan.dueDate) - dateFromISO(b.loan.dueDate));

  qs("#overdueReportList").innerHTML = overdue.length
    ? overdue.map((row) => loanMiniCard(row)).join("")
    : emptyHtml("No overdue loans.");
}

function renderCashReport() {
  const grid = qs("#cashFlowGrid");
  if (!grid) return;
  const cf = cashFlowFor(ui.reportScope, ui.reportMonth, ui.reportYear);
  grid.innerHTML = [
    ["Opening balance", money(cf.opening), "Cash at period start"],
    ["Money in", money(cf.moneyIn), "Repayments + capital in"],
    ["Money out", money(cf.moneyOut), "Loans + expenses + withdrawals"],
    ["Net movement", money(cf.net), "Money in minus money out"],
    ["Closing balance", money(cf.closing), "Cash at period end"],
    ["Out on loan now", money(outOnLoan()), "Principal with clients"]
  ].map(reportCardHtml).join("");
}

function renderCapital() {
  const grid = qs("#capitalGrid");
  if (!grid) return;
  grid.innerHTML = [
    ["Starting capital", money(startingCapital()), startingCapital() ? "Your opening float" : "Tap Set to enter"],
    ["Capital added", money(capitalInjected()), "Money you put in"],
    ["Capital withdrawn", money(capitalWithdrawn()), "Money you took out"],
    ["Cash on hand", money(cashOnHand()), "Live balance"]
  ].map(reportCardHtml).join("");

  const rows = state.capital.slice().sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) return byDate;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  qs("#capitalList").innerHTML = rows.length
    ? rows.map(capitalCard).join("")
    : emptyHtml("No capital injections or withdrawals yet.");
}

function capitalCard(entry) {
  const out = entry.direction === "out";
  return `
    <article class="list-card compact">
      <div class="item-top">
        <div class="item-title">
          <strong>${out ? "Capital withdrawn" : "Capital added"}</strong>
          <p class="item-meta">${formatDate(entry.date)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</p>
        </div>
        <div class="item-amount">
          <strong class="${out ? "neg" : "pos"}">${out ? "−" : "+"}${money(entry.amount)}</strong>
          <p class="item-meta">${out ? "Out of float" : "Into float"}</p>
        </div>
      </div>
      <div class="card-actions">
        <button class="icon-btn danger" type="button" data-action="delete-capital" data-id="${entry.id}" aria-label="Delete entry" title="Delete entry">
          <span class="btn-icon">${iconSvg("trash")}</span>
        </button>
      </div>
    </article>
  `;
}

function openCashStatement() {
  const ledger = sortedLedger();
  const cash = cashOnHand();
  const byMonth = new Map();
  ledger.forEach((row) => {
    const key = monthKey(row.date);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(row);
  });
  const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));
  const sections = months
    .map((m) => {
      const rows = byMonth.get(m).slice().reverse(); // newest first within month
      return `
        <div class="ledger-group">
          <div class="ledger-group-head">${monthLabel(m)}</div>
          <div class="ledger-rows">${rows.map(cashRowHtml).join("")}</div>
        </div>
      `;
    })
    .join("");

  openPanel("Statement", `
    <div class="statement ledger-view">
      <div class="ledger-hero">
        <span class="ledger-hero-label">Cash on hand</span>
        <strong class="ledger-hero-value">${money(cash)}</strong>
        <span class="ledger-hero-note">Opened with ${money(startingCapital())} · ${ledger.length} movement${ledger.length === 1 ? "" : "s"}</span>
      </div>
      ${ledger.length ? sections : emptyHtml("No money has moved yet. Set your starting capital, then record loans, payments, expenses, or capital changes.")}
    </div>
  `);
}

function cashRowHtml(row) {
  const positive = row.amount >= 0;
  return `
    <div class="ledger-row">
      <span class="ledger-row-icon ${row.kind}">${iconSvg(cashIconFor(row.kind))}</span>
      <div class="ledger-row-main">
        <strong>${escapeHtml(row.label)}</strong>
        <p class="item-meta">${formatDate(row.date)} · ${escapeHtml(row.sub)}</p>
      </div>
      <div class="ledger-row-amount">
        <strong class="${positive ? "pos" : "neg"}">${positive ? "+" : "−"}${money(Math.abs(row.amount))}</strong>
        <p class="item-meta">Bal ${money(row.balance)}</p>
      </div>
    </div>
  `;
}

function openStartingCapitalForm() {
  openSheet("Starting capital", `
    <p class="form-hint">The money you began the business with — your opening float. Cash on hand builds from this figure. You can change it anytime.</p>
    <div class="form-grid">
      <label><span>Starting capital</span><input name="amount" type="number" min="0" step="0.01" required inputmode="decimal" value="${escapeHtml(state.settings.startingCapital || "")}" /></label>
      <label><span>As of date</span><input name="date" type="date" value="${escapeHtml(state.settings.startingCapitalDate || todayISO())}" /></label>
    </div>
  `, "Save capital", (form) => {
    state.settings.startingCapital = roundMoney(form.get("amount"));
    state.settings.startingCapitalDate = form.get("date") || "";
    saveState();
    toast("Starting capital saved.");
    render();
  });
}

function openCapitalForm(direction = "in") {
  const out = direction === "out";
  openSheet(out ? "Withdraw capital" : "Add capital", `
    <p class="form-hint">${out ? "Money you take out of the business float (for example, paying yourself)." : "Extra money you put into the business float."}</p>
    <div class="form-grid">
      <label><span>Amount</span><input name="amount" type="number" min="0" step="0.01" required inputmode="decimal" /></label>
      <label><span>Date</span><input name="date" type="date" required value="${todayISO()}" /></label>
      <label class="wide"><span>Note</span><input name="note" placeholder="${out ? "What is this for?" : "Where is this from?"}" /></label>
    </div>
  `, out ? "Save withdrawal" : "Save deposit", (form) => {
    const amount = roundMoney(form.get("amount"));
    if (amount <= 0) {
      toast("Enter an amount.");
      return false;
    }
    state.capital.push({
      id: uid("capital"),
      direction: out ? "out" : "in",
      amount,
      date: form.get("date"),
      note: cleanText(form.get("note")),
      createdAt: new Date().toISOString()
    });
    saveState();
    toast(out ? "Withdrawal saved." : "Capital added.");
    render();
  });
}

function deleteCapital(id) {
  if (!confirm("Delete this capital entry?")) return;
  state.capital = state.capital.filter((entry) => entry.id !== id);
  saveState();
  render();
  toast("Entry deleted.");
}

function renderTrendChart() {
  let rows;
  if (ui.reportScope === "all") {
    rows = reportYears().sort().map((year) => {
      const f = figuresFor("year", null, year);
      return { label: year, collections: f.collections, revenue: f.revenue };
    });
  } else {
    rows = reportMonthsForYear(ui.reportYear).map((month) => {
      const f = figuresFor("month", month, ui.reportYear);
      return { label: monthShort(month), collections: f.collections, revenue: f.revenue };
    });
  }
  const max = Math.max(1, ...rows.map((row) => row.collections));

  qs("#revenueChart").innerHTML = rows.length
    ? rows
        .map((row) => {
          const collectionsWidth = Math.max(3, Math.round((row.collections / max) * 100));
          const revenueWidth = Math.max(3, Math.round((row.revenue / max) * 100));
          return `
        <div class="bar-row">
          <span class="mini-label">${escapeHtml(row.label)}</span>
          <div class="bar-stack">
            <div class="bar-track"><div class="bar-fill revenue" style="width:${collectionsWidth}%"></div></div>
            <div class="bar-track slim"><div class="bar-fill profit" style="width:${revenueWidth}%"></div></div>
          </div>
          <span class="bar-value">In ${money(row.collections)} · Rev ${money(row.revenue)}</span>
        </div>
      `;
        })
        .join("")
    : emptyHtml("No activity to chart yet.");
}

function renderBreakdownTable() {
  let rows;
  let totalLabel;
  if (ui.reportScope === "all") {
    rows = reportYears().sort().map((year) => ({
      label: year,
      f: figuresFor("year", null, year),
      outstanding: yearOutstanding(year)
    }));
    totalLabel = "All time";
  } else {
    rows = Array.from({ length: 12 }, (_, index) => {
      const month = `${ui.reportYear}-${String(index + 1).padStart(2, "0")}`;
      return {
        label: monthShort(month),
        f: figuresFor("month", month, ui.reportYear),
        outstanding: monthOutstanding(month)
      };
    });
    totalLabel = String(ui.reportYear);
  }

  const totals = rows.reduce(
    (acc, row) => ({
      collections: acc.collections + row.f.collections,
      cashOut: acc.cashOut + row.f.cashOut,
      revenue: acc.revenue + row.f.revenue,
      profit: acc.profit + row.f.profit
    }),
    { collections: 0, cashOut: 0, revenue: 0, profit: 0 }
  );

  const body = rows
    .map((row) => `
      <tr>
        <th scope="row">${escapeHtml(row.label)}</th>
        <td>${money(row.f.collections)}</td>
        <td>${money(row.f.cashOut)}</td>
        <td>${money(row.f.revenue)}</td>
        <td>${money(row.f.profit)}</td>
        <td>${money(row.outstanding)}</td>
      </tr>
    `)
    .join("");

  qs("#monthlyBreakdown").innerHTML = `
    <div class="table-scroll">
      <table class="ledger-table">
        <thead>
          <tr>
            <th scope="col">${ui.reportScope === "all" ? "Year" : "Month"}</th>
            <th scope="col">Collected</th>
            <th scope="col">Cash out</th>
            <th scope="col">Revenue</th>
            <th scope="col">Profit</th>
            <th scope="col">Outstanding</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr>
            <th scope="row">Total ${escapeHtml(totalLabel)}</th>
            <td>${money(totals.collections)}</td>
            <td>${money(totals.cashOut)}</td>
            <td>${money(totals.revenue)}</td>
            <td>${money(totals.profit)}</td>
            <td>—</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function yearOutstanding(year) {
  return roundMoney(
    allAnalyses()
      .filter((row) => String(dateFromISO(row.loan.issueDate).getFullYear()) === String(year))
      .reduce((sum, row) => sum + row.outstanding, 0)
  );
}

function renderDataStatus() {
  const rows = Array.isArray(window.quickserveHistoricalRows) ? window.quickserveHistoricalRows : [];
  const importedIds = new Set(rows.map((row) => `loan_${slug(row.loanId)}`));
  const importedLoans = state.loans.filter((loan) => importedIds.has(loan.id));
  const importedPayments = state.payments.filter((payment) => importedIds.has(payment.loanId));
  const missingLoans = rows.length - importedLoans.length;
  const importedOutstanding = roundMoney(importedLoans.map(analyzeLoan).reduce((sum, row) => sum + row.outstanding, 0));
  const cards = [
    ["Import rows", String(rows.length), missingLoans ? `${missingLoans} missing` : "All loaded"],
    ["Clients", String(state.clients.length), "Saved records"],
    ["Loans", String(state.loans.length), `${importedLoans.length} imported`],
    ["Payments", String(state.payments.length), `${importedPayments.length} imported`],
    ["Outstanding", money(importedOutstanding), "Imported loan balance"],
    ["Data version", state.imports.includes(SPREADSHEET_IMPORT_ID) ? "Current" : "Needs refresh", "Spreadsheet import"]
  ];

  qs("#dataStatusGrid").innerHTML = cards
    .map(([label, value, note]) => `
      <article class="report-card">
        <span class="mini-label">${label}</span>
        <strong>${value}</strong>
        <p class="item-meta">${note}</p>
      </article>
    `)
    .join("");
}

const EXPENSE_CATEGORIES = [
  "Transport",
  "Airtime and data",
  "Bank charges",
  "Rent",
  "Salaries",
  "Stationery",
  "Marketing",
  "Bad debt",
  "Other"
];

function renderExpenses() {
  const totals = totalsFor(ui.reportMonth, ui.reportYear);
  const allExpenses = roundMoney(state.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0));
  const summary = [
    ["This month", money(totals.monthExpenses), monthLabel(ui.reportMonth)],
    ["This year", money(totals.yearExpenses), String(ui.reportYear)],
    ["Profit (year)", money(totals.yearNetProfit), "Revenue minus expenses"],
    ["All time", money(allExpenses), `${state.expenses.length} ${state.expenses.length === 1 ? "record" : "records"}`]
  ];

  qs("#expenseSummaryGrid").innerHTML = summary
    .map(([label, value, note]) => `
      <article class="report-card">
        <span class="mini-label">${label}</span>
        <strong>${value}</strong>
        <p class="item-meta">${escapeHtml(note)}</p>
      </article>
    `)
    .join("");

  const rows = state.expenses
    .filter((expense) => String(dateFromISO(expense.date).getFullYear()) === String(ui.reportYear))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  qs("#expenseList").innerHTML = rows.length
    ? rows.map(expenseCard).join("")
    : emptyHtml(state.expenses.length ? "No expenses recorded for this year." : "No expenses recorded yet.");
}

function expenseCard(expense) {
  return `
    <article class="list-card compact">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(expense.category || "Expense")}</strong>
          <p class="item-meta">${formatDate(expense.date)}${expense.note ? ` · ${escapeHtml(expense.note)}` : ""}</p>
        </div>
        <div class="item-amount">
          <strong>${money(expense.amount)}</strong>
          <p class="item-meta">Expense</p>
        </div>
      </div>
      <div class="card-actions">
        <button class="icon-btn danger" type="button" data-action="delete-expense" data-id="${expense.id}" aria-label="Delete expense" title="Delete expense">
          <span class="btn-icon">${iconSvg("trash")}</span>
        </button>
      </div>
    </article>
  `;
}

function openExpenseForm() {
  const categoryOptions = EXPENSE_CATEGORIES
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join("");

  openSheet("Add expense", `
    <div class="form-grid">
      <label><span>Amount</span><input name="amount" type="number" min="0" step="0.01" required inputmode="decimal" /></label>
      <label><span>Date</span><input name="date" type="date" required value="${todayISO()}" /></label>
      <label class="wide"><span>Category</span><select name="category">${categoryOptions}</select></label>
      <label class="wide"><span>Note</span><input name="note" placeholder="What was this for?" /></label>
    </div>
  `, "Save expense", (form) => {
    const amount = roundMoney(form.get("amount"));
    if (amount <= 0) {
      toast("Enter the expense amount.");
      return false;
    }

    state.expenses.push({
      id: uid("expense"),
      date: form.get("date"),
      amount,
      category: cleanText(form.get("category")) || "Other",
      note: cleanText(form.get("note")),
      createdAt: new Date().toISOString()
    });
    saveState();
    toast("Expense saved.");
    render();
  });
}

function deleteExpense(id) {
  if (!confirm("Delete this expense?")) return;
  state.expenses = state.expenses.filter((expense) => expense.id !== id);
  saveState();
  render();
  toast("Expense deleted.");
}

function exportExpenses() {
  const rows = state.expenses
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((expense) => ({
      date: expense.date,
      category: expense.category || "",
      amount: roundMoney(expense.amount),
      note: expense.note || ""
    }));
  if (!rows.length) {
    toast("No expenses to export.");
    return;
  }
  downloadFile(`quickserve-expenses-${todayISO()}.csv`, csvFromRows(rows), "text/csv");
}

function reportMonthsForYear(year) {
  const yearText = String(year || new Date().getFullYear());
  const months = new Set();
  state.loans.forEach((loan) => {
    if (String(dateFromISO(loan.issueDate).getFullYear()) === yearText) months.add(monthKey(loan.issueDate));
  });
  state.payments.forEach((payment) => {
    if (String(dateFromISO(payment.date).getFullYear()) === yearText) months.add(monthKey(payment.date));
  });
  if (!months.size) {
    return Array.from({ length: 6 }, (_, index) => addMonths(ui.reportMonth, index - 5));
  }
  return Array.from(months).sort();
}

function monthOutstanding(month) {
  return roundMoney(
    allAnalyses()
      .filter((row) => monthKey(row.loan.issueDate) === month)
      .reduce((sum, row) => sum + row.outstanding, 0)
  );
}

function emptyHtml(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function statusLabel(status) {
  return status === "written-off" ? "Written off" : status;
}

function loanMiniCard(row) {
  const clientName = getClientName(row.loan.clientId);
  const dueText = row.daysUntilDue < 0 ? `${Math.abs(row.daysUntilDue)} days late` : `Due in ${row.daysUntilDue} days`;
  return `
    <article class="list-card compact">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(clientName)}</strong>
          <p class="item-meta">${formatDate(row.loan.dueDate)} · ${dueText}</p>
        </div>
        <span class="status ${row.status}">${escapeHtml(statusLabel(row.status))}</span>
      </div>
      <div class="item-top">
        <p class="item-meta">${escapeHtml(row.loan.purpose || "Cashloan")}</p>
        <div class="item-amount">
          <strong>${money(row.outstanding)}</strong>
          <p class="item-meta">Outstanding</p>
        </div>
      </div>
    </article>
  `;
}

function paymentMiniCard(row) {
  return `
    <article class="list-card compact">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(row.client?.name || "Unknown client")}</strong>
          <p class="item-meta">${formatDate(row.payment.date)} · ${escapeHtml(row.payment.method || "Payment")}</p>
        </div>
        <div class="item-amount">
          <strong>${money(row.payment.amount)}</strong>
          <p class="item-meta">${money(row.revenue)} revenue</p>
        </div>
      </div>
    </article>
  `;
}

function clientCard(client) {
  const rows = allAnalyses().filter((row) => row.loan.clientId === client.id);
  const openRows = rows.filter((row) => row.status === "active" || row.status === "overdue");
  const outstanding = roundMoney(openRows.reduce((sum, row) => sum + row.outstanding, 0));
  const revenue = roundMoney(rows.reduce((sum, row) => sum + row.revenueCollected, 0));

  return `
    <article class="list-card">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(client.name)}</strong>
          <p class="item-meta">${escapeHtml(client.phone || "No phone")} · ${escapeHtml(client.employer || "No employer")}</p>
        </div>
        <span class="status ${openRows.length ? "active" : "paid"}">${openRows.length ? "Active" : "Clear"}</span>
      </div>
      <div class="detail-grid">
        <div class="detail"><span>Open loans</span><strong>${openRows.length}</strong></div>
        <div class="detail"><span>Outstanding</span><strong>${money(outstanding)}</strong></div>
        <div class="detail"><span>Revenue paid</span><strong>${money(revenue)}</strong></div>
        <div class="detail"><span>ID</span><strong>${escapeHtml(client.nationalId || "Not saved")}</strong></div>
      </div>
      <div class="card-actions">
        <button class="icon-text-btn" type="button" data-action="client-loan" data-id="${client.id}">
          <span class="btn-icon">${iconSvg("plus")}</span><span>Loan</span>
        </button>
        <button class="icon-text-btn" type="button" data-action="client-statement" data-id="${client.id}">
          <span class="btn-icon">${iconSvg("fileText")}</span><span>Statement</span>
        </button>
        <button class="icon-text-btn" type="button" data-action="edit-client" data-id="${client.id}">
          <span class="btn-icon">${iconSvg("edit")}</span><span>Edit</span>
        </button>
        <button class="icon-btn danger" type="button" data-action="delete-client" data-id="${client.id}" aria-label="Delete client" title="Delete client">
          <span class="btn-icon">${iconSvg("trash")}</span>
        </button>
      </div>
    </article>
  `;
}

function loanCard(row) {
  const loan = row.loan;
  const reopenButton = loan.status === "written-off"
    ? `<button class="icon-text-btn" type="button" data-action="reactivate-loan" data-id="${loan.id}"><span class="btn-icon">${iconSvg("edit")}</span><span>Reopen</span></button>`
    : `<button class="icon-text-btn" type="button" data-action="write-off-loan" data-id="${loan.id}"><span class="btn-icon">${iconSvg("archive")}</span><span>Write off</span></button>`;

  return `
    <article class="list-card">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(getClientName(loan.clientId))}</strong>
          <p class="item-meta">${escapeHtml(loan.purpose || "Cashloan")} · Issued ${formatDate(loan.issueDate)}</p>
        </div>
        <span class="status ${row.status}">${escapeHtml(statusLabel(row.status))}</span>
      </div>
      <div class="detail-grid">
        <div class="detail"><span>Principal</span><strong>${money(row.terms.principal)}</strong></div>
        <div class="detail"><span>Revenue due</span><strong>${money(row.terms.revenueDue)}</strong></div>
        <div class="detail"><span>Paid</span><strong>${money(row.paid)}</strong></div>
        <div class="detail"><span>Outstanding</span><strong>${money(row.outstanding)}</strong></div>
        <div class="detail"><span>Due date</span><strong>${formatDate(loan.dueDate)}</strong></div>
        <div class="detail"><span>Rate</span><strong>${Number(loan.interestRate || 0)}%</strong></div>
      </div>
      <div class="card-actions">
        <button class="icon-text-btn primary" type="button" data-action="payment-for-loan" data-id="${loan.id}">
          <span class="btn-icon">${iconSvg("receipt")}</span><span>Payment</span>
        </button>
        <button class="icon-text-btn" type="button" data-action="edit-loan" data-id="${loan.id}">
          <span class="btn-icon">${iconSvg("edit")}</span><span>Edit</span>
        </button>
        ${row.status === "paid" ? "" : reopenButton}
        <button class="icon-btn danger" type="button" data-action="delete-loan" data-id="${loan.id}" aria-label="Delete loan" title="Delete loan">
          <span class="btn-icon">${iconSvg("trash")}</span>
        </button>
      </div>
    </article>
  `;
}

function paymentCard(row) {
  const payment = row.payment;
  return `
    <article class="list-card">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(row.client?.name || "Unknown client")}</strong>
          <p class="item-meta">${formatDate(payment.date)} · ${escapeHtml(payment.method || "Payment")} · ${escapeHtml(payment.reference || "No reference")}</p>
        </div>
        <div class="item-amount">
          <strong>${money(payment.amount)}</strong>
          <p class="item-meta">${money(row.outstandingAfter)} left</p>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail"><span>Revenue</span><strong>${money(row.revenue)}</strong></div>
        <div class="detail"><span>Principal</span><strong>${money(row.principal)}</strong></div>
      </div>
      <div class="card-actions">
        <button class="icon-btn danger" type="button" data-action="delete-payment" data-id="${payment.id}" aria-label="Delete payment" title="Delete payment">
          <span class="btn-icon">${iconSvg("trash")}</span>
        </button>
      </div>
    </article>
  `;
}

function openClientForm(client = null) {
  const isEdit = Boolean(client);
  openSheet(isEdit ? "Edit client" : "New client", `
    <div class="form-grid">
      <label><span>Name</span><input name="name" required value="${escapeHtml(client?.name || "")}" autocomplete="name" /></label>
      <label><span>Phone</span><input name="phone" value="${escapeHtml(client?.phone || "")}" inputmode="tel" autocomplete="tel" /></label>
      <label><span>ID or passport</span><input name="nationalId" value="${escapeHtml(client?.nationalId || "")}" /></label>
      <label><span>Employer</span><input name="employer" value="${escapeHtml(client?.employer || "")}" /></label>
      <label class="wide"><span>Address</span><input name="address" value="${escapeHtml(client?.address || "")}" /></label>
      <label><span>Next of kin</span><input name="nextOfKin" value="${escapeHtml(client?.nextOfKin || "")}" /></label>
      <label><span>Notes</span><textarea name="notes">${escapeHtml(client?.notes || "")}</textarea></label>
    </div>
  `, isEdit ? "Save client" : "Add client", (form) => {
    const record = {
      name: cleanText(form.get("name")),
      phone: cleanText(form.get("phone")),
      nationalId: cleanText(form.get("nationalId")),
      employer: cleanText(form.get("employer")),
      address: cleanText(form.get("address")),
      nextOfKin: cleanText(form.get("nextOfKin")),
      notes: cleanText(form.get("notes"))
    };

    if (isEdit) {
      Object.assign(client, record);
      toast("Client updated.");
    } else {
      state.clients.push({ id: uid("client"), createdAt: new Date().toISOString(), ...record });
      toast("Client added.");
    }
    saveState();
    render();
  });
}

function clientOptions(selectedId = "") {
  return state.clients
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((client) => `<option value="${client.id}" ${client.id === selectedId ? "selected" : ""}>${escapeHtml(client.name)}</option>`)
    .join("");
}

function openLoanForm(loan = null, forcedClientId = "") {
  if (!state.clients.length) {
    toast("Add a client first.");
    switchView("clientsView");
    openClientForm();
    return;
  }

  const isEdit = Boolean(loan);
  const issueDate = loan?.issueDate || todayISO();
  const dueDate = loan?.dueDate || addDays(issueDate, 30);
  const selectedClient = loan?.clientId || forcedClientId || state.clients[0].id;

  openSheet(isEdit ? "Edit loan" : "New loan", `
    <div class="form-grid">
      <label class="wide"><span>Client</span><select name="clientId" required>${clientOptions(selectedClient)}</select></label>
      <label><span>Amount given</span><input name="principal" type="number" min="0" step="0.01" required value="${escapeHtml(loan?.principal || "")}" inputmode="decimal" /></label>
      <label><span>Interest rate %</span><input name="interestRate" type="number" min="0" step="0.01" value="${escapeHtml(loan?.interestRate ?? 30)}" inputmode="decimal" /></label>
      <label><span>Service fee</span><input name="serviceFee" type="number" min="0" step="0.01" value="${escapeHtml(loan?.serviceFee || 0)}" inputmode="decimal" /></label>
      <label><span>Issue date</span><input name="issueDate" type="date" required value="${escapeHtml(issueDate)}" /></label>
      <label><span>Due date</span><input name="dueDate" type="date" required value="${escapeHtml(dueDate)}" /></label>
      <label class="wide"><span>Purpose</span><input name="purpose" value="${escapeHtml(loan?.purpose || "")}" /></label>
    </div>
  `, isEdit ? "Save loan" : "Create loan", (form) => {
    const principal = roundMoney(form.get("principal"));
    if (principal <= 0) {
      toast("Enter the amount given.");
      return false;
    }

    const record = {
      clientId: form.get("clientId"),
      principal,
      interestRate: roundMoney(form.get("interestRate")),
      serviceFee: roundMoney(form.get("serviceFee")),
      issueDate: form.get("issueDate"),
      dueDate: form.get("dueDate"),
      purpose: cleanText(form.get("purpose"))
    };

    if (isEdit) {
      Object.assign(loan, record);
      toast("Loan updated.");
    } else {
      state.loans.push({
        id: uid("loan"),
        createdAt: new Date().toISOString(),
        status: "active",
        ...record
      });
      toast("Loan created.");
    }
    saveState();
    render();
  });
}

function openPaymentForm(forcedLoanId = "") {
  const openLoans = allAnalyses().filter((row) => row.status === "active" || row.status === "overdue");
  if (!openLoans.length) {
    toast("No active loans to collect.");
    return;
  }

  const selected = forcedLoanId || openLoans[0].loan.id;
  const options = openLoans
    .sort((a, b) => dateFromISO(a.loan.dueDate) - dateFromISO(b.loan.dueDate))
    .map((row) => `
      <option value="${row.loan.id}" ${row.loan.id === selected ? "selected" : ""}>
        ${escapeHtml(getClientName(row.loan.clientId))} · ${money(row.outstanding)}
      </option>
    `)
    .join("");

  openSheet("Record payment", `
    <div class="form-grid">
      <label class="wide"><span>Loan</span><select name="loanId" required>${options}</select></label>
      <label><span>Amount paid</span><input name="amount" type="number" min="0" step="0.01" required inputmode="decimal" /></label>
      <label><span>Payment date</span><input name="date" type="date" required value="${todayISO()}" /></label>
      <label><span>Method</span><select name="method">
        <option>Cash</option>
        <option>Bank transfer</option>
        <option>E-wallet</option>
        <option>Other</option>
      </select></label>
      <label><span>Reference</span><input name="reference" /></label>
      <label><span>Notes</span><textarea name="notes"></textarea></label>
    </div>
  `, "Save payment", (form) => {
    const amount = roundMoney(form.get("amount"));
    const loan = getLoan(form.get("loanId"));
    if (!loan || amount <= 0) {
      toast("Select a loan and enter an amount.");
      return false;
    }

    const analysis = analyzeLoan(loan);
    if (amount > analysis.outstanding + 0.01 && !confirm("This payment is higher than the outstanding balance. Save it anyway?")) {
      return false;
    }

    state.payments.push({
      id: uid("payment"),
      loanId: loan.id,
      amount,
      date: form.get("date"),
      method: form.get("method"),
      reference: cleanText(form.get("reference")),
      notes: cleanText(form.get("notes")),
      createdAt: new Date().toISOString()
    });
    saveState();
    toast("Payment saved.");
    render();
  });
}

function openSheet(title, bodyHtml, submitLabel, onSubmit) {
  qs("#sheetTitle").textContent = title;
  qs("#sheetBody").innerHTML = `
    <form id="activeSheetForm">
      ${bodyHtml}
      <div class="sheet-actions">
        <button class="icon-text-btn" type="button" data-sheet-cancel>
          <span class="btn-icon">${iconSvg("x")}</span><span>Cancel</span>
        </button>
        <button class="icon-text-btn primary" type="submit">
          <span class="btn-icon">${iconSvg("plus")}</span><span>${escapeHtml(submitLabel)}</span>
        </button>
      </div>
    </form>
  `;

  qs("#sheet").hidden = false;
  const form = qs("#activeSheetForm");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = onSubmit(new FormData(form));
    if (result === false) return;
    closeSheet();
  });
  qs("[data-sheet-cancel]").addEventListener("click", closeSheet);
  hydrateIcons(qs("#sheet"));
  setTimeout(() => qs("input, select, textarea", form)?.focus(), 80);
}

function closeSheet() {
  qs("#sheet").hidden = true;
  qs("#sheetBody").innerHTML = "";
}

function openPanel(title, bodyHtml) {
  qs("#sheetTitle").textContent = title;
  qs("#sheetBody").innerHTML = bodyHtml;
  qs("#sheet").hidden = false;
  hydrateIcons(qs("#sheet"));
}

function buildClientStatement(client) {
  const analyses = allAnalyses()
    .filter((row) => row.loan.clientId === client.id)
    .sort((a, b) => String(a.loan.issueDate).localeCompare(String(b.loan.issueDate)));
  return {
    client,
    analyses,
    totalPrincipal: roundMoney(analyses.reduce((sum, row) => sum + row.terms.principal, 0)),
    totalDue: roundMoney(analyses.reduce((sum, row) => sum + row.terms.totalDue, 0)),
    totalPaid: roundMoney(analyses.reduce((sum, row) => sum + row.paid, 0)),
    totalOutstanding: roundMoney(analyses.reduce((sum, row) => sum + row.outstanding, 0)),
    revenuePaid: roundMoney(analyses.reduce((sum, row) => sum + row.revenueCollected, 0))
  };
}

function statementLoanHtml(row) {
  const loan = row.loan;
  const paymentsHtml = row.allocations.length
    ? row.allocations
        .map((alloc) => `<li>${formatDate(alloc.payment.date)} — ${money(alloc.payment.amount)} <span class="item-meta">(${money(alloc.revenue)} revenue, ${money(alloc.principal)} principal)</span></li>`)
        .join("")
    : `<li class="item-meta">No payments yet.</li>`;

  return `
    <article class="list-card compact">
      <div class="item-top">
        <div class="item-title">
          <strong>${escapeHtml(loan.purpose || "Cashloan")}</strong>
          <p class="item-meta">Issued ${formatDate(loan.issueDate)} · Due ${formatDate(loan.dueDate)}</p>
        </div>
        <span class="status ${row.status}">${escapeHtml(statusLabel(row.status))}</span>
      </div>
      <div class="detail-grid">
        <div class="detail"><span>Principal</span><strong>${money(row.terms.principal)}</strong></div>
        <div class="detail"><span>Total due</span><strong>${money(row.terms.totalDue)}</strong></div>
        <div class="detail"><span>Paid</span><strong>${money(row.paid)}</strong></div>
        <div class="detail"><span>Outstanding</span><strong>${money(row.outstanding)}</strong></div>
      </div>
      <ul class="statement-payments">${paymentsHtml}</ul>
    </article>
  `;
}

function statementText(statement) {
  const lines = ["QuickServe Cashloan — Statement", statement.client.name];
  if (statement.client.phone) lines.push(`Phone: ${statement.client.phone}`);
  lines.push(`Date: ${formatDate(todayISO())}`, "");

  statement.analyses.forEach((row) => {
    lines.push(`${row.loan.purpose || "Cashloan"} — issued ${formatDate(row.loan.issueDate)}, due ${formatDate(row.loan.dueDate)} [${statusLabel(row.status)}]`);
    lines.push(`  Principal ${money(row.terms.principal)}, total due ${money(row.terms.totalDue)}`);
    row.allocations.forEach((alloc) => {
      lines.push(`  Paid ${formatDate(alloc.payment.date)}: ${money(alloc.payment.amount)}`);
    });
    lines.push(`  Outstanding: ${money(row.outstanding)}`, "");
  });

  lines.push(`Total borrowed: ${money(statement.totalPrincipal)}`);
  lines.push(`Total paid: ${money(statement.totalPaid)}`);
  lines.push(`Outstanding: ${money(statement.totalOutstanding)}`);
  return lines.join("\n");
}

function exportClientStatement(statement) {
  const rows = [];
  statement.analyses.forEach((row) => {
    const base = {
      loan_purpose: row.loan.purpose || "Cashloan",
      issue_date: row.loan.issueDate,
      due_date: row.loan.dueDate,
      principal: row.terms.principal,
      total_due: row.terms.totalDue,
      status: row.status
    };
    if (!row.allocations.length) {
      rows.push({ ...base, payment_date: "", payment_amount: "", outstanding: row.outstanding });
      return;
    }
    row.allocations.forEach((alloc) => {
      rows.push({
        ...base,
        payment_date: alloc.payment.date,
        payment_amount: alloc.payment.amount,
        outstanding: alloc.outstandingAfter
      });
    });
  });

  if (!rows.length) {
    toast("Nothing to export for this client.");
    return;
  }
  downloadFile(`statement-${slug(statement.client.name)}-${todayISO()}.csv`, csvFromRows(rows), "text/csv");
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy copy
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function openStatement(client) {
  if (!client) return;
  const statement = buildClientStatement(client);
  const loansHtml = statement.analyses.length
    ? statement.analyses.map(statementLoanHtml).join("")
    : emptyHtml("No loans for this client yet.");

  openPanel("Client statement", `
    <div class="statement">
      <div class="statement-head">
        <div class="item-title">
          <strong>${escapeHtml(client.name)}</strong>
          <p class="item-meta">${escapeHtml(client.phone || "No phone")}${client.nationalId ? ` · ID ${escapeHtml(client.nationalId)}` : ""}</p>
        </div>
        <p class="item-meta">${formatDate(todayISO())}</p>
      </div>
      <div class="detail-grid">
        <div class="detail"><span>Total borrowed</span><strong>${money(statement.totalPrincipal)}</strong></div>
        <div class="detail"><span>Total paid</span><strong>${money(statement.totalPaid)}</strong></div>
        <div class="detail"><span>Outstanding</span><strong>${money(statement.totalOutstanding)}</strong></div>
        <div class="detail"><span>Revenue paid</span><strong>${money(statement.revenuePaid)}</strong></div>
      </div>
      <h3 class="statement-subhead">Loans and payments</h3>
      <div class="item-list">${loansHtml}</div>
    </div>
    <div class="sheet-actions">
      <button class="icon-text-btn" type="button" id="statementCopyBtn"><span class="btn-icon">${iconSvg("copy")}</span><span>Copy</span></button>
      ${navigator.share ? `<button class="icon-text-btn" type="button" id="statementShareBtn"><span class="btn-icon">${iconSvg("share")}</span><span>Share</span></button>` : ""}
      <button class="icon-text-btn primary" type="button" id="statementCsvBtn"><span class="btn-icon">${iconSvg("download")}</span><span>CSV</span></button>
    </div>
  `);

  const text = statementText(statement);
  qs("#statementCopyBtn")?.addEventListener("click", async () => {
    toast((await copyText(text)) ? "Statement copied." : "Could not copy.");
  });
  qs("#statementShareBtn")?.addEventListener("click", () => {
    navigator.share({ title: `Statement - ${client.name}`, text }).catch(() => {});
  });
  qs("#statementCsvBtn")?.addEventListener("click", () => exportClientStatement(statement));
}

function switchView(viewId, options = {}) {
  const nextView = viewRoutes[viewId] ? viewId : "dashboardView";
  ui.activeView = nextView;
  qsa(".view").forEach((view) => view.classList.toggle("active", view.id === nextView));
  qsa(".bottom-nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === nextView));
  saveUiState();

  if (options.updateRoute !== false) {
    const nextHash = `#${viewRoutes[nextView]}`;
    if (location.hash !== nextHash) {
      history.pushState(null, "", nextHash);
    }
  }
}

function toast(message) {
  const node = qs("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2400);
}

function exportLoanbook() {
  const rows = allAnalyses().map((row) => ({
    client: getClientName(row.loan.clientId),
    phone: getClient(row.loan.clientId)?.phone || "",
    issue_date: row.loan.issueDate,
    due_date: row.loan.dueDate,
    principal: row.terms.principal,
    interest_rate: row.loan.interestRate || 0,
    fees: row.terms.fees,
    revenue_due: row.terms.revenueDue,
    paid: row.paid,
    outstanding: row.outstanding,
    status: row.status,
    purpose: row.loan.purpose || ""
  }));
  downloadFile(`quickserve-loanbook-${todayISO()}.csv`, csvFromRows(rows), "text/csv");
}

function exportPayments() {
  const rows = allPaymentAllocations().map((row) => ({
    client: row.client?.name || "",
    loan_id: row.loan.id,
    payment_date: row.payment.date,
    amount: row.payment.amount,
    revenue_part: row.revenue,
    principal_part: row.principal,
    method: row.payment.method || "",
    reference: row.payment.reference || "",
    balance_after: row.outstandingAfter
  }));
  downloadFile(`quickserve-payments-${todayISO()}.csv`, csvFromRows(rows), "text/csv");
}

function backupData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Quickserve Cashloan Ledger",
    data: state
  };
  downloadFile(`quickserve-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function restoreData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const next = normalizeState(parsed.data || parsed);
      if (!Array.isArray(next.clients) || !Array.isArray(next.loans) || !Array.isArray(next.payments)) {
        throw new Error("Invalid backup");
      }
      if (!confirm("Restore this backup and replace the current phone data?")) return;
      state = next;
      saveState();
      render();
      toast("Backup restored.");
    } catch {
      toast("That backup file could not be restored.");
    } finally {
      qs("#restoreFile").value = "";
    }
  };
  reader.readAsText(file);
}

function refreshSpreadsheetImport() {
  const changed = applySpreadsheetImport();
  render();
  toast(changed ? "Import refreshed." : "Import already complete.");
}

function csvFromRows(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const body = rows.map((row) => headers.map((key) => csvCell(row[key])).join(","));
  return [headers.join(","), ...body].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Download started: ${filename}`);
}

function deleteClient(id) {
  if (state.loans.some((loan) => loan.clientId === id)) {
    toast("Delete this client's loans first.");
    return;
  }
  if (!confirm("Delete this client?")) return;
  state.clients = state.clients.filter((client) => client.id !== id);
  saveState();
  render();
  toast("Client deleted.");
}

function deleteLoan(id) {
  if (!confirm("Delete this loan and its payments?")) return;
  state.loans = state.loans.filter((loan) => loan.id !== id);
  state.payments = state.payments.filter((payment) => payment.loanId !== id);
  saveState();
  render();
  toast("Loan deleted.");
}

function deletePayment(id) {
  if (!confirm("Delete this payment?")) return;
  state.payments = state.payments.filter((payment) => payment.id !== id);
  saveState();
  render();
  toast("Payment deleted.");
}

function handleAction(action, id) {
  if (action === "edit-client") openClientForm(getClient(id));
  if (action === "client-loan") openLoanForm(null, id);
  if (action === "client-statement") openStatement(getClient(id));
  if (action === "delete-client") deleteClient(id);
  if (action === "edit-loan") openLoanForm(getLoan(id));
  if (action === "payment-for-loan") openPaymentForm(id);
  if (action === "write-off-loan") {
    const loan = getLoan(id);
    if (!loan || !confirm("Mark this loan as written off?")) return;
    loan.status = "written-off";
    saveState();
    render();
    toast("Loan written off.");
  }
  if (action === "reactivate-loan") {
    const loan = getLoan(id);
    if (!loan) return;
    loan.status = "active";
    saveState();
    render();
    toast("Loan reopened.");
  }
  if (action === "delete-loan") deleteLoan(id);
  if (action === "delete-payment") deletePayment(id);
  if (action === "delete-expense") deleteExpense(id);
  if (action === "delete-capital") deleteCapital(id);
}

function handleDashboardAction(action) {
  const currentMonth = monthKey(new Date());
  const currentYear = String(new Date().getFullYear());
  if (action === "capital-out" || action === "outstanding") {
    ui.loanFilter = "open";
    ui.loanMonth = "all";
    switchView("loansView");
    renderLoans();
    return;
  }
  if (action === "overdue") {
    ui.loanFilter = "overdue";
    ui.loanMonth = "all";
    switchView("loansView");
    renderLoans();
    return;
  }
  if (action === "due-month") {
    ui.loanFilter = "open";
    ui.loanMonth = currentMonth;
    switchView("loansView");
    renderLoans();
    return;
  }
  if (action === "revenue-month") {
    ui.paymentMonth = currentMonth;
    switchView("paymentsView");
    renderPayments();
    return;
  }
  if (action === "profit-month") {
    ui.reportScope = "month";
    ui.reportMonth = currentMonth;
    ui.reportYear = currentYear;
    saveUiState();
    switchView("reportsView");
    render();
    return;
  }
  if (action === "profit-year") {
    ui.reportScope = "year";
    ui.reportMonth = currentMonth;
    ui.reportYear = currentYear;
    saveUiState();
    switchView("reportsView");
    render();
    return;
  }
  if (action === "active-clients") {
    ui.clientSearch = "";
    qs("#clientSearch").value = "";
    switchView("clientsView");
    renderClients();
  }
}

// ---- Theme (light / dark / system) ----
function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function effectiveDark(theme = ui.theme) {
  return theme === "dark" || (theme === "auto" && systemPrefersDark());
}

function applyTheme(theme, persist = true) {
  ui.theme = ["light", "dark", "auto"].includes(theme) ? theme : "auto";
  document.documentElement.setAttribute("data-theme", ui.theme);
  const dark = effectiveDark(ui.theme);
  const meta = qs('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#000000" : "#f2f2f7");
  qsa("[data-theme-option]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeOption === ui.theme);
  });
  const toggleIcon = qs("#themeToggleBtn .btn-icon");
  if (toggleIcon) toggleIcon.innerHTML = iconSvg(dark ? "sun" : "moon");
  if (persist) saveUiState();
}

function toggleTheme() {
  applyTheme(effectiveDark() ? "light" : "dark");
}

function initTheme() {
  applyTheme(ui.theme, false);
  if (window.matchMedia) {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (ui.theme === "auto") applyTheme("auto", false);
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else if (query.addListener) query.addListener(onChange);
  }
}

// ---- PIN lock ----
const PIN_STORAGE_KEY = "quickserve_pin_v1";
const PIN_SESSION_KEY = "quickserve_unlocked_v1";
const PIN_MIN = 4;
const PIN_MAX = 6;

const lock = {
  mode: "unlock", // "unlock" | "set"
  step: "enter",  // "enter" | "confirm" (set mode)
  entry: "",
  firstEntry: "",
  onDone: null
};

function getPinRecord() {
  try {
    return JSON.parse(localStorage.getItem(PIN_STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}

function hasPin() {
  const record = getPinRecord();
  return Boolean(record && record.hash && record.salt);
}

function randomSalt() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function hashPin(pin, salt) {
  const text = `${salt}:${pin}`;
  try {
    if (window.crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // fall through to non-crypto hash (e.g. insecure context)
  }
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `s${h.toString(16)}`;
}

async function verifyPin(pin) {
  const record = getPinRecord();
  if (!record) return false;
  return (await hashPin(pin, record.salt)) === record.hash;
}

async function savePin(pin) {
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({ salt, hash, len: pin.length }));
}

function clearPin() {
  localStorage.removeItem(PIN_STORAGE_KEY);
  sessionStorage.removeItem(PIN_SESSION_KEY);
}

function isUnlocked() {
  return sessionStorage.getItem(PIN_SESSION_KEY) === "1";
}

function markUnlocked() {
  sessionStorage.setItem(PIN_SESSION_KEY, "1");
}

function buildPinPad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"];
  qs("#pinPad").innerHTML = keys
    .map((key) => {
      if (key === "back") return `<button type="button" class="pin-key util" data-pin-key="back" aria-label="Backspace">${iconSvg("backspace")}</button>`;
      if (key === "ok") return `<button type="button" class="pin-key ok" data-pin-key="ok" aria-label="Confirm">${iconSvg("check")}</button>`;
      return `<button type="button" class="pin-key" data-pin-key="${key}">${key}</button>`;
    })
    .join("");
}

function renderPinDots() {
  qs("#pinDots").innerHTML = Array.from({ length: PIN_MAX }, (_, i) =>
    `<span class="pin-dot ${i < lock.entry.length ? "filled" : ""}"></span>`
  ).join("");
}

function setLockText() {
  const title = qs("#lockTitle");
  const hint = qs("#lockHint");
  if (lock.mode === "unlock") {
    title.textContent = "Enter PIN";
    hint.textContent = "Unlock your loan book";
  } else if (lock.step === "enter") {
    title.textContent = hasPin() ? "New PIN" : "Choose a PIN";
    hint.textContent = `Enter ${PIN_MIN} to ${PIN_MAX} digits, then tap OK`;
  } else {
    title.textContent = "Confirm PIN";
    hint.textContent = "Enter the same PIN again";
  }
}

function setLockError(message) {
  qs("#lockError").textContent = message || "";
}

function showLock(mode, onDone = null) {
  lock.mode = mode;
  lock.step = "enter";
  lock.entry = "";
  lock.firstEntry = "";
  lock.onDone = onDone;
  buildPinPad();
  renderPinDots();
  setLockText();
  setLockError("");
  qs("#lockCancelBtn").hidden = mode !== "set";
  qs("#lockScreen").hidden = false;
  document.body.classList.add("locked");
}

function hideLock() {
  qs("#lockScreen").hidden = true;
  document.body.classList.remove("locked");
  lock.entry = "";
  lock.firstEntry = "";
  lock.onDone = null;
}

async function submitPin() {
  if (lock.mode === "unlock") {
    if (lock.entry.length < PIN_MIN) return;
    if (await verifyPin(lock.entry)) {
      markUnlocked();
      hideLock();
    } else {
      lock.entry = "";
      renderPinDots();
      setLockError("Wrong PIN. Try again.");
    }
    return;
  }

  if (lock.step === "enter") {
    if (lock.entry.length < PIN_MIN) {
      setLockError(`Use at least ${PIN_MIN} digits.`);
      return;
    }
    lock.firstEntry = lock.entry;
    lock.entry = "";
    lock.step = "confirm";
    setLockText();
    renderPinDots();
    return;
  }

  if (lock.entry !== lock.firstEntry) {
    lock.entry = "";
    lock.firstEntry = "";
    lock.step = "enter";
    setLockText();
    renderPinDots();
    setLockError("PINs did not match. Start again.");
    return;
  }

  await savePin(lock.entry);
  markUnlocked();
  const done = lock.onDone;
  hideLock();
  if (done) done();
}

async function handlePinKey(key) {
  if (key === "back") {
    lock.entry = lock.entry.slice(0, -1);
    setLockError("");
    renderPinDots();
    return;
  }
  if (key === "ok") {
    await submitPin();
    return;
  }
  if (lock.entry.length >= PIN_MAX) return;
  lock.entry += key;
  setLockError("");
  renderPinDots();
  if (lock.mode === "unlock") {
    const record = getPinRecord();
    if (record?.len && lock.entry.length === record.len) await submitPin();
  }
}

function startSetPin() {
  showLock("set", () => {
    updateSecurityUI();
    toast("PIN set. It is asked next time you open the app.");
  });
}

function removePin() {
  if (!hasPin()) return;
  if (!confirm("Remove the PIN lock? The app will open without a PIN.")) return;
  clearPin();
  updateSecurityUI();
  toast("PIN removed.");
}

function updateSecurityUI() {
  const on = hasPin();
  const status = qs("#pinStatusText");
  if (status) {
    status.textContent = on
      ? "PIN lock is on. It is asked each time the app opens on this device."
      : "PIN lock is off. Add a PIN to protect this device.";
  }
  const setBtn = qs("#setPinBtn");
  if (setBtn) setBtn.querySelector("span:last-child").textContent = on ? "Change PIN" : "Set PIN";
  const removeBtn = qs("#removePinBtn");
  if (removeBtn) removeBtn.hidden = !on;
}

function initSecurity() {
  updateSecurityUI();
  if (hasPin() && !isUnlocked()) showLock("unlock");
}

function bindEvents() {
  const handleNavActivation = (event) => {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const navItem = target?.closest?.(".bottom-nav [data-view]");
    if (!navItem) return;
    event.preventDefault();
    switchView(navItem.dataset.view);
  };

  qsa(".bottom-nav [data-view]").forEach((button) => {
    button.addEventListener("click", handleNavActivation);
  });

  document.addEventListener("pointerup", handleNavActivation);
  document.addEventListener("touchend", handleNavActivation);

  qs("#addClientBtn").addEventListener("click", () => openClientForm());
  qs("#addLoanBtn").addEventListener("click", () => openLoanForm());
  qs("#quickLoanBtn").addEventListener("click", () => openLoanForm());
  qs("#addPaymentBtn").addEventListener("click", () => openPaymentForm());
  qs("#quickPaymentBtn").addEventListener("click", () => openPaymentForm());
  qs("#closeSheetBtn").addEventListener("click", closeSheet);

  qs("#clientSearch").addEventListener("input", (event) => {
    ui.clientSearch = event.target.value;
    renderClients();
  });

  qsa("[data-loan-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.loanFilter = button.dataset.loanFilter;
      saveUiState();
      renderLoans();
    });
  });

  qsa("[data-report-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.reportScope = button.dataset.reportScope;
      saveUiState();
      renderPeriodControl();
      renderReports();
    });
  });

  qs("#periodPrev").addEventListener("click", () => stepPeriod(-1));
  qs("#periodNext").addEventListener("click", () => stepPeriod(1));

  window.addEventListener("hashchange", () => {
    const nextView = initialView(loadUiState());
    if (nextView !== ui.activeView) switchView(nextView, { updateRoute: false });
  });

  document.addEventListener("click", (event) => {
    const dashboardButton = event.target.closest("[data-dashboard-action]");
    if (dashboardButton) {
      handleDashboardAction(dashboardButton.dataset.dashboardAction);
      return;
    }

    const cashButton = event.target.closest("[data-cash-action]");
    if (cashButton) {
      if (cashButton.dataset.cashAction === "statement") openCashStatement();
      return;
    }

    const loanMonthButton = event.target.closest("[data-loan-month]");
    if (loanMonthButton) {
      ui.loanMonth = loanMonthButton.dataset.loanMonth;
      ui.loanFilter = "all";
      saveUiState();
      renderLoans();
      return;
    }

    const paymentMonthButton = event.target.closest("[data-payment-month]");
    if (paymentMonthButton) {
      ui.paymentMonth = paymentMonthButton.dataset.paymentMonth;
      saveUiState();
      renderPayments();
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton) handleAction(actionButton.dataset.action, actionButton.dataset.id);
  });

  qs("#sheet").addEventListener("click", (event) => {
    if (event.target.id === "sheet") closeSheet();
  });

  qs("#exportLoanbookBtn").addEventListener("click", exportLoanbook);
  qs("#exportPaymentsBtn").addEventListener("click", exportPayments);
  qs("#backupBtn").addEventListener("click", backupData);
  qs("#restoreBtn").addEventListener("click", () => {
    toast("Choose a backup file to restore.");
    qs("#restoreFile").click();
  });
  qs("#refreshImportBtn").addEventListener("click", refreshSpreadsheetImport);
  qs("#restoreFile").addEventListener("change", (event) => restoreData(event.target.files[0]));

  qs("#addExpenseBtn").addEventListener("click", openExpenseForm);
  qs("#exportExpensesBtn").addEventListener("click", exportExpenses);

  qs("#setCapitalBtn")?.addEventListener("click", openStartingCapitalForm);
  qs("#addCapitalInBtn")?.addEventListener("click", () => openCapitalForm("in"));
  qs("#addCapitalOutBtn")?.addEventListener("click", () => openCapitalForm("out"));
  qs("#viewStatementBtn")?.addEventListener("click", openCashStatement);

  qs("#themeToggleBtn")?.addEventListener("click", toggleTheme);
  qsa("[data-theme-option]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeOption));
  });

  qs("#setPinBtn").addEventListener("click", startSetPin);
  qs("#removePinBtn").addEventListener("click", removePin);
  qs("#pinPad").addEventListener("click", (event) => {
    const key = event.target.closest("[data-pin-key]");
    if (key) handlePinKey(key.dataset.pinKey);
  });
  qs("#lockCancelBtn").addEventListener("click", hideLock);
  document.addEventListener("keydown", (event) => {
    if (qs("#lockScreen").hidden) return;
    if (event.key >= "0" && event.key <= "9") handlePinKey(event.key);
    else if (event.key === "Backspace") handlePinKey("back");
    else if (event.key === "Enter") handlePinKey("ok");
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

initTheme();
bindEvents();
render();
switchView(ui.activeView);
initSecurity();
registerServiceWorker();
