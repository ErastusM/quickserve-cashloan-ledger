// Admin console credit desk (admin/index.html, part 2) — browser tests.
//
// Serves the repo root with a tiny static server so the console loads at /admin/,
// and stands in for Supabase and the intake Worker with page.route. The RPCs are a
// small stateful stand-in built on tests/fixtures/rpc-mocks.json (contract shapes)
// that follows docs/credit-desk/CONTRACT.md §3–§7: the state machine and
// allowed_actions, worksheet maths (the page's own QSCredit block, which matches
// the SQL), the owner's decision rules and the ledger booking. Covers the queue,
// the application file (documents, history, notes, WhatsApp), the worksheet,
// the owner's approval and Ready to disburse.
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/ui/admin-credit.test.js

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8");
const SB_URL = (/url:"(https:\/\/[a-z0-9]+\.supabase\.co)"/.exec(SRC) || [])[1];
const SB_KEY = (/key:"(sb_publishable_[A-Za-z0-9_]+)"/.exec(SRC) || [])[1];
const WORKER = (/var WORKER_BASE = "([^"]+)"/.exec(SRC) || [])[1];
const MOCKS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "rpc-mocks.json"), "utf8"));
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "credit-cases.json"), "utf8"));
const NOW = new Date(MOCKS.now);                        // 2026-09-28 10:00 Africa/Windhoek
const TODAY = "2026-09-28";
assert.ok(SB_URL && SB_KEY && WORKER, "Supabase URL, publishable key and WORKER_BASE found in admin/index.html");

// The page's own worksheet maths (pure block) — the stand-in database computes with it,
// exactly as private.assessment_compute would (they agree on every shared fixture).
const Q = (() => { const m = /<script id="credit-calc">([\s\S]*?)<\/script>/.exec(SRC); const w = {}; new Function("window", m[1])(w); return w.QSCredit; })();

const id = (n) => "a1000000-0000-4000-8000-0000000000" + String(n).padStart(2, "0");
const APP = { selma: id(1), johannes: id(2), maria: id(3), gerson: id(4), ndapewa: id(5), frans: id(6), loide: id(7), tomas: id(8), hilma: id(9), anna: id(10) };
const PEOPLE = {
  owner: { email: MOCKS.staff.owner.email, password: "owner-pass-123", token: "tok-owner", staff: MOCKS.staff.owner },
  analyst: { email: MOCKS.staff.analyst.email, password: "analyst-pass-123", token: "tok-analyst", staff: MOCKS.staff.analyst }
};
// What the fake Worker serves for GET /docs/<id>: a PNG, PDFs, and an HTML file posing as a statement.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2266fb60000000049454e44ae426082", "hex");
const DOC_BYTES = {
  "0d000000-0000-4000-8000-000000000001": ["image/png", PNG],
  "0d000000-0000-4000-8000-000000000002": ["application/pdf", Buffer.from("%PDF-1.4\n%payslip\n")],
  "0d000000-0000-4000-8000-000000000003": ["text/html; charset=utf-8", Buffer.from("<script>parent.__xss='doc'</script>")],
  "0d000000-0000-4000-8000-000000000004": ["application/pdf", Buffer.from("%PDF-1.4\n%july\n")],
  "0d000000-0000-4000-8000-000000000005": ["application/pdf", Buffer.from("%PDF-1.4\n%august\n")]
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── tiny static server for the repo root ────────────────────────────────────
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
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

// ── the stand-in database (contract §3 state machine, §4 rules, §7 booking) ──
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "apikey,authorization,content-type,prefer,x-client-info" };
const qsError = (code, message) => ({ status: 400, body: { code: "P0001", message: code + ": " + message, details: null, hint: null } });
const ok = (body) => ({ status: 200, body });
const ACTIONS = ["claim", "request_info", "resume", "save_assessment", "submit_assessment", "recall", "decide", "withdraw", "reopen", "disburse", "add_note", "mark_notified", "update_applicant"];
const TABS = ["open", "submitted", "in_review", "info_requested", "awaiting_approval", "approved", "closed"];
const OPEN = ["submitted", "in_review", "info_requested", "awaiting_approval", "approved"];
const PRE = ["submitted", "in_review", "info_requested", "awaiting_approval"];

function makeDb(mutate) {
  const db = clone(MOCKS);
  db.apps = new Map(db.applications.map((a) => [a.id, a]));
  db.seq = 0;
  if (mutate) mutate(db);
  return db;
}
function may(app, st, action, asm) {
  const owner = st.role === "owner", assignee = !!app.assigned_to && app.assigned_to === st.user_id;
  switch (action) {
    case "claim": return app.status === "submitted";
    case "request_info": return (owner || assignee) && app.status === "in_review";
    case "resume": return app.status === "info_requested";
    case "save_assessment": case "submit_assessment": return (owner || assignee) && app.status === "in_review";
    case "recall": return app.status === "awaiting_approval" && !!asm && asm.submitted_by === st.user_id;
    case "decide": return owner && PRE.includes(app.status);
    case "withdraw": return app.status === "approved" ? owner : PRE.includes(app.status);
    case "reopen": return owner && ["declined", "withdrawn"].includes(app.status);
    case "disburse": return owner && app.status === "approved";
    case "update_applicant": return app.status === "awaiting_approval" ? owner : ["submitted", "in_review", "info_requested"].includes(app.status);
    default: return true;   // add_note, mark_notified
  }
}
function bits(a) { return { consent_bureau: a.consent_bureau, amount_requested: a.amount_requested, bank_account_no: a.bank_account_no, pay_day: a.pay_day, employer: a.employer, kin_name: a.kin_name, kin_phone: a.kin_phone }; }
function nextRef(items, prefix) {
  let max = 0;
  for (const x of items || []) { const m = new RegExp("^" + prefix + "(\\d+)$").exec(String(x.ref || "")); if (m) max = Math.max(max, Number(m[1])); }
  return prefix + String(max + 1).padStart(4, "0");
}

function rpcHandler(db) {
  const now = () => NOW.toISOString();
  const newId = (p) => p + "0000-0000-4000-8000-" + String(++db.seq).padStart(12, "0");
  const asmOf = (appId) => db.assessments[appId] || null;
  const qsBalance = (appId) => Number((db.borrower_history[appId] || {}).qs_balance || 0);
  function timeline(appId, who, action, text) { (db.timeline[appId] = db.timeline[appId] || []).unshift({ at: now(), actor_name: who.staff.full_name, action, text }); }
  function note(appId, who, kind, body) {
    const n = { id: newId("dd"), kind, body, author_name: kind === "system" ? "System" : who.staff.full_name, created_at: now() };
    (db.notes[appId] = db.notes[appId] || []).unshift(n);
    return n;
  }
  function move(a, to) { a.status = to; a.status_changed_at = now(); a.updated_at = now(); }
  function get(p) { const a = db.apps.get(p.p_app_id); return a || null; }
  function row(a) {
    const k = db.kyc[a.id] || {}, h = db.borrower_history[a.id], asm = asmOf(a.id);
    const late = h ? h.matches.filter((m) => m.match === "id").reduce((s, m) => s + (m.summary.late_loans || 0), 0) : 0;
    return { id: a.id, ref: a.ref, status: a.status, submitted_at: a.submitted_at, status_changed_at: a.status_changed_at,
      age_hours: Math.round((NOW.getTime() - Date.parse(a.status_changed_at)) / 360000) / 10,
      full_name: a.full_name, national_id: a.national_id, phone: a.phone, employer: a.employer, declared_income: a.declared_income, amount_requested: a.amount_requested,
      assigned_to: a.assigned_to, assigned_name: a.assigned_name, returning: !!(k.ledger_match && k.ledger_match.loans > 0 && a.status !== "disbursed"),
      client_ref: k.ledger_match ? k.ledger_match.client_ref : null, late_loans: late, dup_open: (k.dup_open || []).length,
      recommendation: asm && asm.submitted_at ? asm.recommendation : null, hard_fail: !!(asm && asm.hard_fail_codes.length), above_limit: !!(asm && asm.owner_fail_codes.length) };
  }
  function computeFor(a, worksheet, terms) {
    const ws = clone(worksheet || {}); ws.commitments = Object.assign({}, ws.commitments, { b8: qsBalance(a.id) });
    return { ws, computed: Q.compute(ws, terms, bits(a), db.policy) };
  }

  return function rpc(name, p, who) {
    const st = who.staff, owner = st.role === "owner";
    const deny = qsError("QS_FORBIDDEN", "Only an owner can do this.");
    const a = p && p.p_app_id ? get(p) : null;
    const needApp = ["app_get", "app_claim", "app_request_info", "app_resume", "app_recall", "app_withdraw", "app_reopen", "app_add_note", "app_mark_notified",
      "app_timeline", "borrower_history", "assessment_save", "assessment_submit", "app_decide", "app_disburse_preview", "app_disburse", "app_update_applicant"];
    if (needApp.includes(name) && !a) return qsError("QS_NOT_FOUND", "That application doesn't exist.");
    const bad = () => qsError("QS_BAD_STATE", "This application is " + a.status.replace(/_/g, " ") + ", so that can't be done now.");
    switch (name) {
      case "whoami": return ok(clone(st));
      case "policy_get": return ok(db.policy);
      case "app_queue": {
        if (!TABS.includes(p.p_tab)) return qsError("QS_INVALID", "Unknown queue tab.");
        const all = [...db.apps.values()];
        const counts = { open: 0, submitted: 0, in_review: 0, info_requested: 0, awaiting_approval: 0, approved: 0, closed: 0 };
        for (const x of all) { if (OPEN.includes(x.status)) { counts.open++; counts[x.status]++; } else counts.closed++; }
        const q = String(p.p_search || "").trim().toLowerCase(), qid = normId(q);
        const rows = all.filter((x) => p.p_tab === "open" ? OPEN.includes(x.status) : p.p_tab === "closed" ? !OPEN.includes(x.status) : x.status === p.p_tab)
          .filter((x) => !q || x.full_name.toLowerCase().includes(q) || x.ref.toLowerCase().includes(q) || (qid.length >= 3 && normId(x.national_id).includes(qid)))
          .sort((x, y) => y.submitted_at.localeCompare(x.submitted_at)).map(row);
        return ok({ counts, rows });
      }
      case "app_get": {
        const asm = asmOf(a.id);
        return ok({ application: clone(a), documents: clone(db.documents[a.id] || []), assessment: asm ? clone(asm) : null, decisions: clone(db.decisions[a.id] || []),
          notes: clone(db.notes[a.id] || []), kyc: clone(db.kyc[a.id]), policy: clone(db.policy), allowed_actions: ACTIONS.filter((x) => may(a, st, x, asm)),
          me: { user_id: st.user_id, role: st.role } });
      }
      case "app_timeline": return ok(clone(db.timeline[a.id] || []));
      case "borrower_history": return ok(clone(db.borrower_history[a.id] || { matches: [], qs_balance: 0 }));
      case "app_claim":
        if (!may(a, st, "claim")) return bad();
        move(a, "in_review"); a.assigned_to = st.user_id; a.assigned_name = st.full_name; a.assigned_at = now();
        note(a.id, who, "system", "Picked up by " + st.full_name + "."); timeline(a.id, who, "app.claimed", "Picked up by " + st.full_name);
        return ok(clone(a));
      case "app_request_info":
        if (!may(a, st, "request_info")) return bad();
        if (String(p.p_note || "").trim().length < 10) return qsError("QS_INVALID", "Write what the applicant must send or explain (at least 10 characters).");
        move(a, "info_requested"); note(a.id, who, "info_request", p.p_note.trim()); timeline(a.id, who, "app.info_requested", "Asked the applicant for more: " + p.p_note.trim());
        return ok(clone(a));
      case "app_resume":
        if (!may(a, st, "resume")) return bad();
        move(a, "in_review"); if (p.p_note) note(a.id, who, "note", p.p_note);
        return ok(clone(a));
      case "app_recall":
        if (!may(a, st, "recall", asmOf(a.id))) return bad();
        move(a, "in_review"); return ok(clone(a));
      case "app_withdraw":
        if (!may(a, st, "withdraw")) return bad();
        if (String(p.p_reason || "").trim().length < 10) return qsError("QS_INVALID", "Write why it is being withdrawn (at least 10 characters).");
        move(a, "withdrawn"); note(a.id, who, "system", "Withdrawn by " + st.full_name + ": " + p.p_reason.trim());
        return ok(clone(a));
      case "app_reopen":
        if (!owner) return deny;
        if (!may(a, st, "reopen")) return bad();
        if (String(p.p_reason || "").trim().length < 10) return qsError("QS_INVALID", "Write why it is being reopened (at least 10 characters).");
        move(a, "in_review"); return ok(clone(a));
      case "app_add_note": {
        if (!String(p.p_body || "").trim()) return qsError("QS_INVALID", "Write a note (at least 1 characters).");
        const n = note(a.id, who, "note", String(p.p_body).trim()); timeline(a.id, who, "note.added", "Note: " + n.body.slice(0, 200));
        return ok(n);
      }
      case "app_mark_notified":
        if (!["whatsapp", "phone", "in_person"].includes(p.p_via)) return qsError("QS_INVALID", "Say how the applicant was told.");
        a.notified_at = now(); a.notified_via = p.p_via; a.notified_by = st.user_id;
        return ok(clone(a));
      case "app_update_applicant":
        if (!may(a, st, "update_applicant")) return bad();
        Object.assign(a, p.p_patch); return ok(clone(a));
      case "assessment_save": {
        if (!may(a, st, "save_assessment")) return qsError("QS_FORBIDDEN", "Only the analyst who picked this up, or an owner, can work on the worksheet.");
        const r = computeFor(a, p.p_worksheet, p.p_terms);
        let asm = asmOf(a.id);
        if (!asm || asm.submitted_at) {
          asm = db.assessments[a.id] = { id: newId("bb"), application_id: a.id, version: (asm ? asm.version : 0) + 1, recommendation: null, reasons: null, motivation: null, declaration: null,
            created_at: now(), created_by: st.user_id, submitted_at: null, submitted_by: null, submitted_by_name: null };
        }
        Object.assign(asm, { worksheet: r.ws, terms: clone(p.p_terms), computed: r.computed, updated_at: now(), updated_by: st.user_id, updated_by_name: st.full_name,
          hard_fail_codes: r.computed.hard_fail_codes, owner_fail_codes: r.computed.owner_fail_codes, soft_fail_codes: r.computed.soft_fail_codes });
        return ok({ version: asm.version, computed: r.computed, updated_at: asm.updated_at });
      }
      case "assessment_submit": {
        const asm = asmOf(a.id);
        if (!may(a, st, "submit_assessment")) return bad();
        if (!asm) return qsError("QS_INVALID", "Save the worksheet before sending it for approval.");
        if (!["approve", "approve_above_limit", "approve_reduced", "decline", "refer"].includes(p.p_recommendation)) return qsError("QS_INVALID", "Choose a recommendation.");
        if (String(p.p_reasons || "").trim().length < 60) return qsError("QS_INVALID", "Write your reasons (at least 60 characters).");
        if (!p.p_declaration || [1, 2, 3, 4, 5, 6, 7].some((i) => p.p_declaration["d12_" + i] !== true)) return qsError("QS_INVALID", "Tick every line of the declaration (12.1 to 12.7).");
        const r = computeFor(a, asm.worksheet, asm.terms), c = r.computed;
        if (p.p_recommendation.startsWith("approve") && c.hard_fail_codes.length) return qsError("QS_HARD_FAIL", "A rule that can't be overridden fails (" + c.hard_fail_codes.join(", ") + "). Recommend a decline.");
        if (["approve", "approve_reduced"].includes(p.p_recommendation) && c.owner_fail_codes.length) return qsError("QS_OVERRIDE_REQUIRED", "The repayment is above the affordability limit.");
        if (p.p_recommendation === "approve_above_limit" && (!c.owner_fail_codes.length || String(p.p_motivation || "").trim().length < 60)) return qsError("QS_INVALID", "Write your motivation for going above the limit (at least 60 characters).");
        Object.assign(asm, { recommendation: p.p_recommendation, reasons: p.p_reasons.trim(), motivation: p.p_motivation ? p.p_motivation.trim() : null, declaration: p.p_declaration,
          submitted_at: now(), submitted_by: st.user_id, submitted_by_name: st.full_name, computed: c });
        move(a, "awaiting_approval");
        return ok({ version: asm.version, computed: c });
      }
      case "app_decide": {
        if (!owner) return deny;
        const asm = asmOf(a.id), action = { approved: "approve", declined: "decline", returned: "return" }[p.p_outcome];
        if (!action) return qsError("QS_INVALID", "The outcome must be approved, declined or returned.");
        if (action === "decline" ? !PRE.includes(a.status) : a.status !== "awaiting_approval") return bad();
        if ((p.p_assessment_version || 0) !== (asm ? asm.version : 0)) return qsError("QS_STALE", "The worksheet changed since you opened it (it is now version " + (asm ? asm.version : 0) + "). Reload the file and check it again.");
        const override = String(p.p_override_note || "").trim(), reasons = String(p.p_reasons || "").trim();
        let terms = asm ? asm.terms : null, computed = asm ? asm.computed : null, codes = [];
        if (p.p_outcome === "approved") {
          terms = Object.assign({}, asm.terms, p.p_terms || {});
          computed = computeFor(a, asm.worksheet, terms).computed;
          if (computed.hard_fail_codes.length) return qsError("QS_HARD_FAIL", "A rule that can't be overridden fails (" + computed.hard_fail_codes.join(", ") + "). This can't be approved.");
          if (computed.owner_fail_codes.length && (asm.recommendation !== "approve_above_limit" || String(asm.motivation || "").length < 60)) return qsError("QS_OVERRIDE_REQUIRED", "The repayment is above the affordability limit, and the assessor did not motivate for it.");
          if ((computed.owner_fail_codes.length || computed.soft_fail_codes.length) && override.length < 20) return qsError("QS_OVERRIDE_REQUIRED", "Write an override note (at least 20 characters).");
          codes = computed.owner_fail_codes.concat(computed.soft_fail_codes);
          move(a, "approved");
        } else if (p.p_outcome === "declined") {
          if (!["afford", "docs", "history", "other"].includes(p.p_reason_to_applicant)) return qsError("QS_INVALID", "Choose the reason the applicant will be given.");
          if (reasons.length < 20) return qsError("QS_INVALID", "Write your reasons for declining (at least 20 characters).");
          move(a, "declined");
        } else {
          if (reasons.length < 10) return qsError("QS_INVALID", "Tell the analyst what to look at again (at least 10 characters).");
          move(a, "in_review");
        }
        const dec = { id: newId("cc"), application_id: a.id, assessment_id: asm ? asm.id : null, assessment_version: asm ? asm.version : 0, outcome: p.p_outcome, terms, computed,
          reasons: reasons || null, reason_to_applicant: p.p_outcome === "declined" ? p.p_reason_to_applicant : null, override_note: p.p_outcome === "approved" ? (override || null) : null,
          overridden_codes: codes, self_assessed: !!asm && asm.submitted_by === st.user_id, decided_by: st.user_id, decided_at: now(), decided_by_name: st.full_name };
        (db.decisions[a.id] = db.decisions[a.id] || []).unshift(dec);
        return ok(dec);
      }
      case "app_disburse_preview":
      case "app_disburse": {
        if (!owner) return deny;
        if (!may(a, st, "disburse")) return bad();
        const data = db.ledger.data, dec = (db.decisions[a.id] || []).find((x) => x.outcome === "approved");
        const terms = Object.assign({}, dec.terms, { issue_date: p.p_issue_date, due_date: p.p_due_date });
        const c = Q.compute((asmOf(a.id) || {}).worksheet, terms, bits(a), db.policy), res = (code) => c.rules.find((r) => r.code === code).result === "pass";
        const checks = { G1: res("G1"), G2: res("G2"), G3: res("G3"), issue_not_future: !!p.p_issue_date && p.p_issue_date <= TODAY };
        const matches = data.clients.filter((x) => normId(x.nationalId) && normId(x.nationalId) === normId(a.national_id));
        if (name === "app_disburse_preview") {
          return ok({ client_match: { mode: matches.length === 0 ? "new" : matches.length === 1 ? "existing" : "ambiguous",
            candidates: matches.map((x) => ({ id: x.id, ref: x.ref, name: x.name, national_id: x.nationalId, loans: data.loans.filter((l) => l.clientId === x.id).length })) },
            next_client_ref: nextRef(data.clients, "QS-"), next_loan_ref: nextRef(data.loans, "QSL-"),
            terms: { principal: terms.principal, interest_rate: terms.interest_rate, service_fee: terms.service_fee, total_repayable: c.e7 }, checks });
        }
        if (!p.p_checklist || Array.from({ length: 10 }, (_, i) => "13." + (i + 1)).some((k) => p.p_checklist[k] !== true)) return qsError("QS_INVALID", "Tick all 10 checklist items (13.1 to 13.10) before paying out.");
        if (!["Cash", "Bank transfer", "E-wallet", "Other"].includes(p.p_method)) return qsError("QS_INVALID", "Choose how the money was paid out.");
        if (p.p_method !== "Cash" && String(p.p_reference || "").trim().length < 3) return qsError("QS_INVALID", "Add the payment reference (at least 3 characters).");
        if (!checks.issue_not_future) return qsError("QS_INVALID", "The issue date can't be in the future.");
        if (!checks.G1 || !checks.G2 || !checks.G3) return qsError("QS_HARD_FAIL", "The loan breaks a legal limit.");
        const created = now();
        let client;
        if (!p.p_new_client && p.p_client_id) { client = data.clients.find((x) => x.id === p.p_client_id); if (!client) return qsError("QS_NOT_FOUND", "That client isn't in the ledger."); }
        else if (!p.p_new_client && matches.length > 1) return qsError("QS_AMBIGUOUS_CLIENT", "More than one client in the ledger has this ID number.");
        else if (!p.p_new_client && matches.length === 1) client = matches[0];
        if (!client) {
          client = { id: "client_mock" + db.seq, ref: nextRef(data.clients, "QS-"), createdAt: created, name: a.full_name, phone: a.phone, nationalId: a.national_id, employer: a.employer || "",
            address: a.address || "", nextOfKin: a.kin_name ? a.kin_name + " (" + a.kin_phone + ")" : "", notes: "From application " + a.ref + " (" + TODAY + ")" };
          data.clients.push(client);
        }
        const loan = { id: "loan_mock" + (++db.seq), ref: nextRef(data.loans, "QSL-"), createdAt: created, status: "active", clientId: client.id, principal: terms.principal,
          interestRate: terms.interest_rate, serviceFee: terms.service_fee, issueDate: p.p_issue_date, dueDate: p.p_due_date, purpose: a.purpose || "", applicationId: a.id,
          applicationRef: a.ref, payoutMethod: p.p_method, payoutReference: p.p_reference || "" };
        data.loans.push(loan); data.updatedAt = created; db.ledger.rev += 1;
        Object.assign(a, { client_id: client.id, client_ref: client.ref, loan_id: loan.id, loan_ref: loan.ref, payout_method: p.p_method, payout_reference: p.p_reference, disbursed_at: created, disbursed_by: st.user_id });
        move(a, "disbursed");
        return ok({ loan_id: loan.id, loan_ref: loan.ref, client_id: client.id, client_ref: client.ref, ledger_rev: db.ledger.rev });
      }
      default: return { status: 404, body: { code: "PGRST202", message: "Could not find the function public." + name } };
    }
  };
}

async function fakeBackend(page, opts = {}) {
  const db = makeDb(opts.mutate);
  const handle = rpcHandler(db);
  const log = { rpc: [], ledger: [], worker: [], wa: [] };
  const calls = (name) => log.rpc.filter((c) => c.name === name);

  await page.route((u) => u.href.startsWith(SB_URL + "/"), async (route) => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const auth = (req.headers().authorization || "").replace(/^Bearer /, "");
    const who = Object.values(PEOPLE).find((x) => x.token === auth) || null;
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const reply = (status, json) => route.fulfill({ status, headers: CORS, contentType: "application/json", body: json === undefined ? "" : JSON.stringify(json) });
    assert.equal(req.headers().apikey, SB_KEY, "publishable apikey on every Supabase call");
    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "refresh_token") return reply(400, { error_description: "Invalid Refresh Token" });
      const x = Object.values(PEOPLE).find((y) => y.email === body.email && y.password === body.password);
      return x ? reply(200, { access_token: x.token, refresh_token: "r-" + x.token, expires_in: 3600, user: { email: x.email } }) : reply(400, { error_description: "Invalid login credentials" });
    }
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      log.rpc.push({ name, params: body, token: auth });
      if (!who) return reply(401, { code: "PGRST301", message: "JWT invalid" });
      const r = handle(name, body || {}, who);
      return reply(r.status, r.body);
    }
    if (url.pathname === "/rest/v1/ledger") {
      log.ledger.push({ method, token: auth, at: log.rpc.length });
      const owner = who && who.staff.role === "owner";
      if (method === "GET") return reply(200, owner ? [{ data: db.ledger.data, rev: db.ledger.rev }] : []);
      return reply(200, []);
    }
    return reply(404, { message: "not mocked: " + method + " " + url.pathname });
  });
  await page.route((u) => u.href.startsWith(WORKER + "/"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    log.worker.push({ method: req.method(), path: url.pathname, auth: req.headers().authorization || "", type: req.resourceType(), nav: req.isNavigationRequest() });
    const doc = /^\/docs\/([^/]+)$/.exec(url.pathname);
    if (doc && req.method() === "GET") {
      if (!/^Bearer tok-(owner|analyst)$/.test(req.headers().authorization || "")) return route.fulfill({ status: 401, headers: CORS, contentType: "application/json", body: '{"error":"unauthorized"}' });
      const d = DOC_BYTES[doc[1]];
      if (d) return route.fulfill({ status: 200, headers: Object.assign({ "Content-Type": d[0], "X-Content-Type-Options": "nosniff" }, CORS), body: d[1] });
    }
    return route.fulfill({ status: 404, headers: CORS, contentType: "application/json", body: '{"error":"not_found"}' });
  });
  await page.route("https://wa.me/**", (route) => { log.wa.push(route.request().url()); return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }); });
  return { db, log, calls };
}

// ── harness ────────────────────────────────────────────────────────────────
let browser, server, base;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function openConsole(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "Africa/Windhoek", acceptDownloads: true });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.problems = [];
  page.requests = [];
  page.on("pageerror", (e) => page.problems.push("page error: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) page.problems.push("console error: " + m.text()); });
  page.on("request", (r) => {
    const u = r.url();
    page.requests.push({ method: r.method(), url: u, type: r.resourceType(), nav: r.isNavigationRequest() });
    if (!u.startsWith(base) && !u.startsWith(SB_URL) && !u.startsWith(WORKER) && !u.startsWith("blob:") && !u.startsWith("data:") && !u.startsWith("https://wa.me/")) page.problems.push("unexpected external request: " + u);
  });
  page.on("dialog", (d) => { (page.dialogs = page.dialogs || []).push(d.message()); d.accept(); });
  const backend = await fakeBackend(page, opts);
  await page.goto(base + "/admin/" + (opts.hash || ""));
  return { context, page, backend };
}
async function signedIn(page, who) {
  await page.fill("#email", who.email);
  await page.fill("#password", who.password);
  await page.click("#signInBtn");
  await page.waitForFunction(() => window.__admin && window.__admin.me() && window.__admin.route().name);
}
async function closeConsole(page) {
  const problems = page.problems;
  await page.context().close();
  assert.deepEqual(problems, [], "browser reported problems");
}
async function goHash(page, h) { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(60); }
const hash = (page) => page.evaluate(() => location.hash);
const ledgerHits = (page) => page.requests.filter((r) => r.url.includes("/rest/v1/ledger"));
const last = (backend, name) => { const c = backend.calls(name); assert.ok(c.length, name + " was called"); return c[c.length - 1].params; };
async function waitCalls(backend, name, n) { for (let i = 0; i < 100 && backend.calls(name).length < n; i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(backend.calls(name).length >= n, name + " called " + n + "×"); }
const amtText = (n) => (n < 0 ? "−" : "") + "N$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const outVal = (page, key) => page.locator('#wsResult [data-out="' + key + '"]').getAttribute("data-val");
const outText = (page, key) => page.locator('#wsResult [data-out="' + key + '"]').innerText();
async function yn(page, pathKey, v) { await page.click('[data-yn="' + pathKey + '"] button[data-v="' + v + '"]'); }
async function tick(page, sel, on) { const box = page.locator(sel); if ((await box.isChecked()) !== on) await box.click(); }

// Fill every worksheet line from a contract §4 worksheet + terms, the way an analyst would.
async function fillWorksheet(page, w, t) {
  const nums = { income: ["a1", "a2", "a3", "a5", "a7"], commitments: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b9", "b10", "b11"], living: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"] };
  for (const [sec, keys] of Object.entries(nums)) for (const k of keys) await page.fill('input[data-ws="' + sec + "." + k + '"]', String(w[sec][k]));
  await page.fill('input[data-ws="living.dependants"]', String(w.living.dependants));
  for (const k of ["d2_1", "d2_2", "d2_3", "d2_4", "d2_5"]) await tick(page, 'input[data-cb="docs.' + k + '"]', w.docs[k] === true);
  for (const k of ["d2_6", "d2_7"]) await yn(page, "docs." + k, String(w.docs[k]));
  for (const k of ["v2_8", "v2_9", "v2_10"]) await yn(page, "verify." + k, String(w.verify[k]));
  await yn(page, "living.credible", String(w.living.credible));
  for (let i = 1; i <= 7; i++) await yn(page, "flags.f8_" + i, String(w.flags["f8_" + i]));
  await yn(page, "conduct.g9", w.conduct.g9);
  await tick(page, 'input[data-cb="conduct.g10"]', w.conduct.g10 === true);
  await tick(page, 'input[data-cb="conduct.g11"]', w.conduct.g11 === true);
  for (const k of ["principal", "interest_rate", "service_fee"]) await page.fill('input[data-term="' + k + '"]', String(t[k]));
  for (const k of ["issue_date", "due_date"]) await page.fill('input[data-term="' + k + '"]', t[k]);
}
async function declare(page) { for (let i = 1; i <= 7; i++) await tick(page, 'input[data-decl="d12_' + i + '"]', true); }
const REASONS = "Verified income from the bank average, lower than the payslip net. After commitments and living costs the repayment stays inside the limit. Returning borrower with one loan paid 4 days late.";

// ── queue ──────────────────────────────────────────────────────────────────
test("analyst queue: tabs with counts, flags, amber waiting, debounced search; Pick up claims and opens the file", async () => {
  const { page, backend } = await openConsole();
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('[data-page="credit"] tr[data-app]');
  assert.equal(await hash(page), "#credit");
  assert.deepEqual(last(backend, "app_queue"), { p_tab: "open" });
  const rows = page.locator("#cqBody tr[data-app]");
  assert.equal(await rows.count(), 9, "every open application");
  assert.match(await page.locator("#cqTabs").innerText(), /All open\s*9[\s\S]*New\s*4[\s\S]*In review\s*1[\s\S]*Waiting on applicant\s*1[\s\S]*Awaiting approval\s*2[\s\S]*Ready to disburse\s*1[\s\S]*Closed\s*2/);
  assert.equal(await page.locator("#badge_credit").innerText(), "9");
  assert.match(await page.locator("#cqStats").innerText(), /Waiting to be picked up\s*4[\s\S]*Oldest 30 h — past the 24 h target[\s\S]*My files in review\s*1[\s\S]*Waiting on applicant\s*1[\s\S]*With the owner\s*2/i);
  assert.match(await page.locator("#pageSub").innerText(), /Mon 28 Sep 2026 · 9 open · 9 shown/);

  const selma = page.locator('tr[data-app="' + APP.selma + '"]');
  assert.match(await selma.innerText(), /QSA-7K2M9P[\s\S]*Selma Nangolo[\s\S]*ID 890312 00457[\s\S]*4,000[\s\S]*Rössing Uranium[\s\S]*N\$18,400 \/ month[\s\S]*RETURNING[\s\S]*1 LATE[\s\S]*NEW/i);
  assert.match(await page.locator('tr[data-app="' + APP.maria + '"]').innerText(), /DUPLICATE ID/i);
  assert.match(await page.locator('tr[data-app="' + APP.gerson + '"]').innerText(), /ABOVE LIMIT[\s\S]*Recommends: approve above the limit/i);
  assert.match(await page.locator('tr[data-app="' + APP.ndapewa + '"]').innerText(), /HARD FAIL/i);
  // Waiting turns amber past the 24 h target (Johannes 26 h, Frans 50 h), not before (Selma 2 h).
  assert.equal(await page.locator('tr[data-app="' + APP.johannes + '"] td.wait').getAttribute("data-late"), "1");
  assert.match(await page.locator('tr[data-app="' + APP.frans + '"] td.wait').innerText(), /^2 d$/);
  assert.equal(await page.locator('tr[data-app="' + APP.frans + '"] td.wait').getAttribute("data-late"), "1");
  assert.equal(await page.locator('tr[data-app="' + APP.selma + '"] td.wait').getAttribute("data-late"), null);
  assert.equal(await page.locator('tr[data-app="' + APP.hilma + '"] td.asg').innerText(), "You");
  // An analyst gets Pick up on new files and Open otherwise — never Decide or Pay out.
  assert.equal(await page.locator("#cqBody [data-claim]").count(), 4);
  assert.equal(await page.locator('#cqBody a.btn[href^="#approval/"], #cqBody [data-payout]').count(), 0);
  assert.equal(await page.locator('tr[data-app="' + APP.loide + '"] a.btn').innerText(), "Open");

  // Search is debounced: one request for the whole word.
  const before = backend.calls("app_queue").length;
  await page.locator("#cqSearch").pressSequentially("nangolo", { delay: 40 });
  await page.waitForTimeout(600);
  const searches = backend.calls("app_queue").slice(before);
  assert.deepEqual(searches.map((c) => c.params), [{ p_tab: "open", p_search: "nangolo" }], "a single debounced search");
  assert.equal(await rows.count(), 1);
  await page.fill("#cqSearch", "");
  await page.waitForTimeout(500);
  assert.equal(await rows.count(), 9);

  // Tabs are routes.
  await page.click('#cqTabs [data-tab="in_review"]');
  await page.waitForFunction(() => location.hash === "#credit/in_review");
  await page.waitForSelector('[data-page="credit"][data-arg="in_review"] tr[data-app]');
  assert.deepEqual(last(backend, "app_queue"), { p_tab: "in_review" });
  assert.equal(await rows.count(), 1);
  await page.click('#cqTabs [data-tab="closed"]');
  await page.waitForSelector('[data-page="credit"][data-arg="closed"] tr[data-app]');
  assert.equal(await rows.count(), 2);
  assert.match(await page.locator('tr[data-app="' + APP.tomas + '"]').innerText(), /Disbursed/i);

  // Pick up: app_claim, then the file opens.
  await page.click('#cqTabs [data-tab="open"]');
  await page.waitForSelector('[data-page="credit"][data-arg="open"] [data-claim="' + APP.selma + '"]');
  await page.click('[data-claim="' + APP.selma + '"]');
  await page.waitForFunction((x) => location.hash === "#app/" + x, APP.selma);
  assert.deepEqual(last(backend, "app_claim"), { p_app_id: APP.selma });
  await page.waitForSelector('[data-page="app"] #kycPanel');
  assert.equal(await page.locator("#pageTitle").innerText(), "Selma Nangolo");
  assert.match(await page.locator("#pageSub").innerText(), /QSA-7K2M9P · N\$4,000 requested · received Mon 28 Sep 07:01 · picked up by you 10:00/);
  assert.deepEqual(ledgerHits(page), [], "no /rest/v1/ledger request in an analyst session");
  await closeConsole(page);
});

// ── application file ───────────────────────────────────────────────────────
test("application file: KYC, details, history, documents through the Worker (Bearer, blob, never navigated), notes, WhatsApp request", async () => {
  const { page, backend } = await openConsole({ hash: "#app/" + APP.selma, mutate: (db) => {
    const a = db.apps.get(APP.selma); Object.assign(a, { status: "in_review", assigned_to: PEOPLE.analyst.staff.user_id, assigned_name: "Tuyeni Shikongo", assigned_at: NOW.toISOString() });
  } });
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('[data-page="app"] #kycPanel');
  const url = page.url();
  // Header actions come only from allowed_actions.
  const acts = await page.locator(".filebar [data-act]").evaluateAll((els) => els.map((e) => e.getAttribute("data-act")));
  assert.deepEqual(acts, ["ask", "edit", "withdraw", "worksheet"]);
  assert.match(await page.locator(".filebar").innerText(), /Credit queue \/ QSA-7K2M9P[\s\S]*IN REVIEW[\s\S]*RETURNING · QS-0019/i);
  // KYC: 7 checks, from kyc + staff confirmations.
  assert.equal(await page.locator("#kycPanel .chk").count(), 7);
  assert.match(await page.locator("#kycPanel .ph").innerText(), /4 of 7 clear/);
  assert.match(await page.locator('.chk[data-check="age"]').innerText(), /Born 12 Mar 1989 · 37 years old · policy allows 18–70/);
  assert.equal(await page.locator('.chk[data-check="phone"]').getAttribute("data-state"), "warn");
  assert.match(await page.locator('.chk[data-check="phone"]').innerText(), /\+264 81 234 5678 is also on client QS-0031 \(Aina Nangolo, different ID\)/);
  await page.click('[data-kyc="name"]');
  await page.waitForSelector('.chk[data-check="name"][data-state="ok"]');
  assert.deepEqual(last(backend, "app_add_note"), { p_app_id: APP.selma, p_body: "KYC check: the name on the ID matches the application." });
  assert.match(await page.locator("#kycPanel .ph").innerText(), /5 of 7 clear/);
  await page.click('[data-kyc="employer"]');
  await page.fill("#f_reason", "By phone with Rössing HR — permanent since 2019");
  await page.click("#modalSave");
  await page.waitForSelector('.chk[data-check="employer"][data-state="ok"]');
  assert.deepEqual(last(backend, "app_add_note"), { p_app_id: APP.selma, p_body: "KYC check: employer confirmed — By phone with Rössing HR — permanent since 2019" });
  assert.match(await page.locator('.chk[data-check="employer"]').innerText(), /By phone with Rössing HR — permanent since 2019 · Tuyeni Shikongo 10:00/);
  // Details: the account number is masked until asked for.
  assert.match(await page.locator("#detailsPanel").innerText(), /FNB Namibia ••••4567[\s\S]*Martha Nangolo \(mother\) · \+264 85 612 3390/);
  // Borrower history, with the lock note.
  await page.waitForSelector('#histPanel table[data-history="QS-0019"]');
  assert.deepEqual(last(backend, "borrower_history"), { p_app_id: APP.selma });
  const hist = await page.locator("#histPanel").innerText();
  assert.match(hist, /client QS-0019 · matched by ID number[\s\S]*Loans\s*3[\s\S]*Borrowed\s*N\$9,500[\s\S]*Repaid\s*N\$12,350[\s\S]*Late payments\s*1 \(4 days\)[\s\S]*Owing now\s*N\$0/i);
  assert.match(hist, /QSL-0027[\s\S]*4 DAYS LATE/i);
  assert.match(hist, /Possible match by phone: QS-0031 · Aina Nangolo/);
  assert.match(hist, /Only this borrower's own record is shown/);

  // Documents: fetched from the Worker with the analyst's token, re-wrapped, never navigated to.
  assert.equal(await page.locator("#docsPanel .doc[data-doc]").count(), 5);
  assert.match(await page.locator("#docsPanel .ph").innerText(), /5 uploaded · 1 optional missing/);
  await page.click('[data-view="0d000000-0000-4000-8000-000000000001"]');
  const img = page.locator("#docView .stage img");
  await img.waitFor();
  assert.match(await img.getAttribute("src"), /^blob:/);
  assert.equal(await page.locator('.doc[data-doc="0d000000-0000-4000-8000-000000000001"] [data-seen]').innerText(), "Viewed by you just now");
  await page.click("#docView button:has-text('Open full size')");
  assert.match(await page.locator("#lightbox img").getAttribute("src"), /^blob:/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#lightbox").count(), 0);
  // A PDF opens in a new tab from the blob (window.open is stubbed to record where it goes).
  await page.evaluate(() => { window.__opened = []; window.open = () => ({ opener: {}, location: { replace: (u) => window.__opened.push(u) }, close() {} }); });
  await page.click('[data-view="0d000000-0000-4000-8000-000000000002"]');
  await page.waitForFunction(() => window.__opened.length === 1);
  assert.match(await page.evaluate(() => window.__opened[0]), /^blob:/);
  assert.match(await page.locator("#docView .stage").innerText(), /The PDF opened in a new tab/);
  // An HTML file posing as a statement is only offered as a download of an octet-stream blob.
  await page.click('[data-view="0d000000-0000-4000-8000-000000000003"]');
  await page.waitForSelector("#docDownload");
  assert.match(await page.locator("#docView .stage").innerText(), /can't be shown in the browser/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#docDownload")]);
  assert.equal(download.suggestedFilename(), "bank-1.bin");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "document bytes never ran as HTML");
  const docCalls = backend.log.worker.filter((w) => w.path.startsWith("/docs/"));
  assert.deepEqual(docCalls.map((w) => w.path), ["/docs/0d000000-0000-4000-8000-000000000001", "/docs/0d000000-0000-4000-8000-000000000002", "/docs/0d000000-0000-4000-8000-000000000003"]);
  assert.ok(docCalls.every((w) => w.auth === "Bearer tok-analyst" && w.type === "fetch" && !w.nav), "fetched with the analyst's Bearer token, never as a navigation");
  assert.equal(page.url(), url, "the page never navigated to the Worker");
  assert.ok(!page.requests.some((r) => r.nav && r.url.startsWith(WORKER)), "no navigation to WORKER_BASE");

  // Notes are stored and shown as text.
  await page.fill("#noteBox", "Spoke to <b>HR</b> — salary confirmed.");
  await page.click("#addNoteBtn");
  await page.locator("#noteList .note", { hasText: "Spoke to <b>HR</b> — salary confirmed." }).waitFor();
  assert.deepEqual(last(backend, "app_add_note"), { p_app_id: APP.selma, p_body: "Spoke to <b>HR</b> — salary confirmed." });
  assert.equal(await page.locator("#noteList b:has-text('HR')").count(), 0, "a note is text, not HTML");
  await waitCalls(backend, "app_timeline", 2);

  // Ask for documents: WhatsApp preview + wa.me link with a Namibian number, then app_request_info.
  await page.click('.filebar [data-act="ask"]');
  await page.fill("#askNote", "Please send a clearer photo of your August payslip to this number");
  const wa = await page.locator("#askBox [data-wa]").getAttribute("href");
  assert.equal(wa, "https://wa.me/264812345678?text=" + encodeURIComponent("Hello Selma, this is QuickServe Cashloan about your application QSA-7K2M9P. Please send a clearer photo of your August payslip to this number. We will never ask for your PIN or bank card. Thank you."));
  assert.equal(await page.locator("#askBox [data-wa]").getAttribute("target"), "_blank");
  assert.match(await page.locator("#askBox .watext").innerText(), /^Hello Selma, this is QuickServe Cashloan about your application QSA-7K2M9P\. Please send a clearer photo/);
  await page.click("#askRecord");
  await page.waitForSelector('.filebar [data-status="info_requested"]');
  assert.deepEqual(last(backend, "app_request_info"), { p_app_id: APP.selma, p_note: "Please send a clearer photo of your August payslip to this number" });
  assert.deepEqual(await page.locator(".filebar [data-act]").evaluateAll((els) => els.map((e) => e.getAttribute("data-act"))), ["resume", "edit", "withdraw"]);
  assert.match(await page.locator("#contactPanel").innerText(), /Please send a clearer photo of your August payslip/);
  // Back in review (optional note).
  await page.click('.filebar [data-act="resume"]');
  await page.click("#modalSave");
  await page.waitForSelector('.filebar [data-status="in_review"]');
  assert.deepEqual(last(backend, "app_resume"), { p_app_id: APP.selma, p_note: null });
  assert.deepEqual(ledgerHits(page), [], "no /rest/v1/ledger request in an analyst session");
  await closeConsole(page);
});

// ── worksheet ──────────────────────────────────────────────────────────────
test("worksheet: live D4/D6/F3 match QSCredit, autosave sends the §4 worksheet, submit sends the right params", async () => {
  const ex = CASES.find((c) => c.name === "clean_pass");
  const { page, backend } = await openConsole({ hash: "#worksheet/" + APP.selma, mutate: (db) => {
    Object.assign(db.apps.get(APP.selma), { status: "in_review", assigned_to: PEOPLE.analyst.staff.user_id, assigned_name: "Tuyeni Shikongo", assigned_at: NOW.toISOString() });
  } });
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('[data-page="worksheet"] #wsResult [data-out="d4"]');
  assert.equal(await page.locator("#pageTitle").innerText(), "Affordability assessment — Selma Nangolo");
  assert.match(await page.locator("#pageSub").innerText(), /QSA-7K2M9P · not saved yet · saves as you type/);
  assert.equal(await page.locator("input[data-b8]").inputValue(), "0", "B8 comes from borrower_history.qs_balance");
  assert.ok(await page.locator("input[data-b8]").evaluate((e) => e.readOnly), "B8 is read only");
  assert.equal(await page.locator("#wsSubmit").isDisabled(), true);
  assert.match(await page.locator("#wsSubmitHint").innerText(), /Fill in every line first/);

  await fillWorksheet(page, ex.worksheet, ex.terms);
  const expect = clone(ex.worksheet); expect.income.a11 = null;       // A11 is only asked for irregular income
  let want = Q.compute(expect, ex.terms, ex.application, ex.policy);
  assert.equal(await outVal(page, "d4"), String(want.d4)); assert.equal(await outVal(page, "d6"), String(want.d6)); assert.equal(await outVal(page, "f3"), String(want.f3));
  assert.equal(await outText(page, "d4"), "N$7,620"); assert.equal(await outText(page, "d6"), "N$5,334"); assert.equal(await outText(page, "f3"), "PASS");
  assert.equal(await outText(page, "f5"), "N$4,100");
  assert.equal(await page.locator('[data-calc="e7"]').first().innerText(), "N$5,200");
  assert.match(await page.locator("#wsRules").innerText(), /failing: 0 hard · 0 owner · 0 soft[\s\S]*All rules pass/);
  assert.equal(await page.locator('#wsRules [data-rule="G4"]').getAttribute("data-result"), "na");
  assert.equal(await page.locator('#wsRules [data-rule="G7"]').getAttribute("data-result"), "yes");
  assert.match(await page.locator("#wsRules .rlegend").innerText(), /Hard — no one can override · Owner — only the owner, after your written motivation · Soft — owner writes an override note/);

  // Change A5: the live figures follow QSCredit exactly, and F3 flips.
  await page.fill('input[data-ws="income.a5"]', "15000");
  expect.income.a5 = 15000;
  want = Q.compute(expect, ex.terms, ex.application, ex.policy);
  assert.equal(await outVal(page, "d4"), String(want.d4)); assert.equal(await outVal(page, "d6"), String(want.d6)); assert.equal(await outVal(page, "f3"), "false");
  assert.equal(await outText(page, "d4"), amtText(want.d4));
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 1, "motivate appears once an owner-class rule fails");
  assert.ok(await page.locator('#wsRecOpts input[value="approve"]').isDisabled());
  await page.fill('input[data-ws="income.a5"]', "18000");
  expect.income.a5 = 18000;
  want = Q.compute(expect, ex.terms, ex.application, ex.policy);
  assert.equal(await outVal(page, "d4"), "7520"); assert.equal(await outVal(page, "d6"), String(want.d6)); assert.equal(await outVal(page, "f3"), "true");
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 0);

  // Autosave (debounced): the saved worksheet is exactly the contract §4 object.
  await page.waitForSelector("#wsSaveState:has-text('Saved 10:00')");
  const saved = last(backend, "assessment_save");
  assert.equal(saved.p_app_id, APP.selma);
  assert.deepStrictEqual(saved.p_worksheet, expect);
  assert.deepStrictEqual(saved.p_terms, ex.terms);
  assert.ok(backend.calls("assessment_save").length < 40, "saves are debounced, not one per keystroke");
  assert.match(await page.locator("#pageSub").innerText(), /version 1/);

  // Recommend and submit.
  await page.click('#wsRecOpts input[value="approve"]');
  await page.fill("#wsReasons", REASONS);
  assert.equal(await page.locator("#wsSubmit").isDisabled(), true, "locked until the declaration is ticked");
  assert.match(await page.locator("#wsSubmitHint").innerText(), /Tick every line of the declaration/);
  await declare(page);
  assert.equal(await page.locator("#wsSubmit").isDisabled(), false);
  const saves = backend.calls("assessment_save").length;
  await page.click("#wsSubmit");
  await page.waitForSelector(".banner:has-text('Sent to the owner for approval')");
  assert.deepStrictEqual(last(backend, "assessment_submit"), { p_app_id: APP.selma, p_recommendation: "approve", p_reasons: REASONS, p_motivation: null,
    p_declaration: { d12_1: true, d12_2: true, d12_3: true, d12_4: true, d12_5: true, d12_6: true, d12_7: true } });
  assert.equal(backend.calls("assessment_save").length, saves, "nothing unsaved at submit");
  assert.ok(await page.locator('input[data-ws="income.a1"]').isDisabled(), "read only once submitted");
  assert.equal(await page.locator('.banner [data-act="recall"]').count(), 1, "the submitter may recall");
  assert.deepEqual(ledgerHits(page), [], "no /rest/v1/ledger request in an analyst session");
  await closeConsole(page);
});

test("worksheet: 'Motivate for approval above the limit' only when owner rules fail and no hard rule does; motivation ≥ 60 characters", async () => {
  const { page, backend } = await openConsole({ hash: "#worksheet/" + APP.hilma });
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('#wsRecOpts [data-rec="approve"]');
  assert.equal(await page.locator('input[data-term="principal"]').inputValue(), "3500", "saved terms load");
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 0);
  assert.ok(!(await page.locator('#wsRecOpts input[value="approve"]').isDisabled()));
  // N$6,000 repays N$7,800 > D6 N$5,334: F3 and G8 fail (owner class).
  await page.fill('input[data-term="principal"]', "6000");
  assert.equal(await outVal(page, "f3"), "false");
  assert.match(await page.locator("#wsRules .ph").innerText(), /0 hard · 2 owner · 0 soft/);
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 1);
  assert.match(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').innerText(), /N\$6,000 is N\$2,466 over the limit/);
  // A hard fail on top hides it again (nothing can be motivated past a hard rule).
  await page.click('input[data-cb="conduct.g10"]');
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 0);
  await page.click('input[data-cb="conduct.g10"]');
  await page.click('#wsRecOpts input[value="approve_above_limit"]');
  assert.ok(await page.locator("#wsMot").isVisible());
  await page.fill("#wsReasons", REASONS);
  await declare(page);
  await page.fill("#wsMot", "Debt ends this month.");
  assert.equal(await page.locator("#wsSubmit").isDisabled(), true);
  assert.match(await page.locator("#wsSubmitHint").innerText(), /motivation for going above the limit \(at least 60 characters\)/);
  const MOT = "Her other lender is repaid with the October salary (final instalment on the statement), after which the repayment fits comfortably.";
  await page.fill("#wsMot", MOT);
  // Back under the limit: the option goes and the choice is cleared, never switched silently.
  await page.fill('input[data-term="principal"]', "3500");
  assert.equal(await page.locator('#wsRecOpts [data-rec="approve_above_limit"]').count(), 0);
  assert.equal(await page.locator('#wsRecOpts input:checked').count(), 0);
  assert.match(await page.locator("#wsSubmitHint").innerText(), /Choose your recommendation/);
  await page.fill('input[data-term="principal"]', "6000");
  await page.click('#wsRecOpts input[value="approve_above_limit"]');
  await page.click("#wsSubmit");
  await page.waitForSelector(".banner:has-text('Sent to the owner for approval')");
  const sub = last(backend, "assessment_submit");
  assert.equal(sub.p_recommendation, "approve_above_limit");
  assert.equal(sub.p_motivation, MOT);
  assert.equal(last(backend, "assessment_save").p_terms.principal, 6000, "the terms were saved before submitting");
  assert.deepEqual(ledgerHits(page), []);
  await closeConsole(page);
});

// ── owner approval ─────────────────────────────────────────────────────────
test("owner approval: above-limit needs the motivation and an override note; sends p_override_note and p_assessment_version", async () => {
  const { page, backend } = await openConsole({ hash: "#credit/awaiting_approval" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector('[data-page="credit"] tr[data-app="' + APP.gerson + '"]');
  assert.match(await page.locator("#cqStats").innerText(), /Awaiting your approval\s*2[\s\S]*Ready to disburse\s*1/i);
  await page.click('tr[data-app="' + APP.gerson + '"] a.btn:has-text("Decide")');
  await page.waitForFunction((x) => location.hash === "#approval/" + x, APP.gerson);
  await page.waitForSelector("#decPanel #apConfirm");
  assert.match(await page.locator("#apEyes").innerText(), /Two sets of eyes\. Assessed by Tuyeni Shikongo[\s\S]*worksheet version 2/);
  assert.match(await page.locator("#apRec").innerText(), /Motivates: N\$5,250 — above the limit[\s\S]*N\$6,825[\s\S]*Motivation to go N\$805 above the limit[\s\S]*Namdeb for 11 years/i);
  assert.match(await page.locator("#apAfford").innerText(), /Disposable income \(D4\)\s*N\$8,600[\s\S]*N\$6,020[\s\S]*FAIL[\s\S]*N\$4,600/);
  assert.match(await page.locator("#apRules .ph").innerText(), /0 hard · 2 owner · 1 soft failing/);
  assert.ok(await page.locator('input[name="apChoice"][value="approve"]').isChecked(), "approve as motivated is the default");
  assert.match(await page.locator("#apOpts").innerText(), /Approve N\$5,250 above the limit \(override\)/);
  assert.ok(await page.locator("#apOverrideBox").isVisible());
  assert.match(await page.locator("#apOverrideLabel").innerText(), /going above the limit, 8\.x/i);
  assert.equal(await page.locator("#apConfirm").isDisabled(), true);
  await page.fill("#apOverride", "Too short");
  assert.equal(await page.locator("#apConfirm").isDisabled(), true);
  // A different amount is recomputed live; N$4,600 passes F3 but FLAGS still needs the note.
  await page.click('input[name="apChoice"][value="amount"]');
  await page.fill("#apAmount", "4600");
  assert.match(await page.locator("#apAmountNote").innerText(), /Repays N\$5,980 · within the limit/);
  assert.equal(await page.locator("#apConfirm").innerText(), "Approve N$4,600");
  assert.equal(await page.locator("#apConfirm").isDisabled(), true, "soft fail still needs the override note");
  await page.click('input[name="apChoice"][value="approve"]');
  const NOTE = "Final instalment to the other lender is visible on the August statement.";
  await page.fill("#apOverride", NOTE);
  assert.equal(await page.locator("#apConfirm").isDisabled(), false);
  assert.equal(await page.locator("#apConfirm").innerText(), "Override and approve N$5,250");
  await page.click("#apConfirm");
  await page.waitForSelector('#decPanel [data-outcome="approved"]');
  assert.deepStrictEqual(last(backend, "app_decide"), { p_app_id: APP.gerson, p_assessment_version: 2, p_outcome: "approved", p_terms: null, p_reasons: null, p_reason_to_applicant: null, p_override_note: NOTE });
  assert.match(await page.locator("#decPanel").innerText(), /Approved · N\$5,250[\s\S]*Override note[\s\S]*Final instalment/i);
  const wa = await page.locator("#decPanel [data-wa]").getAttribute("href");
  assert.equal(wa, "https://wa.me/264815678901?text=" + encodeURIComponent("Hello Gerson, good news from QuickServe Cashloan: your application QSA-D5KT9R is approved for N$5,250. Please come to our office with your ID to sign the agreement and collect. We will never ask for your PIN."));
  await page.waitForFunction(() => document.getElementById("badge_approvals").textContent === "1");
  assert.equal(await page.locator("#badge_disburse").innerText(), "2");
  await page.click('#decPanel [data-act="notify"]');
  await page.waitForSelector("#toldLine");
  assert.deepEqual(last(backend, "app_mark_notified"), { p_app_id: APP.gerson, p_via: "whatsapp" });
  await closeConsole(page);
});

test("owner approval: a hard fail blocks approval; decline needs a reason for the applicant and reasons; QS_STALE is shown", async () => {
  const { page, backend } = await openConsole({ hash: "#approval/" + APP.ndapewa });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector("#decPanel #apConfirm");
  assert.match(await page.locator("#apBlocked").innerText(), /Approval is blocked\. A hard rule fails \(D4\)/);
  assert.ok(await page.locator('input[name="apChoice"][value="approve"]').isDisabled(), "approve disabled on a hard fail");
  assert.ok(await page.locator('input[name="apChoice"][value="amount"]').isDisabled(), "no amount can cure D4");
  assert.ok(await page.locator('input[name="apChoice"][value="decline"]').isChecked(), "decline is preselected");
  assert.match(await page.locator("#apAfford").innerText(), /Disposable income \(D4\)\s*−N\$340/);
  assert.equal(await page.locator("#apConfirm").isDisabled(), true);
  await page.selectOption("#apReason", "afford");
  await page.fill("#apDeclineNote", "Too short");
  assert.equal(await page.locator("#apConfirm").isDisabled(), true);
  await page.fill("#apDeclineNote", "Disposable income is below zero after rent and living costs.");
  assert.equal(await page.locator("#apConfirm").innerText(), "Decline application");
  // Someone changed the worksheet meanwhile: the optimistic lock refuses, with a reload.
  const asm = backend.db.assessments[APP.ndapewa]; asm.version = 2;
  await page.click("#apConfirm");
  await page.waitForSelector("#apErr:has-text('The worksheet changed since you opened it')");
  assert.equal(await page.locator('#apErr [data-act="reload"]').count(), 1);
  assert.equal(last(backend, "app_decide").p_assessment_version, 1);
  asm.version = 1;
  await page.click("#apConfirm");
  await page.waitForSelector('#decPanel [data-outcome="declined"]');
  assert.deepStrictEqual(last(backend, "app_decide"), { p_app_id: APP.ndapewa, p_assessment_version: 1, p_outcome: "declined", p_terms: null,
    p_reasons: "Disposable income is below zero after rent and living costs.", p_reason_to_applicant: "afford", p_override_note: null });
  assert.match(await page.locator("#decPanel .watext").innerText(), /We are unable to approve your application at this time because the repayment would not be affordable on your current income\./);
  assert.match(await page.locator("#decPanel [data-wa]").getAttribute("href"), /^https:\/\/wa\.me\/264816789012\?text=/);
  await closeConsole(page);
});

// ── ready to disburse ──────────────────────────────────────────────────────
test("disburse: locked until all 10 checks + method/reference; sends app_disburse exactly; then reloads the owner's ledger", async () => {
  const { page, backend } = await openConsole({ hash: "#credit/approved" });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector('tr[data-app="' + APP.loide + '"] [data-payout]');
  await page.click('tr[data-app="' + APP.loide + '"] [data-payout]');
  await page.waitForFunction(() => location.hash === "#disburse");
  await page.waitForSelector("#payBookAs");
  assert.match(await page.locator("#pageSub").innerText(), /1 approved application · N\$2,000 still to pay out/);
  assert.deepEqual(last(backend, "app_disburse_preview"), { p_app_id: APP.loide, p_issue_date: TODAY, p_due_date: "2026-10-25" });
  assert.match(await page.locator("#payBookAs").innerText(), /QSL-0058 for client QS-0024 — N\$2,000 at 30%, fee N\$0, issued 28 Sep 2026, due 25 Oct 2026 · purpose “Rent deposit” · from application QSA-X7QJ4M/);
  assert.ok(await page.locator('input[name="payClient"][value="client_loide"]').isChecked(), "the ID match is the default");
  assert.match(await page.locator("#payTerm").innerText(), /Term 27 days · within 5 months ✓/);
  assert.equal(await page.locator("#payRepay").innerText(), "N$2,600");
  const book = page.locator("#payBook");
  assert.equal(await book.innerText(), "Book QSL-0058 & record payout");
  assert.equal(await book.isDisabled(), true);
  const boxes = page.locator("#payPanel input[data-check]");
  assert.equal(await boxes.count(), 10);
  for (let i = 0; i < 9; i++) await boxes.nth(i).check();
  assert.equal(await book.isDisabled(), true, "9 of 10 is not enough");
  assert.equal(await page.locator("#payCount").innerText(), "9 of 10");
  await boxes.nth(9).check();
  assert.equal(await book.isDisabled(), true, "no payout method yet");
  await page.selectOption("#payMethod", "Bank transfer");
  assert.equal(await book.isDisabled(), true, "a bank transfer needs a reference");
  assert.match(await page.locator("#payRefLabel").innerText(), /\(required\)/i);
  await page.fill("#payRef", "FN");
  assert.equal(await book.isDisabled(), true);
  await page.fill("#payRef", "FNB 28-09 #4471");
  assert.equal(await book.isDisabled(), false);
  // Cash needs no reference; switching back keeps it valid either way.
  await page.selectOption("#payMethod", "Cash");
  assert.match(await page.locator("#payRefLabel").innerText(), /optional for cash/i);
  await page.selectOption("#payMethod", "Bank transfer");
  const ledgerBefore = backend.log.ledger.filter((l) => l.method === "GET").length;
  const loansBefore = await page.evaluate(() => window.__admin.loanCount());
  await book.click();
  await page.waitForSelector('#payPanel [data-booked="QSL-0058"]');
  assert.deepStrictEqual(last(backend, "app_disburse"), {
    p_app_id: APP.loide, p_checklist: { "13.1": true, "13.2": true, "13.3": true, "13.4": true, "13.5": true, "13.6": true, "13.7": true, "13.8": true, "13.9": true, "13.10": true },
    p_issue_date: TODAY, p_due_date: "2026-10-25", p_method: "Bank transfer", p_reference: "FNB 28-09 #4471", p_client_id: "client_loide", p_new_client: false });
  await page.waitForSelector("#payPanel .booked:has-text('loan book reloaded')");
  assert.ok(backend.log.ledger.filter((l) => l.method === "GET").length > ledgerBefore, "the ledger was read again after booking");
  const afterDisburse = backend.log.rpc.findIndex((c) => c.name === "app_disburse");
  assert.ok(backend.log.ledger.some((l) => l.method === "GET" && l.at > afterDisburse), "…after app_disburse");
  assert.equal(await page.evaluate(() => window.__admin.loanCount()), loansBefore + 1, "the owner's state has the new loan");
  assert.match(await page.locator("#payPanel .booked").innerText(), /Booked as QSL-0058[\s\S]*QS-0024 · Loide Nakale[\s\S]*N\$2,000 · repay N\$2,600 by 25 Oct 2026[\s\S]*Bank transfer FNB 28-09 #4471 · 28 Sep 2026[\s\S]*version 41 → 42/);
  assert.match(await page.locator('#payList [data-booked-row]').innerText(), /BOOKED QSL-0058/i);
  await page.waitForFunction(() => document.getElementById("badge_disburse").classList.contains("hidden"));
  // Loans (from the reloaded ledger) now lists it.
  await page.click('#payPanel [data-act="openloan"]');
  await page.waitForSelector("#drawer.open");
  assert.match(await page.locator("#drawerBody").innerText(), /Loide Nakale/);
  await page.keyboard.press("Escape");
  await goHash(page, "#loans");
  assert.match(await page.locator("#content").innerText(), /Loide Nakale[\s\S]*2,000/);
  await closeConsole(page);
});

test("owner: correct details sends only changed keys; return to the analyst; an ambiguous client match needs a choice", async () => {
  const { page, backend } = await openConsole({ hash: "#app/" + APP.gerson, mutate: (db) => {
    db.ledger.data.clients.push({ id: "client_loide2", ref: "QS-0033", createdAt: "2026-09-10T09:00:00.000Z", name: "Loide N. Nakale", phone: "", nationalId: "920327 00812", employer: "", address: "", nextOfKin: "", notes: "" });
  } });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector('.filebar [data-act="edit"]');
  assert.deepEqual(await page.locator(".filebar [data-act]").evaluateAll((els) => els.map((e) => e.getAttribute("data-act"))), ["edit", "withdraw", "decide", "worksheet"]);
  await page.click('.filebar [data-act="edit"]');
  assert.equal(await page.locator("#f_ap_national_id").count(), 1, "an owner may correct the ID number");
  await page.click("#modalSave");
  assert.match(await page.locator("#f_err").innerText(), /Nothing changed/);
  await page.fill("#f_ap_employer", "Namdeb Diamond Corporation");
  await page.fill("#f_ap_amount_requested", "7500");
  await page.click("#modalSave");
  await page.waitForSelector("#detailsPanel >> text=Namdeb Diamond Corporation");
  assert.deepEqual(last(backend, "app_update_applicant"), { p_app_id: APP.gerson, p_patch: { employer: "Namdeb Diamond Corporation", amount_requested: 7500 } });

  // Return to the analyst: a note of at least 10 characters, nothing decided.
  await goHash(page, "#approval/" + APP.gerson);
  await page.waitForSelector("#apConfirm");
  await page.click('input[name="apChoice"][value="return"]');
  assert.equal(await page.locator("#apConfirm").innerText(), "Return to Tuyeni");
  await page.fill("#apReturn", "Rent looks higher on the statement — please check.");
  await page.click("#apConfirm");
  await page.waitForSelector("#decPanel .alert:has-text('This file is in review')");
  assert.deepStrictEqual(last(backend, "app_decide"), { p_app_id: APP.gerson, p_assessment_version: 2, p_outcome: "returned", p_terms: null,
    p_reasons: "Rent looks higher on the statement — please check.", p_reason_to_applicant: null, p_override_note: null });
  assert.ok(await page.locator('input[name="apChoice"][value="approve"]').isDisabled(), "only decline is left until it is resubmitted");
  assert.ok(!(await page.locator('input[name="apChoice"][value="decline"]').isDisabled()));

  // Two ledger clients share Loide's ID: nothing is preselected and booking waits for a choice.
  await goHash(page, "#disburse");
  await page.waitForSelector("#payBookAs");
  assert.match(await page.locator("#payClient").innerText(), /More than one client in the ledger has this ID number/);
  assert.equal(await page.locator('#payClient input[name="payClient"]:checked').count(), 0);
  for (const box of await page.locator("#payPanel input[data-check]").all()) await box.check();
  await page.selectOption("#payMethod", "Cash");
  assert.equal(await page.locator("#payBook").isDisabled(), true);
  assert.match(await page.locator("#payHint").innerText(), /Choose which client this loan belongs to/);
  await page.click('#payClient input[value="new"]');
  assert.match(await page.locator("#payBookAs").innerText(), /QSL-0058 for client QS-0034/);
  await page.click('#payClient input[value="client_loide2"]');
  assert.match(await page.locator("#payBookAs").innerText(), /QSL-0058 for client QS-0033/);
  assert.equal(await page.locator("#payBook").isDisabled(), false, "cash needs no reference");
  await page.click("#payBook");
  await page.waitForSelector('#payPanel [data-booked="QSL-0058"]');
  const p = last(backend, "app_disburse");
  assert.deepEqual([p.p_method, p.p_reference, p.p_client_id, p.p_new_client], ["Cash", null, "client_loide2", false]);
  await closeConsole(page);
});

// ── hardening ──────────────────────────────────────────────────────────────
test("every applicant-provided string is escaped on the queue, file, worksheet and approval pages", async () => {
  const EVIL = '<img src=x onerror="window.__xss=1">';
  const { page } = await openConsole({ hash: "#credit", mutate: (db) => {
    const a = db.apps.get(APP.gerson);
    Object.assign(a, { full_name: EVIL + "Gerson", employer: "<script>window.__xss=2</script>", purpose: '"><svg onload="window.__xss=3">', national_id: "<b>87081500589</b>", address: EVIL, kin_name: EVIL });
    db.assessments[APP.gerson].reasons = EVIL + " reasons"; db.assessments[APP.gerson].motivation = EVIL + " motivation " + "x".repeat(60);
    db.notes[APP.gerson].unshift({ id: "dd000000-0000-4000-8000-000000000999", kind: "note", body: EVIL, author_name: EVIL, created_at: NOW.toISOString() });
    db.timeline[APP.gerson].unshift({ at: NOW.toISOString(), actor_name: EVIL, action: "note.added", text: EVIL });
  } });
  await signedIn(page, PEOPLE.owner);
  await page.waitForSelector('tr[data-app="' + APP.gerson + '"]');
  assert.match(await page.locator('tr[data-app="' + APP.gerson + '"]').innerText(), /<img src=x onerror="window.__xss=1">Gerson/);
  for (const h of ["#app/" + APP.gerson, "#worksheet/" + APP.gerson, "#approval/" + APP.gerson]) {
    await goHash(page, h);
    await page.waitForSelector('[data-page] .filebar');
    await page.waitForTimeout(100);
  }
  await goHash(page, "#app/" + APP.gerson);
  await page.waitForSelector("#notesPanel .note");
  assert.match(await page.locator("#notesPanel").innerText(), /<img src=x onerror="window.__xss=1">/);
  assert.equal(await page.locator("#content img").count(), 0, "no injected elements");
  assert.equal(await page.locator("#content script, #content svg[onload]").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await closeConsole(page);
});

test("withdraw and reopen go through a reason; the owner-only actions never appear for the analyst", async () => {
  const { page, backend } = await openConsole({ hash: "#app/" + APP.johannes });
  await signedIn(page, PEOPLE.analyst);
  await page.waitForSelector('[data-page="app"] .filebar [data-act="withdraw"]');
  assert.deepEqual(await page.locator(".filebar [data-act]").evaluateAll((els) => els.map((e) => e.getAttribute("data-act"))), ["claim", "edit", "withdraw"]);
  await page.click('.filebar [data-act="withdraw"]');
  await page.fill("#f_reason", "spam");
  await page.click("#modalSave");
  assert.match(await page.locator("#f_err").innerText(), /at least 10 characters/);
  assert.equal(backend.calls("app_withdraw").length, 0);
  await page.fill("#f_reason", "Duplicate of QSA-P2LK7D sent twice.");
  await page.click("#modalSave");
  await page.waitForSelector('.filebar [data-status="withdrawn"]');
  assert.deepEqual(last(backend, "app_withdraw"), { p_app_id: APP.johannes, p_reason: "Duplicate of QSA-P2LK7D sent twice." });
  assert.equal(await page.locator('.filebar [data-act="reopen"]').count(), 0, "an analyst can't reopen");
  // The analyst's file for an awaiting-approval application has no decide/pay-out buttons.
  await goHash(page, "#app/" + APP.gerson);
  await page.waitForSelector('[data-page="app"] #kycPanel');
  assert.equal(await page.locator('.filebar [data-act="decide"], .filebar [data-act="payout"]').count(), 0);
  assert.deepEqual(ledgerHits(page), []);
  await closeConsole(page);

  const owner = await openConsole({ hash: "#app/" + APP.anna });
  await signedIn(owner.page, PEOPLE.owner);
  await owner.page.waitForSelector('.filebar [data-act="reopen"]');
  assert.match(await owner.page.locator("#contactPanel .watext").innerText(), /because we could not verify your documents/);
  await owner.page.click('.filebar [data-act="reopen"]');
  await owner.page.fill("#f_reason", "Applicant brought the missing statements.");
  await owner.page.click("#modalSave");
  await owner.page.waitForSelector('.filebar [data-status="in_review"]');
  assert.deepEqual(last(owner.backend, "app_reopen"), { p_app_id: APP.anna, p_reason: "Applicant brought the missing statements." });
  await closeConsole(owner.page);
});

// ── runner ─────────────────────────────────────────────────────────────────
(async () => {
  server = await startServer();
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch();
  let failed = 0;
  const only = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
  const list = only ? tests.filter((t) => only.test(t.name)) : tests;
  for (const t of list) {
    const t0 = Date.now();
    try { await t.fn(); console.log("ok   - " + t.name + " (" + (Date.now() - t0) + " ms)"); }
    catch (e) { failed++; console.log("FAIL - " + t.name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n       ")); }
  }
  await browser.close();
  server.close();
  console.log("\n" + (list.length - failed) + "/" + list.length + " admin-credit tests passed");
  process.exit(failed ? 1 : 0);
})();
