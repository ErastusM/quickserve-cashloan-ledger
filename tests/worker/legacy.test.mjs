// Legacy: the old inbox's OWNER_TOKEN routes keep working (with hardened file
// headers), and POST /legacy/migrate copies D1 into Supabase in batches of 25.

import test from "node:test";
import assert from "node:assert/strict";
import {
  worker, makeEnv, makeR2, makeD1, stubFetch, jsonResponse, pgError, magicBytes, toBytes,
  ORIGIN, SB_URL, PUB_KEY, INTAKE_KEY, OWNER_TOKEN
} from "./helpers.mjs";

const BASE = "https://intake.example.workers.dev";

function d1Row(i, extra = {}) {
  const id = `QS-${String(i).padStart(6, "0")}`;
  return {
    id,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString(),
    status: ["new", "approved", "declined"][i % 3],
    full_name: `Applicant ${i}`, phone: "081 234 5678", national_id: `9001010${String(i).padStart(4, "0")}`,
    address: null, employer: "Shop", income: i % 2 ? "8500" : "about 9k",
    kin_name: "Kin", kin_phone: "081 000 0000", purpose: "Rent", repay_date: "2026-02-25", consent: "yes",
    doc_id_key: `applications/${id}/id-id.jpg`,
    doc_bank_keys: JSON.stringify([`applications/${id}/bank-0-jun.pdf`, `applications/${id}/bank-1-jul.png`]),
    doc_payslip_key: `applications/${id}/payslip-slip.pdf`,
    decided_at: null, decided_note: null,
    ...extra
  };
}

function r2For(rows) {
  const objects = {};
  for (const r of rows) {
    objects[r.doc_id_key] = magicBytes("jpeg", 300);
    const [b0, b1] = JSON.parse(r.doc_bank_keys);
    objects[b0] = magicBytes("pdf", 500);
    objects[b1] = magicBytes("png", 200);
    objects[r.doc_payslip_key] = magicBytes("pdf", 400);
  }
  return makeR2(objects);
}

function ownerReq(path, { method = "GET", token = OWNER_TOKEN, body, origin = ORIGIN } = {}) {
  const headers = {};
  if (token != null) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// A stand-in for rpc/intake_import_legacy that remembers refs (idempotent).
function fakeImporter() {
  const seen = new Set();
  return (call) => {
    if (!call.url.endsWith("/rest/v1/rpc/intake_import_legacy")) return jsonResponse({ message: "unexpected" }, 500);
    if (call.body.p_key !== INTAKE_KEY) return pgError("QS_BAD_KEY: Wrong intake key.");
    let imported = 0;
    let skipped = 0;
    for (const row of call.body.p_rows) {
      if (seen.has(row.ref)) skipped += 1;
      else { seen.add(row.ref); imported += 1; }
    }
    return jsonResponse({ imported, skipped });
  };
}

// ── legacy owner routes ─────────────────────────────────────────────────────

test("legacy routes require the OWNER_TOKEN", async () => {
  const env = makeEnv({ DB: makeD1([d1Row(1)]) });
  for (const token of [null, "wrong", OWNER_TOKEN + "x", "eyJhbGciOi.user.jwt"]) {
    for (const path of ["/applications", "/applications/QS-000001", "/applications/QS-000001/file/id"]) {
      const res = await worker.fetch(ownerReq(path, { token }), env);
      assert.equal(res.status, 401, `${path} ${token}`);
    }
    const res = await worker.fetch(ownerReq("/applications/QS-000001/status", { method: "POST", token, body: { status: "approved" } }), env);
    assert.equal(res.status, 401);
  }
  const noSecret = makeEnv({ OWNER_TOKEN: undefined });
  assert.equal((await worker.fetch(ownerReq("/applications", { token: "" }), noSecret)).status, 401);
});

test("GET /applications lists (and filters by status) as before", async () => {
  const rows = [d1Row(1), d1Row(2), d1Row(3), d1Row(4)];
  const env = makeEnv({ DB: makeD1(rows) });
  const all = await (await worker.fetch(ownerReq("/applications"), env)).json();
  assert.equal(all.applications.length, 4);
  assert.equal(all.applications[0].id, "QS-000004", "newest first");
  assert.deepEqual(Object.keys(all.applications[0]).sort(),
    ["created_at", "employer", "full_name", "id", "national_id", "phone", "purpose", "repay_date", "status"]);

  const res = await worker.fetch(ownerReq("/applications?status=new"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const onlyNew = await res.json();
  assert.ok(onlyNew.applications.length > 0 && onlyNew.applications.every((a) => a.status === "new"));
});

test("GET /applications/:id returns the row without raw R2 keys", async () => {
  const env = makeEnv({ DB: makeD1([d1Row(7)]) });
  const res = await worker.fetch(ownerReq("/applications/QS-000007"), env);
  assert.equal(res.status, 200);
  const { application } = await res.json();
  assert.equal(application.full_name, "Applicant 7");
  assert.equal(application.doc_bank_count, 2);
  assert.ok(!("doc_id_key" in application) && !("doc_payslip_key" in application) && !("doc_bank_keys" in application));
  assert.equal((await worker.fetch(ownerReq("/applications/QS-999999"), env)).status, 404);
});

test("POST /applications/:id/status updates D1 as before", async () => {
  const db = makeD1([d1Row(2)]);
  const env = makeEnv({ DB: db });
  const ok = await worker.fetch(ownerReq("/applications/QS-000002/status", { method: "POST", body: { status: "declined", note: "n".repeat(600) } }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(db.rows[0].status, "declined");
  assert.equal(db.rows[0].decided_note.length, 500);
  const bad = await worker.fetch(ownerReq("/applications/QS-000002/status", { method: "POST", body: { status: "disbursed" } }), env);
  assert.equal(bad.status, 400);
  const missing = await worker.fetch(ownerReq("/applications/QS-404404/status", { method: "POST", body: { status: "approved" } }), env);
  assert.equal(missing.status, 404);
});

test("legacy file route: type re-decided from the bytes, served with the safe headers", async () => {
  const row = d1Row(5);
  const r2 = r2For([row]);
  const env = makeEnv({ DB: makeD1([row]), DOCS: r2 });

  const id = await worker.fetch(ownerReq("/applications/QS-000005/file/id"), env);
  assert.equal(id.status, 200);
  assert.equal(id.headers.get("Content-Type"), "image/jpeg");
  assert.equal(id.headers.get("Content-Disposition"), 'inline; filename="id.jpg"');
  assert.equal(id.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
  assert.equal(id.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(id.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await id.arrayBuffer()).byteLength, 300);

  const bank1 = await worker.fetch(ownerReq("/applications/QS-000005/file/bank/1"), env);
  assert.equal(bank1.headers.get("Content-Type"), "image/png");
  const slip = await worker.fetch(ownerReq("/applications/QS-000005/file/payslip"), env);
  assert.equal(slip.headers.get("Content-Type"), "application/pdf");
  assert.equal(slip.headers.get("Content-Security-Policy"), null);

  assert.equal((await worker.fetch(ownerReq("/applications/QS-000005/file/bank/9"), env)).status, 404);
  assert.equal((await worker.fetch(ownerReq("/applications/QS-000005/file/other"), env)).status, 404);
});

test("legacy file route: an uploaded web page (the old XSS hole) downloads as inert bytes", async () => {
  const row = d1Row(6);
  const r2 = r2For([row]);
  // The old Worker stored the browser-claimed type verbatim.
  r2.store.set(row.doc_id_key, { bytes: toBytes("<html><script>steal()</script></html>"), httpMetadata: { contentType: "text/html" } });
  const env = makeEnv({ DB: makeD1([row]), DOCS: r2 });
  const res = await worker.fetch(ownerReq("/applications/QS-000006/file/id"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="id.bin"');
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

// ── POST /legacy/migrate ────────────────────────────────────────────────────

test("migrate requires the OWNER_TOKEN (a Supabase login is not enough)", async () => {
  const env = makeEnv({ DB: makeD1([d1Row(1)]), DOCS: r2For([d1Row(1)]) });
  const stub = stubFetch(fakeImporter());
  try {
    for (const token of [null, "", "wrong", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig"]) {
      const res = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST", token }), env);
      assert.equal(res.status, 401);
    }
    assert.equal(stub.calls.length, 0);
    assert.equal(env.DOCS.log.gets.length, 0);
  } finally {
    stub.restore();
  }
});

test("migrate: 60 rows → batches of 25/25/10, sniffed docs, D1 fields kept, idempotent re-run", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => d1Row(i + 1));
  const env = makeEnv({ DB: makeD1(rows), DOCS: r2For(rows) });
  const stub = stubFetch(fakeImporter());
  try {
    const res = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST" }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { imported: 60, skipped: 0 });

    assert.deepEqual(stub.calls.map((c) => c.body.p_rows.length), [25, 25, 10]);
    for (const call of stub.calls) {
      assert.equal(call.url, `${SB_URL}/rest/v1/rpc/intake_import_legacy`);
      assert.equal(call.headers.apikey, PUB_KEY);
      assert.equal(call.headers.authorization, `Bearer ${PUB_KEY}`);
      assert.deepEqual(Object.keys(call.body).sort(), ["p_key", "p_rows"]);
      assert.equal(call.body.p_key, INTAKE_KEY);
    }

    // Oldest first; every D1 field carried; doc keys → docs with sniffed types.
    const first = stub.calls[0].body.p_rows[0];
    assert.equal(first.ref, "QS-000001");
    assert.equal(first.id, "QS-000001");
    assert.equal(first.status, "approved");
    assert.equal(first.full_name, "Applicant 1");
    assert.equal(first.income, "8500");
    assert.equal(first.declared_income, 8500);
    assert.equal(first.consent, "yes");
    assert.equal(first.consent_processing, true);
    assert.ok(!("doc_id_key" in first) && !("doc_bank_keys" in first) && !("doc_payslip_key" in first));
    assert.deepEqual(first.docs, [
      { kind: "id", seq: 1, r2_key: "applications/QS-000001/id-id.jpg", mime: "image/jpeg", bytes: 300, original_name: "id.jpg" },
      { kind: "payslip", seq: 1, r2_key: "applications/QS-000001/payslip-slip.pdf", mime: "application/pdf", bytes: 400, original_name: "slip.pdf" },
      { kind: "bank", seq: 1, r2_key: "applications/QS-000001/bank-0-jun.pdf", mime: "application/pdf", bytes: 500, original_name: "jun.pdf" },
      { kind: "bank", seq: 2, r2_key: "applications/QS-000001/bank-1-jul.png", mime: "image/png", bytes: 200, original_name: "jul.png" }
    ]);
    assert.deepEqual(first.docs_skipped, []);
    assert.equal(stub.calls[0].body.p_rows[1].declared_income, null, "non-numeric income stays text");

    // Only 16-byte ranged reads — documents are never downloaded whole.
    assert.equal(env.DOCS.log.gets.length, 60 * 4);
    assert.ok(env.DOCS.log.gets.every((g) => g.range && g.range.offset === 0 && g.range.length === 16));
    assert.equal(env.DOCS.log.puts.length + env.DOCS.log.deletes.length, 0, "R2 is read-only here");

    // Second run sends the same rows; the database skips them all.
    const firstPayload = JSON.stringify(stub.calls.map((c) => c.body));
    stub.calls.length = 0;
    const again = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST" }), env);
    assert.deepEqual(await again.json(), { imported: 0, skipped: 60 });
    assert.equal(JSON.stringify(stub.calls.map((c) => c.body)), firstPayload);
  } finally {
    stub.restore();
  }
});

test("migrate: missing and non-document objects are left out (and reported per row)", async () => {
  const row = d1Row(1);
  const r2 = r2For([row]);
  r2.store.delete(row.doc_payslip_key);
  const [, bank1] = JSON.parse(row.doc_bank_keys);
  r2.store.set(bank1, { bytes: toBytes("<!doctype html><script>x()</script>"), httpMetadata: { contentType: "image/png" } });
  const env = makeEnv({ DB: makeD1([row, d1Row(2, { doc_bank_keys: "not json", doc_payslip_key: null })]), DOCS: r2 });
  const stub = stubFetch(fakeImporter());
  try {
    const res = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST" }), env);
    assert.equal(res.status, 200);
    const [a, b] = stub.calls[0].body.p_rows;
    assert.deepEqual(a.docs.map((d) => [d.kind, d.seq, d.mime]), [["id", 1, "image/jpeg"], ["bank", 1, "application/pdf"]]);
    assert.deepEqual(a.docs_skipped, [
      { kind: "payslip", seq: 1, reason: "missing" },
      { kind: "bank", seq: 2, reason: "unsupported_type" }
    ]);
    assert.deepEqual(b.docs, []);
    assert.deepEqual(b.docs_skipped, [{ kind: "id", seq: 1, reason: "missing" }]);
  } finally {
    stub.restore();
  }
});

test("migrate: an RPC failure stops with a generic 500 and the counts so far", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => d1Row(i + 1));
  const env = makeEnv({ DB: makeD1(rows), DOCS: r2For(rows) });
  const importer = fakeImporter();
  const stub = stubFetch((call, n) => (n === 2 ? pgError("QS_BAD_KEY: key hash abc123 mismatch") : importer(call)));
  try {
    const res = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST" }), env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "server_error", imported: 25, skipped: 0 });
  } finally {
    stub.restore();
  }
});

test("migrate with an empty D1 makes no RPC call", async () => {
  const env = makeEnv({ DB: makeD1([]) });
  const stub = stubFetch(fakeImporter());
  try {
    const res = await worker.fetch(ownerReq("/legacy/migrate", { method: "POST" }), env);
    assert.deepEqual(await res.json(), { imported: 0, skipped: 0 });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("an unexpected exception inside a route is a generic 500 (no message leak)", async () => {
  const env = makeEnv({ DB: { prepare() { throw new Error("D1_ERROR: no such table: applications (secret path /var/db)"); } } });
  const res = await worker.fetch(ownerReq("/applications"), env);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text, JSON.stringify({ error: "server_error" }));
});
