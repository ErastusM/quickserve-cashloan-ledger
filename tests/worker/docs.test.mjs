// GET /docs/:docId — token forwarding to rpc/doc_access, status passthrough,
// and the safe response headers per document type.

import test from "node:test";
import assert from "node:assert/strict";
import {
  worker, makeEnv, makeR2, stubFetch, jsonResponse, pgError, magicBytes, ORIGIN, SB_URL, PUB_KEY, DOC_ID
} from "./helpers.mjs";

const USER_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.c2lnbmF0dXJl";

function docRequest(id = DOC_ID, { token = USER_JWT, origin = ORIGIN } = {}) {
  const headers = {};
  if (token != null) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return new Request(`https://intake.example.workers.dev/docs/${id}`, { headers });
}

async function run(req, { env = makeEnv(), rpc } = {}) {
  const stub = stubFetch((call) => rpc(call));
  try {
    const res = await worker.fetch(req, env);
    return { res, calls: stub.calls, env };
  } finally {
    stub.restore();
  }
}

test("no Authorization → 401 and Supabase is never called", async () => {
  for (const token of [null, "", "not a token!"]) {
    const { res, calls } = await run(docRequest(DOC_ID, { token }), { rpc: () => jsonResponse({}) });
    assert.equal(res.status, 401, String(token));
    assert.deepEqual(await res.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
  }
  const basic = new Request(`https://intake.example.workers.dev/docs/${DOC_ID}`, { headers: { Authorization: "Basic abc" } });
  const { res } = await run(basic, { rpc: () => jsonResponse({}) });
  assert.equal(res.status, 401);
});

test("not a uuid → 404 without calling Supabase", async () => {
  const { res, calls } = await run(docRequest("..%2Fapps%2Fx"), { rpc: () => jsonResponse({}) });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test("forwards the caller's own token (not the publishable key) to rpc/doc_access", async () => {
  const env = makeEnv({ DOCS: makeR2({ "apps/u1/id-1.jpg": magicBytes("jpeg", 100) }) });
  const { res, calls } = await run(docRequest(), {
    env, rpc: () => jsonResponse({ r2_key: "apps/u1/id-1.jpg", mime: "image/jpeg", original_name: "x.jpg", kind: "id" })
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SB_URL}/rest/v1/rpc/doc_access`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.apikey, PUB_KEY);
  assert.equal(calls[0].headers.authorization, `Bearer ${USER_JWT}`);
  assert.deepEqual(calls[0].body, { p_doc_id: DOC_ID });
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.length, 100);
  assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
});

test("401/403/404 from Supabase pass through; QS_FORBIDDEN / QS_NOT_FOUND map to 403 / 404", async () => {
  const cases = [
    [() => jsonResponse({ code: "PGRST301", message: "JWT expired" }, 401), 401],
    [() => jsonResponse({ code: "42501", message: "permission denied for function doc_access" }, 403), 403],
    [() => pgError("QS_FORBIDDEN: Only staff can view documents."), 403],
    [() => jsonResponse({ code: "PGRST202", message: "not found" }, 404), 404],
    [() => pgError("QS_NOT_FOUND: No such document."), 404],
    [() => jsonResponse(null, 200), 404],
    [() => pgError("QS_BAD_STATE: internal detail"), 500],
    [() => new Response("upstream down", { status: 503 }), 500]
  ];
  for (const [rpc, want] of cases) {
    const { res, env } = await run(docRequest(), { rpc });
    assert.equal(res.status, want);
    const body = await res.json();
    assert.ok(["unauthorized", "forbidden", "not_found", "server_error"].includes(body.error));
    assert.ok(!JSON.stringify(body).includes("detail") && !JSON.stringify(body).includes("permission"));
    assert.equal(env.DOCS.log.gets.length, 0, "R2 untouched unless Supabase says yes");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  }
});

test("object missing from R2 → 404", async () => {
  const { res } = await run(docRequest(), {
    rpc: () => jsonResponse({ r2_key: "apps/gone/id-1.jpg", mime: "image/jpeg", original_name: "x", kind: "id" })
  });
  assert.equal(res.status, 404);
});

test("keys outside the document prefixes are never read", async () => {
  for (const r2_key of ["secrets/config", "apps/../x", "", 42]) {
    const { res, env } = await run(docRequest(), { rpc: () => jsonResponse({ r2_key, mime: "application/pdf", kind: "id" }) });
    assert.equal(res.status, 404, String(r2_key));
    assert.equal(env.DOCS.log.gets.length, 0);
  }
});

const HEADER_CASES = [
  // mime from doc_access, kind, expected content type, disposition, csp?
  ["image/jpeg", "id", "image/jpeg", 'inline; filename="id.jpg"', true],
  ["image/png", "bank", "image/png", 'inline; filename="bank.png"', true],
  ["image/webp", "proof_address", "image/webp", 'inline; filename="proof_address.webp"', true],
  ["application/pdf", "payslip", "application/pdf", 'inline; filename="payslip.pdf"', false],
  ["image/heic", "id", "image/heic", 'attachment; filename="id.heic"', true],
  ["text/html", "bank", "application/octet-stream", 'attachment; filename="bank.bin"', false],
  ["image/svg+xml", "evil\"; x=\"", "application/octet-stream", 'attachment; filename="document.bin"', false]
];

for (const [mime, kind, type, disposition, csp] of HEADER_CASES) {
  test(`safe headers for ${mime} (${kind})`, async () => {
    const env = makeEnv({ DOCS: makeR2({ "apps/u1/doc": magicBytes("pdf") }) });
    const { res } = await run(docRequest(), { env, rpc: () => jsonResponse({ r2_key: "apps/u1/doc", mime, original_name: "a<b>.x", kind }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), type);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("Content-Disposition"), disposition);
    if (csp) assert.equal(res.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
    else assert.equal(res.headers.get("Content-Security-Policy"), null);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });
}

test("legacy keys (applications/…) imported from D1 are servable", async () => {
  const key = "applications/QS-ABC123/bank-0-statement.pdf";
  const env = makeEnv({ DOCS: makeR2({ [key]: magicBytes("pdf") }) });
  const { res } = await run(docRequest(), { env, rpc: () => jsonResponse({ r2_key: key, mime: "application/pdf", kind: "bank" }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Disposition"), 'inline; filename="bank.pdf"');
});

test("a one-row array result from doc_access is read the same way", async () => {
  const env = makeEnv({ DOCS: makeR2({ "apps/u2/bank-1.pdf": magicBytes("pdf") }) });
  const { res } = await run(docRequest(), { env, rpc: () => jsonResponse([{ r2_key: "apps/u2/bank-1.pdf", mime: "application/pdf", kind: "bank" }]) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/pdf");
});

test("CORS preflight for /docs allows the Authorization header from an allowed origin", async () => {
  const req = new Request(`https://intake.example.workers.dev/docs/${DOC_ID}`, {
    method: "OPTIONS",
    headers: { Origin: "https://admin.quickserve.group", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" }
  });
  const res = await worker.fetch(req, makeEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://admin.quickserve.group");
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
});
