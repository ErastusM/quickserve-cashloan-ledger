// End-to-end tests for the application service, run with plain Node
// (node --test intake-worker/tests/). D1 is stood in for by node:sqlite with
// the same schema, R2 by a Map, and Supabase/Turnstile by a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { cleanUp } from "../src/index.js";
import { normalisePhone, sniffMime, validateApplication, loanCost, yymm, formatReference } from "../src/lib.js";

// ---- fakes ---------------------------------------------------------------------
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(["0001_init.sql", "0002_refs_ids_amounts.sql", "0003_recommendations.sql", "0004_push.sql"].map((f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8")).join("\n"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _run: () => db.prepare(sql).run(...args)
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => s._run()), raw: db };
}
function fakeR2() {
  const store = new Map();
  return {
    store,
    put: async (k, v, o) => { store.set(k, { body: v, o }); },
    get: async (k) => (store.has(k) ? { body: store.get(k).body } : null),
    delete: async (k) => { store.delete(k); }
  };
}
const ORIGIN = "https://quickserve.group";
function makeEnv() {
  return {
    DB: fakeD1(), DOCS: fakeR2(),
    ALLOWED_ORIGINS: "https://quickserve.group,https://admin.quickserve.group",
    SUPABASE_URL: "https://sb.example", SUPABASE_KEY: "pub",
    OWNER_TOKEN: "owner-secret-owner-secret-12345",
    MIN_AMOUNT: "500", STANDARD_MAX_AMOUNT: "10000", MAX_AMOUNT: "100000", INTEREST_RATE_BP: "3000"
  };
}
// Stand-in Supabase: three logins (owner, analyst with a N$10 000 limit, and
// someone not on the staff list) plus the returning-client lookup.
const PUSHES = [];
const PEOPLE = {
  "Bearer staff-session": { id: "u-owner", email: "staff@quickserve.group", staff: { role: "owner", approval_limit: null } },
  "Bearer analyst-session": { id: "u-analyst", email: "analyst@quickserve.group", staff: { role: "analyst", approval_limit: "10000.00" } },
  "Bearer stranger-session": { id: "u-x", email: "x@example.com", staff: null }
};
globalThis.fetch = async (url, init) => {
  const who = PEOPLE[(init.headers.Authorization || "")];
  const u = String(url);
  if (u.endsWith("/auth/v1/user")) return new Response(JSON.stringify(who ? { id: who.id, email: who.email } : {}), { status: who ? 200 : 401 });
  if (u.includes("/rest/v1/staff?")) return new Response(JSON.stringify(who && who.staff ? [who.staff] : []), { status: 200 });
  if (u.startsWith("https://fcm.googleapis.com/")) { PUSHES.push({ url: u, headers: init.headers, body: init.body }); return new Response("", { status: u.includes("gone") ? 410 : 201 }); }
  if (u.endsWith("/rest/v1/rpc/match_client")) return new Response(JSON.stringify([{ ref: "QS-0001", name: "Ndapewa S", loans: 2 }]), { status: 200 });
  throw new Error("unexpected fetch " + url);
};

let ip = 0;
function call(env, method, path, { body, headers = {}, raw } = {}) {
  const h = { Origin: ORIGIN, "CF-Connecting-IP": "10.0.0." + (++ip % 250), ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request("https://api.quickserve.group" + path, {
    method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  return worker.fetch(req, env);
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7 test");
const details = {
  fullName: "Ndapewa Shikongo", nationalId: "91041500123", phone: "081 234 5678", employer: "Ministry of Education",
  netIncome: "9800", payday: "25th", kinName: "Tangeni Shikongo", kinPhone: "081 765 4321", purpose: "School fees", amount: "2000"
};

async function draftWithDocs(env) {
  const r = await call(env, "POST", "/v2/applications", { body: details });
  assert.equal(r.status, 201);
  const d = await r.json();
  const up = { "X-Upload-Token": d.uploadToken };
  for (const [kind, bytes] of [["id", JPEG], ["payslip", PDF], ["bank", PDF]]) {
    const f = await call(env, "PUT", `/v2/applications/${d.reference}/files/${kind}`, { raw: bytes, headers: up });
    assert.equal(f.status, 201, kind);
  }
  return d;
}
const consent = { consent: { creditCheck: true, privacy: true, truthful: true }, signedName: "ndapewa  shikongo" };
const staff = { Authorization: "Bearer staff-session" };

// ---- unit ------------------------------------------------------------------------
test("references carry the year and month", () => {
  assert.equal(yymm(new Date("2026-11-30T23:30:00Z")), "2612"); // already 1 December in Namibia
  assert.equal(formatReference("2611", 7), "QSA-2611-0007");
});
test("phone numbers normalise to 264…", () => {
  assert.equal(normalisePhone("081 234 5678"), "264812345678");
  assert.equal(normalisePhone("+264 81 234 5678"), "264812345678");
  assert.equal(normalisePhone("12345"), null);
});
test("file types are sniffed from content, not the name", () => {
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(PDF), "application/pdf");
  assert.equal(sniffMime(new TextEncoder().encode("<html>")), null);
});
test("30% interest, payday only, amount limits", () => {
  assert.deepEqual(loanCost(200000, 3000), { interest_cents: 60000, total_cents: 260000 });
  const env = makeEnv();
  assert.deepEqual(validateApplication(details, env).errors, {});
  assert.equal(validateApplication({ ...details, amount: "9000" }, env).row.above_standard, 0);
  assert.equal(validateApplication({ ...details, amount: "25000" }, env).row.above_standard, 1);
  assert.ok(validateApplication({ ...details, amount: "250000" }, env).errors.amount);
  const pp = validateApplication({ ...details, idType: "passport", nationalId: "p a12-34567", nationality: "Zambian" }, env);
  assert.deepEqual(pp.errors, {});
  assert.equal(pp.row.national_id, "PA1234567");
  assert.ok(validateApplication({ ...details, idType: "passport", nationalId: "PA1234567" }, env).errors.nationality);
  assert.ok(validateApplication({ ...details, term: "3" }, env).errors.term);
  assert.ok(validateApplication({ ...details, nationalId: "123" }, env).errors.nationalId);
});

// ---- flows -------------------------------------------------------------------------
test("apply → submit → staff review → info request → applicant uploads → approve → convert", async () => {
  const env = makeEnv();
  const d = await draftWithDocs(env);
  assert.match(d.reference, /^QSA-\d{4}-0001$/);
  assert.equal(d.totalCents, 260000);

  const s = await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: consent, headers: { "X-Upload-Token": d.uploadToken } });
  assert.equal(s.status, 200);
  const { trackToken } = await s.json();

  // upload token no longer works once handed in
  const late = await call(env, "PUT", `/v2/applications/${d.reference}/files/other`, { raw: PDF, headers: { "X-Upload-Token": d.uploadToken } });
  assert.equal(late.status, 403);

  // tracking by reference + phone
  let t = await (await call(env, "POST", "/v2/track", { body: { reference: d.reference.toLowerCase(), phone: "+264812345678" } })).json();
  assert.equal(t.stage, "received");
  assert.deepEqual(t.stamps.map((s) => s.stamp), ["received"]);
  assert.equal(t.canUpload, false);

  // staff list and open
  const list = await (await call(env, "GET", "/v2/admin/applications", { headers: staff })).json();
  assert.equal(list.applications.length, 1);
  assert.equal(list.counts.new, 1);
  const detail = await (await call(env, "GET", `/v2/admin/applications/${d.reference}`, { headers: staff })).json();
  assert.equal(detail.application.status, "in_review");
  const seen = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.equal(seen.stage, "in_review", "opening it in the portal shows In review to the applicant");
  assert.deepEqual(seen.stamps.map((s) => s.stamp), ["received", "in_review"]);
  assert.equal(detail.files.length, 3);
  assert.equal(detail.application.track_token_hash, undefined);

  const file = await call(env, "GET", `/v2/admin/applications/${d.reference}/files/${detail.files[0].id}`, { headers: staff });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("Cache-Control"), "private, no-store");

  // request info → applicant sees the message and can upload with the track token
  let r = await call(env, "POST", `/v2/admin/applications/${d.reference}/status`, { headers: staff, body: { status: "info_requested", applicantMessage: "Please add your October statement." } });
  assert.equal(r.status, 200);
  t = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.equal(t.stage, "waiting_on_you");
  assert.equal(t.message, "Please add your October statement.");
  assert.equal(t.canUpload, true);
  r = await call(env, "PUT", `/v2/track/${d.reference}/files/bank`, { raw: PDF, headers: { "X-Track-Token": trackToken } });
  assert.equal(r.status, 201);
  t = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.equal(t.stage, "in_review");

  // approve, then convert into the ledger
  assert.equal((await call(env, "POST", `/v2/admin/applications/${d.reference}/converted`, { headers: staff, body: { clientId: "c1", loanId: "l1" } })).status, 409);
  await call(env, "POST", `/v2/admin/applications/${d.reference}/status`, { headers: staff, body: { status: "approved" } });
  t = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.equal(t.stage, "approved");
  r = await call(env, "POST", `/v2/admin/applications/${d.reference}/converted`, { headers: staff, body: { clientId: "c1", loanId: "l1", clientRef: "QS-0054", loanRef: "QSL-0137" } });
  assert.equal(r.status, 200);
  const after = await (await call(env, "GET", "/v2/admin/applications", { headers: staff })).json();
  assert.equal(after.applications[0].ledger_loan_ref, "QSL-0137");
  // the next application gets the next number
  const d2 = await (await call(env, "POST", "/v2/applications", { body: details })).json();
  assert.equal(d2.reference, d.reference.replace(/0001$/, "0002"));
  t = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.deepEqual(t.stamps.map((s) => s.stamp), ["received", "in_review", "approved", "paid"]);
});

test("a declined applicant sees the reason on their tracking page", async () => {
  const env = makeEnv();
  const d = await draftWithDocs(env);
  const { trackToken } = await (await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: consent, headers: { "X-Upload-Token": d.uploadToken } })).json();
  assert.equal((await call(env, "POST", `/v2/admin/applications/${d.reference}/status`, { headers: staff, body: { status: "declined", note: "internal only" } })).status, 400, "a reason is required");
  const why = "Thank you for applying to QuickServe. We can’t approve this loan because we couldn’t confirm your employment or income.";
  assert.equal((await call(env, "POST", `/v2/admin/applications/${d.reference}/status`, { headers: staff, body: { status: "declined", note: "Employer didn't answer — internal", applicantMessage: why } })).status, 200);
  const t = await (await call(env, "POST", "/v2/track", { body: { trackToken } })).json();
  assert.equal(t.stage, "declined");
  assert.equal(t.message, why);
  assert.ok(!JSON.stringify(t).includes("internal"), "the internal note never reaches the applicant");
});

test("submit is refused without all documents, consent and a matching signature", async () => {
  const env = makeEnv();
  const r = await call(env, "POST", "/v2/applications", { body: details });
  const d = await r.json();
  const up = { "X-Upload-Token": d.uploadToken };
  let s = await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: consent, headers: up });
  assert.equal(s.status, 400);
  assert.deepEqual((await s.json()).missing, ["id", "payslip", "bank"]);
  s = await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: { ...consent, signedName: "Someone Else" }, headers: up });
  assert.equal(s.status, 400);
});

test("a draft's details can be changed before it is handed in", async () => {
  const env = makeEnv();
  const d = await (await call(env, "POST", "/v2/applications", { body: details })).json();
  const up = { "X-Upload-Token": d.uploadToken };
  const r = await call(env, "PUT", `/v2/applications/${d.reference}`, { body: { ...details, amount: "1000" }, headers: up });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).totalCents, 130000);
  assert.equal((await call(env, "PUT", `/v2/applications/${d.reference}`, { body: { ...details, phone: "1" }, headers: up })).status, 400);
  assert.equal((await call(env, "PUT", `/v2/applications/${d.reference}`, { body: details, headers: { "X-Upload-Token": "x" } })).status, 403);
});

test("bad files, wrong tokens and strangers are refused", async () => {
  const env = makeEnv();
  const d = await (await call(env, "POST", "/v2/applications", { body: details })).json();
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");
  assert.equal((await call(env, "PUT", `/v2/applications/${d.reference}/files/id`, { raw: html, headers: { "X-Upload-Token": d.uploadToken } })).status, 415);
  assert.equal((await call(env, "PUT", `/v2/applications/${d.reference}/files/id`, { raw: JPEG, headers: { "X-Upload-Token": "nope" } })).status, 403);
  assert.equal((await call(env, "GET", "/v2/admin/applications")).status, 401);
  assert.equal((await call(env, "GET", "/v2/admin/applications", { headers: { Authorization: "Bearer bad" } })).status, 401);
  assert.equal((await call(env, "GET", "/v2/admin/me", { headers: { Authorization: "Bearer " + env.OWNER_TOKEN } })).status, 200);
  // drafts are invisible to tracking and staff
  assert.equal((await call(env, "POST", "/v2/track", { body: { reference: d.reference, phone: details.phone } })).status, 404);
});

test("analysts approve up to their limit, recommend above it; only owners mark loans paid out", async () => {
  const env = makeEnv();
  const analyst = { Authorization: "Bearer analyst-session" };
  async function handedIn(amount) {
    const d = await (await call(env, "POST", "/v2/applications", { body: { ...details, amount } })).json();
    const up = { "X-Upload-Token": d.uploadToken };
    for (const [kind, bytes] of [["id", JPEG], ["payslip", PDF], ["bank", PDF]]) await call(env, "PUT", `/v2/applications/${d.reference}/files/${kind}`, { raw: bytes, headers: up });
    assert.equal((await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: consent, headers: up })).status, 200);
    return d.reference;
  }
  const me = await (await call(env, "GET", "/v2/admin/me", { headers: analyst })).json();
  assert.deepEqual(me, { email: "analyst@quickserve.group", role: "analyst", approvalLimit: 10000 });

  const small = await handedIn("10000");
  const detail = await (await call(env, "GET", `/v2/admin/applications/${small}`, { headers: analyst })).json();
  assert.equal(detail.ledgerMatches[0].ref, "QS-0001");
  assert.equal((await call(env, "POST", `/v2/admin/applications/${small}/status`, { headers: analyst, body: { status: "approved" } })).status, 200);
  // the analyst can't do the paid-out step; the owner can
  assert.equal((await call(env, "POST", `/v2/admin/applications/${small}/converted`, { headers: analyst, body: { clientId: "c", loanId: "l" } })).status, 403);
  assert.equal((await call(env, "POST", `/v2/admin/applications/${small}/converted`, { headers: staff, body: { clientId: "c", loanId: "l", loanRef: "QSL-2611-0137" } })).status, 200);

  const big = await handedIn("15000");
  const refused = await call(env, "POST", `/v2/admin/applications/${big}/status`, { headers: analyst, body: { status: "approved" } });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "above_limit");
  assert.equal((await call(env, "POST", `/v2/admin/applications/${big}/recommend`, { headers: analyst, body: { recommendation: "approve", note: "Steady salary, low expenses." } })).status, 200);
  const rec = await (await call(env, "GET", "/v2/admin/applications?status=recommended", { headers: staff })).json();
  assert.deepEqual(rec.applications.map((a) => a.id), [big]);
  assert.equal(rec.counts.recommended, 1);
  assert.equal((await call(env, "POST", `/v2/admin/applications/${big}/status`, { headers: staff, body: { status: "approved" } })).status, 200);

  // someone not on the staff list gets nothing
  assert.equal((await call(env, "GET", "/v2/admin/applications", { headers: { Authorization: "Bearer stranger-session" } })).status, 403);
});

// A browser's side of Web Push: decrypt an aes128gcm message (RFC 8291).
async function browserDecrypt(body, uaKeys, auth) {
  const b = new Uint8Array(body), salt = b.slice(0, 16), idlen = b[20], asPublic = b.slice(21, 21 + idlen), cipher = b.slice(21 + idlen);
  const S = crypto.subtle, te = new TextEncoder();
  const asKey = await S.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await S.deriveBits({ name: "ECDH", public: asKey }, uaKeys.privateKey, 256));
  const uaPublic = new Uint8Array(await S.exportKey("raw", uaKeys.publicKey));
  const hk = async (salt, ikm, info, n) => new Uint8Array(await S.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await S.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hk(auth, shared, new Uint8Array([...te.encode("WebPush: info\0"), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await S.decrypt({ name: "AES-GCM", iv: nonce }, await S.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), cipher));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
}

test("staff devices get an encrypted push for every handed-in application", async () => {
  const env = makeEnv();
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", vapid.privateKey));
  const vapidPub = new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey));
  env.VAPID_PUBLIC_KEY = Buffer.from(vapidPub).toString("base64url");
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64 = (x) => Buffer.from(x).toString("base64url");
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone", keys: { p256dh: b64(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64(auth) } };
  assert.equal((await call(env, "POST", "/v2/admin/push/subscribe", { headers: staff, body: { subscription: sub, device: "Android" } })).status, 200);
  assert.equal((await call(env, "POST", "/v2/admin/push/subscribe", { headers: staff, body: { subscription: { ...sub, endpoint: "https://evil.example/x" } } })).status, 400);
  // a second, dead device is cleaned up when the push service says it's gone
  await call(env, "POST", "/v2/admin/push/subscribe", { headers: { Authorization: "Bearer analyst-session" }, body: { subscription: { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/gone" } } });

  PUSHES.length = 0;
  const d = await draftWithDocs(env);
  assert.equal((await call(env, "POST", `/v2/applications/${d.reference}/submit`, { body: consent, headers: { "X-Upload-Token": d.uploadToken } })).status, 200);
  const toOwner = PUSHES.find((p) => p.url.endsWith("owner-phone"));
  assert.ok(toOwner, "owner's device was notified");
  assert.equal(toOwner.headers["Content-Encoding"], "aes128gcm");
  assert.match(toOwner.headers.Authorization, /^vapid t=.+, k=/);
  const msg = await browserDecrypt(toOwner.body, ua, auth);
  assert.equal(msg.title, "New application " + d.reference);
  assert.equal(msg.body, "Ndapewa Shikongo · N$ 2 000");
  assert.equal(msg.url, "/?app=" + d.reference);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM push_subscriptions").get().n, 1, "dead device removed");

  const t = await (await call(env, "POST", "/v2/admin/push/test", { headers: staff })).json();
  assert.deepEqual([t.sent, t.devices], [1, 1]);
});

test("CORS only answers the website and the admin console", async () => {
  const env = makeEnv();
  const ok = await call(env, "OPTIONS", "/v2/applications", { headers: { Origin: "https://admin.quickserve.group" } });
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://admin.quickserve.group");
  const bad = await call(env, "OPTIONS", "/v2/applications", { headers: { Origin: "https://evil.example" } });
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
});

test("per-IP limit on new drafts", async () => {
  const env = makeEnv();
  const same = { "CF-Connecting-IP": "10.9.9.9" };
  for (let i = 0; i < 5; i += 1) assert.equal((await call(env, "POST", "/v2/applications", { body: details, headers: same })).status, 201);
  assert.equal((await call(env, "POST", "/v2/applications", { body: details, headers: same })).status, 429);
});

test("clean-up removes old drafts and old declined documents", async () => {
  const env = makeEnv();
  const d = await draftWithDocs(env);
  env.DB.raw.prepare(`UPDATE applications SET created_at = '2020-01-01T00:00:00Z'`).run();
  const out = await cleanUp(env);
  assert.equal(out.draftsRemoved, 1);
  assert.equal(env.DOCS.store.size, 0);
  assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) n FROM applications`).get().n, 0);
  assert.ok(d.reference);
});
