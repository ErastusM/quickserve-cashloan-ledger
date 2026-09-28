// CORS: ALLOWED_ORIGINS allowlist (echo), "*", fallback to ALLOWED_ORIGIN,
// and refusal of browsers on other sites.

import test from "node:test";
import assert from "node:assert/strict";
import { worker, makeEnv, stubFetch, jsonResponse, buildForm, submitRequest } from "./helpers.mjs";

function preflight(origin, env) {
  const req = new Request("https://intake.example.workers.dev/applications", {
    method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
  });
  return worker.fetch(req, env);
}

async function submitFrom(origin, env) {
  const stub = stubFetch(() => jsonResponse({ id: "x", ref: "QSA-AAAAAA" }));
  try {
    const res = await worker.fetch(submitRequest(buildForm(), { origin }), env);
    return { res, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

test("allowed origins are echoed back exactly, with Vary: Origin", async () => {
  const env = makeEnv({ ALLOWED_ORIGINS: "https://erastusm.github.io,https://quickserve.group,https://apply.quickserve.group,https://admin.quickserve.group" });
  for (const origin of ["https://erastusm.github.io", "https://apply.quickserve.group", "https://admin.quickserve.group"]) {
    const res = await preflight(origin, env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET,POST,OPTIONS");
    assert.equal(res.headers.get("Access-Control-Allow-Headers"), "Authorization,Content-Type");
    assert.match(res.headers.get("Vary"), /Origin/);
  }
  const { res } = await submitFrom("https://apply.quickserve.group", env);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://apply.quickserve.group");
});

test("other origins get no CORS grant and nothing is processed", async () => {
  const env = makeEnv();
  for (const origin of ["https://evil.example", "https://erastusm.github.io.evil.example", "null", "http://erastusm.github.io"]) {
    const pre = await preflight(origin, env);
    assert.equal(pre.status, 403, origin);
    assert.equal(pre.headers.get("Access-Control-Allow-Origin"), null);

    const { res, calls } = await submitFrom(origin, env);
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(calls.length, 0);
  }
  assert.equal(env.DOCS.log.puts.length, 0);
});

test("no Origin header (server-to-server, curl) is not a browser: allowed, no ACAO", async () => {
  const env = makeEnv();
  const { res } = await submitFrom(null, env);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test('"*" in ALLOWED_ORIGINS allows any origin (echoed)', async () => {
  const env = makeEnv({ ALLOWED_ORIGINS: "*" });
  const res = await preflight("https://anything.example", env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://anything.example");
});

test("falls back to the old ALLOWED_ORIGIN var; neither set → no browser origin allowed", async () => {
  const old = makeEnv({ ALLOWED_ORIGINS: undefined, ALLOWED_ORIGIN: "https://erastusm.github.io" });
  assert.equal((await preflight("https://erastusm.github.io", old)).headers.get("Access-Control-Allow-Origin"), "https://erastusm.github.io");
  assert.equal((await preflight("https://admin.quickserve.group", old)).status, 403);

  const none = makeEnv({ ALLOWED_ORIGINS: undefined, ALLOWED_ORIGIN: undefined });
  assert.equal((await preflight("https://erastusm.github.io", none)).status, 403);
});

test("list entries are trimmed and trailing slashes ignored", async () => {
  const env = makeEnv({ ALLOWED_ORIGINS: " https://a.example/ ,  https://B.example " });
  assert.equal((await preflight("https://a.example", env)).status, 204);
  assert.equal((await preflight("https://b.example", env)).status, 204);
});

test("unknown routes → 404 JSON with CORS", async () => {
  const req = new Request("https://intake.example.workers.dev/nope", { headers: { Origin: "https://erastusm.github.io" } });
  const res = await worker.fetch(req, makeEnv());
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://erastusm.github.io");
});
