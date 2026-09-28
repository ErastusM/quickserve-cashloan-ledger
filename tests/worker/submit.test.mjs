// POST /applications — validation before any write, sniffing, R2 layout,
// rpc/intake_submit call shape, clean-up and status mapping.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  worker, makeEnv, stubFetch, jsonResponse, pgError, buildForm, submitRequest, fileOf, magicBytes,
  SB_URL, PUB_KEY, INTAKE_KEY
} from "./helpers.mjs";

const MB = 1024 * 1024;
const okRpc = () => jsonResponse({ id: "0b1c2d3e-0000-4000-8000-000000000001", ref: "QSA-7K2M9P" });

async function run(fd, { env = makeEnv(), rpc = okRpc, req = {} } = {}) {
  const stub = stubFetch((call, n) => rpc(call, n));
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const res = await worker.fetch(submitRequest(fd, req), env);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { res, body, env, calls: stub.calls, logged };
  } finally {
    console.error = consoleError;
    stub.restore();
  }
}

test("happy path: 201 + reference, documents in R2, contract-shaped intake_submit", async () => {
  const { res, body, env, calls } = await run(buildForm());
  assert.equal(res.status, 201);
  assert.deepEqual(body, { ok: true, reference: "QSA-7K2M9P" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://erastusm.github.io");

  // One Supabase call, anonymous, with the publishable key in both headers.
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, `${SB_URL}/rest/v1/rpc/intake_submit`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.apikey, PUB_KEY);
  assert.equal(call.headers.authorization, `Bearer ${PUB_KEY}`);
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(call.body).sort(), ["p_app", "p_docs", "p_key"]);
  assert.equal(call.body.p_key, INTAKE_KEY);

  const expectedHash = createHmac("sha256", INTAKE_KEY).update("203.0.113.7").digest("hex");
  assert.deepEqual(call.body.p_app, {
    full_name: "Selma Nangolo",
    national_id: "89031200457",
    date_of_birth: "1989-03-12",
    phone: "+264 81 234 5678",
    email: "selma@example.com",
    address: "14 Moses Garoeb St, Mondesa",
    town: "Swakopmund",
    dependants: 2,
    employer: "Rössing Uranium",
    job_title: "Plant operator",
    employment_type: "Permanent",
    pay_day: "25th",
    bank_name: "FNB Namibia",
    bank_account_holder: "Selma Nangolo",
    bank_account_no: "62 1044 4471",
    salary_into_account: true,
    kin_name: "Martha Nangolo",
    kin_relationship: "Mother",
    kin_phone: "+264 85 612 3390",
    amount_requested: 4000,
    repay_date: "2026-10-28",
    purpose: "School fees",
    declared_income: 18400,
    declared_deductions: 1500,
    declared_expenses: 9000.5,
    other_lender_loans: true,
    other_lender_count: 1,
    consent_processing: true,
    consent_bureau: true,
    consent_version: "2026-09",
    ip_hash: expectedHash
  });
  assert.match(call.body.p_app.ip_hash, /^[0-9a-f]{64}$/);

  // Documents: kind/seq/key/sniffed mime/bytes/name, all under one upload id.
  const docs = call.body.p_docs;
  assert.equal(docs.length, 6);
  const uploadId = docs[0].r2_key.split("/")[1];
  assert.match(uploadId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(docs.map((d) => [d.kind, d.seq, d.r2_key, d.mime, d.bytes, d.original_name]), [
    ["id", 1, `apps/${uploadId}/id-1.jpg`, "image/jpeg", 64, "id-front.jpg"],
    ["payslip", 1, `apps/${uploadId}/payslip-1.pdf`, "application/pdf", 64, "payslip-aug.pdf"],
    ["bank", 1, `apps/${uploadId}/bank-1.pdf`, "application/pdf", 64, "bank-jun.pdf"],
    ["bank", 2, `apps/${uploadId}/bank-2.png`, "image/png", 64, "bank-jul.png"],
    ["bank", 3, `apps/${uploadId}/bank-3.webp`, "image/webp", 64, "bank-aug.webp"],
    ["proof_address", 1, `apps/${uploadId}/proof_address-1.heic`, "image/heic", 64, "IMG_0042.HEIC"]
  ]);

  // R2 got exactly those keys, as Blobs (streamed, not buffered in JS),
  // with the sniffed content type.
  assert.deepEqual([...env.DOCS.store.keys()].sort(), docs.map((d) => d.r2_key).sort());
  for (const put of env.DOCS.log.puts) {
    assert.ok(["File", "Blob"].includes(put.bodyType), `R2 put body should be a Blob, got ${put.bodyType}`);
    const doc = docs.find((d) => d.r2_key === put.key);
    assert.deepEqual(put.opts.httpMetadata, { contentType: doc.mime });
  }
  assert.equal(env.DOCS.log.deletes.length, 0);
});

test("optional fields may be left out: nulls in p_app, consent_bureau false, no proof of address", async () => {
  const fd = buildForm({
    email: undefined, dateOfBirth: "", town: undefined, dependants: undefined, jobTitle: undefined,
    employmentType: undefined, payDay: undefined, bankName: undefined, bankAccountHolder: undefined,
    bankAccountNo: undefined, salaryIntoAccount: undefined, kinRelationship: undefined, amountRequested: undefined,
    declaredIncome: undefined, declaredDeductions: undefined, declaredExpenses: undefined,
    otherLenderLoans: undefined, otherLenderCount: undefined, consentBureau: undefined, consentVersion: undefined,
    address: undefined
  }, { docAddress: [], docBank: [fileOf("jpeg", "bank.jpg")] });
  const { res, calls } = await run(fd);
  assert.equal(res.status, 201);
  const app = calls[0].body.p_app;
  for (const k of ["email", "date_of_birth", "town", "dependants", "job_title", "salary_into_account",
    "amount_requested", "declared_income", "other_lender_loans", "consent_version", "address"]) {
    assert.ok(k in app, `${k} present`);
    assert.equal(app[k], null, `${k} null`);
  }
  assert.equal(app.consent_bureau, false);
  assert.equal(app.consent_processing, true);
  assert.deepEqual(calls[0].body.p_docs.map((d) => d.kind), ["id", "payslip", "bank"]);
});

test("empty file inputs (as browsers send them) count as no file", async () => {
  const fd = buildForm({}, { docAddress: [] });
  fd.append("docAddress", new File([], "", { type: "application/octet-stream" }));
  const { res, calls } = await run(fd);
  assert.equal(res.status, 201);
  assert.ok(!calls[0].body.p_docs.some((d) => d.kind === "proof_address"));
});

test("legacy form compatibility: consent=yes and numeric income", async () => {
  const fd = buildForm({ consentProcessing: undefined, consent: "yes", declaredIncome: undefined, income: "12500.00", submittedAt: "2026-09-28T07:00:00Z" });
  const { res, calls } = await run(fd);
  assert.equal(res.status, 201);
  const app = calls[0].body.p_app;
  assert.equal(app.consent_processing, true);
  assert.equal(app.declared_income, 12500);
  assert.ok(!("declared" in app));
  assert.ok(!("income" in app) && !("consent" in app) && !("submittedAt" in app) && !("website" in app));
});

test("legacy form compatibility: non-numeric income is kept as declared.income_text", async () => {
  const fd = buildForm({ consentProcessing: undefined, consent: "yes", declaredIncome: undefined, income: "about 9k a month" });
  const { res, calls } = await run(fd);
  assert.equal(res.status, 201);
  const app = calls[0].body.p_app;
  assert.equal(app.declared_income, null);
  assert.deepEqual(app.declared, { income_text: "about 9k a month" });
});

test("a legacy-only post (old apply.html field set) is accepted", async () => {
  const fd = new FormData();
  const old = { fullName: "Old Form", phone: "081 234 5678", nationalId: "90010100123", address: "", employer: "Shop",
    income: "", kinName: "Kin", kinPhone: "081 111 2222", purpose: "Rent", repayDate: "2026-10-25", consent: "yes" };
  for (const [k, v] of Object.entries(old)) fd.append(k, v);
  fd.append("docId", fileOf("jpeg", "id.jpg"));
  fd.append("docBank", fileOf("pdf", "bank.pdf"));
  fd.append("docPayslip", fileOf("png", "slip.png"));
  const { res, body, calls } = await run(fd);
  assert.equal(res.status, 201);
  assert.equal(body.reference, "QSA-7K2M9P");
  assert.equal(calls[0].body.p_app.consent_processing, true);
  assert.equal(calls[0].body.p_app.consent_version, "legacy-v0", "the old form's consent wording");
  assert.equal(calls[0].body.p_app.address, null);
});

test("an explicit consentVersion is never overwritten by the legacy label", async () => {
  const { calls } = await run(buildForm({ consentProcessing: undefined, consent: "yes", consentVersion: "2026-09" }));
  assert.equal(calls[0].body.p_app.consent_version, "2026-09");
});

test("limits mirror the database (intake_submit) so errors are named before any upload", async () => {
  const tomorrow = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
  const bad = {
    email: "a".repeat(111) + "@example.com", bankAccountNo: "1".repeat(31), dependants: "51",
    otherLenderCount: "51", declaredExpenses: "10000000.01", amountRequested: "100000.01",
    dateOfBirth: tomorrow, fullName: "X"
  };
  const { res, body, env, calls } = await run(buildForm(bad));
  assert.equal(res.status, 400);
  assert.deepEqual(body.fields.sort(), Object.keys(bad).sort());
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);

  const edge = { dependants: "50", declaredIncome: "10,000,000", amountRequested: "100000", nationalId: "P123", bankAccountNo: "1".repeat(30) };
  const ok = await run(buildForm(edge));
  assert.equal(ok.res.status, 201);
  const app = ok.calls[0].body.p_app;
  assert.equal(app.dependants, 50);
  assert.equal(app.declared_income, 10000000);
  assert.equal(app.amount_requested, 100000);
  assert.equal(app.national_id, "P123");
});

test("missing required field → 400 with field names, zero R2 writes, no RPC", async () => {
  const { res, body, env, calls } = await run(buildForm({ fullName: "  ", kinPhone: undefined }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: "invalid", fields: ["fullName", "kinPhone"] });
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("missing documents → 400, zero writes", async () => {
  const { res, body, env, calls } = await run(buildForm({}, { docBank: [], docPayslip: [] }));
  assert.equal(res.status, 400);
  assert.deepEqual(body.fields.sort(), ["docBank", "docPayslip"]);
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("too many files in a slot → 400, zero writes", async () => {
  const seven = Array.from({ length: 7 }, (_, i) => fileOf("pdf", `b${i}.pdf`));
  const two = [fileOf("jpeg", "a.jpg"), fileOf("jpeg", "b.jpg")];
  const { res, body, env } = await run(buildForm({}, { docBank: seven, docId: two }));
  assert.equal(res.status, 400);
  assert.deepEqual(body.fields.sort(), ["docBank", "docId"]);
  assert.equal(env.DOCS.log.puts.length, 0);
});

test("processing consent must be an explicit yes", async () => {
  for (const fields of [{ consentProcessing: "no" }, { consentProcessing: undefined }, { consentProcessing: undefined, consent: "no" }]) {
    const { res, body, env } = await run(buildForm(fields));
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.ok(body.fields.includes(fields.consent ? "consent" : "consentProcessing"));
    assert.equal(env.DOCS.log.puts.length, 0);
  }
});

test("malformed values → 400 naming each field", async () => {
  const bad = {
    repayDate: "2026-02-30", dateOfBirth: "12/03/1989", phone: "call me", email: "nope", dependants: "-1",
    amountRequested: "0", declaredIncome: "18400,50", salaryIntoAccount: "maybe", otherLenderCount: "lots",
    bankAccountNo: "<script>", nationalId: "12", purpose: "x".repeat(301)
  };
  const { res, body, env, calls } = await run(buildForm(bad));
  assert.equal(res.status, 400);
  assert.deepEqual(body.fields.sort(), Object.keys(bad).sort());
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("a file posted where text is expected (or text where a file is) → 400", async () => {
  const fd = buildForm({ fullName: undefined }, { docPayslip: [] });
  fd.append("fullName", fileOf("jpeg", "name.jpg"));
  fd.append("docPayslip", "not a file");
  const { res, body, env } = await run(fd);
  assert.equal(res.status, 400);
  assert.deepEqual(body.fields.sort(), ["docPayslip", "fullName"]);
  assert.equal(env.DOCS.log.puts.length, 0);
});

test("not multipart → 400 without detail", async () => {
  const env = makeEnv();
  const req = new Request("https://intake.example.workers.dev/applications", {
    method: "POST", body: "{", headers: { "Content-Type": "application/json", Origin: "https://erastusm.github.io" }
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid" });
});

test("a file over 10 MB → 413, zero writes, no RPC", async () => {
  const big = fileOf("pdf", "huge.pdf", { size: 10 * MB + 1 });
  const { res, body, env, calls } = await run(buildForm({}, { docPayslip: [big] }));
  assert.equal(res.status, 413);
  assert.deepEqual(body, { error: "too_large", fields: ["docPayslip"] });
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("exactly 10 MB is allowed", async () => {
  const edge = fileOf("pdf", "edge.pdf", { size: 10 * MB });
  const { res } = await run(buildForm({}, { docPayslip: [edge] }));
  assert.equal(res.status, 201);
});

test("more than 40 MB in total → 413, zero writes", async () => {
  const nine = (n) => fileOf("pdf", `p${n}.pdf`, { size: 9 * MB });
  const { res, body, env, calls } = await run(buildForm({}, {
    docId: [nine(1)], docPayslip: [nine(2)], docBank: [nine(3), nine(4), nine(5)], docAddress: []
  }));
  assert.equal(res.status, 413);
  assert.deepEqual(body, { error: "too_large", fields: ["documents"] });
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("a declared Content-Length over the limit is refused before parsing", async () => {
  const { res, body, env } = await run(buildForm(), { req: { headers: { "Content-Length": String(42 * MB) } } });
  assert.equal(res.status, 413);
  assert.equal(body.error, "too_large");
  assert.equal(env.DOCS.log.puts.length, 0);
});

test("HTML disguised as a .jpg (claimed image/jpeg) → 415, zero writes", async () => {
  const fake = fileOf("html", "id.jpg", { claimed: "image/jpeg" });
  const { res, body, env, calls } = await run(buildForm({}, { docId: [fake] }));
  assert.equal(res.status, 415);
  assert.deepEqual(body, { error: "unsupported_type", fields: ["docId"] });
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("SVG, GIF and random bytes are refused whatever their name", async () => {
  for (const type of ["svg", "gif"]) {
    const { res, env } = await run(buildForm({}, { docBank: [fileOf("pdf", "ok.pdf"), fileOf(type, "x.png", { claimed: "image/png" })] }));
    assert.equal(res.status, 415, type);
    assert.equal(env.DOCS.log.puts.length, 0);
  }
  const noise = new File([new Uint8Array(32).fill(7)], "scan.pdf", { type: "application/pdf" });
  const { res } = await run(buildForm({}, { docPayslip: [noise] }));
  assert.equal(res.status, 415);
});

test("sniffing: PNG, JPEG, PDF, WEBP and HEIC brands get the right type and extension", async () => {
  const cases = [
    ["png", "image/png", "png"], ["jpeg", "image/jpeg", "jpg"], ["pdf", "application/pdf", "pdf"],
    ["webp", "image/webp", "webp"], ["heic", "image/heic", "heic"], ["heix", "image/heic", "heic"],
    ["mif1", "image/heic", "heic"]
  ];
  for (const [type, mime, ext] of cases) {
    // The browser's claim is deliberately wrong: only the bytes decide.
    const f = fileOf(type, "upload.bin", { claimed: "text/html" });
    const { res, env, calls } = await run(buildForm({}, { docId: [f] }));
    assert.equal(res.status, 201, type);
    const doc = calls[0].body.p_docs.find((d) => d.kind === "id");
    assert.equal(doc.mime, mime, type);
    assert.ok(doc.r2_key.endsWith(`/id-1.${ext}`), doc.r2_key);
    assert.equal(env.DOCS.store.get(doc.r2_key).httpMetadata.contentType, mime);
  }
});

test("honeypot filled → fake 201 with a QSA-looking reference, nothing stored, no RPC", async () => {
  const { res, body, env, calls } = await run(buildForm({ website: "http://spam.example", fullName: "" }));
  assert.equal(res.status, 201);
  assert.equal(body.ok, true);
  assert.match(body.reference, /^QSA-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(env.DOCS.log.puts.length, 0);
  assert.equal(calls.length, 0);
});

test("RPC failure → R2 cleaned up, generic 500 that leaks nothing", async () => {
  const { res, body, env, calls } = await run(buildForm(), {
    rpc: () => pgError('QS_BAD_KEY: relation "private.intake_keys" secret detail', 400)
  });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: "server_error" });
  assert.equal(calls.length, 1);
  assert.equal(env.DOCS.log.puts.length, 6);
  assert.equal(env.DOCS.store.size, 0, "every uploaded key deleted");
  assert.deepEqual(env.DOCS.log.deletes.sort(), calls[0].body.p_docs.map((d) => d.r2_key).sort());
});

// An unclear outcome (no answer, a 5xx) may have come after the database
// committed: one retry of the same payload (intake_submit is idempotent on
// the upload folder); if still unclear, the files are KEPT and their keys
// logged, because a stored application may point at them.
test("Supabase unreachable twice (fetch throws) → one retry, files kept and logged, generic 500", async () => {
  const { res, body, env, calls, logged } = await run(buildForm(), { rpc: () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); } });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: "server_error" });
  assert.equal(calls.length, 2, "asked twice");
  assert.deepEqual(calls[1].body, calls[0].body, "the retry is the same submission");
  assert.equal(env.DOCS.store.size, 6, "files kept");
  assert.equal(env.DOCS.log.deletes.length, 0);
  assert.equal(logged.length, 1);
  const line = JSON.parse(logged[0]);
  assert.equal(line.event, "intake_unclear");
  assert.deepEqual(line.keys.sort(), calls[0].body.p_docs.map((d) => d.r2_key).sort(), "the kept keys are logged");
  assert.ok(!logged[0].includes("ECONNREFUSED") && !logged[0].includes(calls[0].body.p_app.full_name), "only keys, no personal data");
});

test("Supabase 5xx with HTML body twice → files kept, generic 500", async () => {
  for (const status of [502, 503, 504, 500]) {
    const { res, body, env, calls } = await run(buildForm(), { rpc: () => new Response("<h1>Bad Gateway</h1>", { status }) });
    assert.equal(res.status, 500, `${status}`);
    assert.deepEqual(body, { error: "server_error" });
    assert.equal(calls.length, 2, `${status}: retried once`);
    assert.equal(env.DOCS.store.size, 6, `${status}: files kept`);
  }
});

test("a gateway timeout, then the retry finds the stored application → 201 with its reference, files kept", async () => {
  const { res, body, env, calls, logged } = await run(buildForm(), {
    rpc: (call, n) => (n === 1 ? new Response("upstream timed out", { status: 504 }) : okRpc())
  });
  assert.equal(res.status, 201);
  assert.deepEqual(body, { ok: true, reference: "QSA-7K2M9P" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.equal(env.DOCS.store.size, 6);
  assert.equal(env.DOCS.log.deletes.length, 0);
  assert.equal(logged.length, 0);
});

test("unclear, then a definite refusal on the retry → cleaned up and mapped", async () => {
  const { res, body, env, calls } = await run(buildForm(), {
    rpc: (call, n) => { if (n === 1) throw new Error("socket hang up"); return pgError("QS_RATE_LIMIT: Too many applications."); }
  });
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: "rate_limited" });
  assert.equal(calls.length, 2);
  assert.equal(env.DOCS.store.size, 0, "refused, so nothing points at the files");
});

test("408 and 409 are unclear too (retried; files kept when still unclear)", async () => {
  for (const status of [408, 409]) {
    const { res, env, calls } = await run(buildForm(), { rpc: () => jsonResponse({ code: "23505", message: "duplicate key" }, status) });
    assert.equal(res.status, 500, `${status}`);
    assert.equal(calls.length, 2, `${status}: retried once`);
    assert.equal(env.DOCS.store.size, 6, `${status}: files kept`);
  }
});

test("a definite refusal from PostgREST itself (401/403/404) → cleaned up, no retry, generic 500", async () => {
  for (const status of [401, 403, 404]) {
    const { res, body, env, calls } = await run(buildForm(), {
      rpc: () => jsonResponse({ code: "PGRST301", message: "JWT expired" }, status)
    });
    assert.equal(res.status, 500, `${status}`);
    assert.deepEqual(body, { error: "server_error" });
    assert.equal(calls.length, 1, `${status}: not retried`);
    assert.equal(env.DOCS.store.size, 0, `${status}: cleaned up`);
  }
});

test("an R2 put failing mid-way → already-written keys removed, no RPC, generic 500", async () => {
  const env = makeEnv();
  env.DOCS.failPut = (key) => key.includes("/bank-2.");
  const { res, body, calls } = await run(buildForm(), { env });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: "server_error" });
  assert.equal(calls.length, 0);
  assert.equal(env.DOCS.store.size, 0);
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("QS_RATE_LIMIT → 429 (cleaned up); QS_INVALID → 400 (cleaned up)", async () => {
  const limited = await run(buildForm(), { rpc: () => pgError("QS_RATE_LIMIT: Too many applications from this connection.") });
  assert.equal(limited.calls.length, 1, "a refusal is final: no retry");
  assert.equal(limited.res.status, 429);
  assert.deepEqual(limited.body, { error: "rate_limited" });
  assert.equal(limited.res.headers.get("Retry-After"), "3600");
  assert.equal(limited.env.DOCS.store.size, 0);

  const invalid = await run(buildForm(), { rpc: () => pgError("QS_INVALID: repay_date is more than 5 months away.") });
  assert.equal(invalid.res.status, 400);
  assert.deepEqual(invalid.body, { error: "invalid" });
  assert.equal(invalid.env.DOCS.store.size, 0);
});

test("the database's field list comes back as form names (known names only, never the message)", async () => {
  const { res, body, env } = await run(buildForm(), {
    rpc: () => pgError("QS_INVALID: Check these fields: amount_requested, consent_processing, documents, ip_hash, phone.")
  });
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: "invalid", fields: ["amountRequested", "consentProcessing", "documents", "phone"] });
  assert.equal(env.DOCS.store.size, 0);
  const odd = await run(buildForm(), { rpc: () => pgError("QS_INVALID: Check these fields: <script>, secret_column.") });
  assert.deepEqual(odd.body, { error: "invalid" }, "nothing unknown is echoed");
});

test("ip_hash: HMAC of CF-Connecting-IP keyed by INTAKE_KEY; differs per IP and never contains the IP", async () => {
  const a = await run(buildForm(), { req: { ip: "198.51.100.23" } });
  const b = await run(buildForm(), { req: { ip: "198.51.100.24" } });
  const ha = a.calls[0].body.p_app.ip_hash;
  const hb = b.calls[0].body.p_app.ip_hash;
  assert.equal(ha, createHmac("sha256", INTAKE_KEY).update("198.51.100.23").digest("hex"));
  assert.notEqual(ha, hb);
  assert.ok(!JSON.stringify(a.calls[0].body).includes("198.51.100.23"));
});

test("misconfigured Worker (no INTAKE_KEY / secret key in place of publishable) → 500 before any write", async () => {
  const noKey = await run(buildForm(), { env: makeEnv({ INTAKE_KEY: undefined }) });
  assert.equal(noKey.res.status, 500);
  assert.equal(noKey.env.DOCS.log.puts.length, 0);
  assert.equal(noKey.calls.length, 0);

  const secret = await run(buildForm(), { env: makeEnv({ SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc123" }) });
  assert.equal(secret.res.status, 500);
  assert.equal(secret.env.DOCS.log.puts.length, 0);
  assert.equal(secret.calls.length, 0);

  const jwt = (role) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ role })).toString("base64url"), "sig"].join(".");
  const service = await run(buildForm(), { env: makeEnv({ SUPABASE_PUBLISHABLE_KEY: jwt("service_role") }) });
  assert.equal(service.res.status, 500);
  assert.equal(service.calls.length, 0);
  const anon = await run(buildForm(), { env: makeEnv({ SUPABASE_PUBLISHABLE_KEY: jwt("anon") }) });
  assert.equal(anon.res.status, 201);
});

test("a 2xx from Supabase is final: files are never deleted after the row exists", async () => {
  const { res, body, env } = await run(buildForm(), { rpc: () => new Response("", { status: 200 }) });
  assert.equal(res.status, 201);
  assert.deepEqual(body, { ok: true, reference: null });
  assert.equal(env.DOCS.store.size, 6);
  assert.equal(env.DOCS.log.deletes.length, 0);
});

test("a one-row array result from intake_submit is read the same way", async () => {
  const { res, body } = await run(buildForm(), { rpc: () => jsonResponse([{ id: "x", ref: "QSA-ARRAY2" }]) });
  assert.equal(res.status, 201);
  assert.equal(body.reference, "QSA-ARRAY2");
});

test("magic bytes helper sanity (fixtures really start with the signatures)", () => {
  assert.deepEqual([...magicBytes("jpeg").slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal(new TextDecoder().decode(magicBytes("webp").slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(magicBytes("heic").slice(4, 12)), "ftypheic");
});
