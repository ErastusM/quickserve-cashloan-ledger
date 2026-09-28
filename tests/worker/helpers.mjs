// Test doubles for the intake Worker: in-memory R2 and D1, a recording fetch
// stub for Supabase, and file fixtures with real magic bytes.

import worker from "../../intake-worker/src/index.js";

export { worker };

export const ORIGIN = "https://erastusm.github.io";
export const SB_URL = "https://sb.example.supabase.co";
export const PUB_KEY = "sb_publishable_test_key";
export const INTAKE_KEY = "intake-key-for-tests-0123456789";
export const OWNER_TOKEN = "owner-token-for-tests-abcdef";
export const DOC_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

// ── R2 ──────────────────────────────────────────────────────────────────────
export function makeR2(initial = {}) {
  const store = new Map();
  for (const [key, bytes] of Object.entries(initial)) store.set(key, { bytes: toBytes(bytes), httpMetadata: {} });
  const log = { puts: [], gets: [], deletes: [] };
  const r2 = {
    store,
    log,
    failPut: null, // (key) => boolean
    async put(key, value, opts = {}) {
      log.puts.push({ key, bodyType: value && value.constructor ? value.constructor.name : typeof value, opts });
      if (r2.failPut && r2.failPut(key)) throw new Error("R2 exploded: secret internal detail");
      let bytes;
      if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
      else bytes = toBytes(value);
      store.set(key, { bytes, httpMetadata: opts.httpMetadata || {} });
      return { key, size: bytes.length };
    },
    async get(key, opts = {}) {
      log.gets.push({ key, range: opts.range || null });
      const o = store.get(key);
      if (!o) return null;
      let bytes = o.bytes;
      if (opts.range) {
        const { offset = 0, length } = opts.range;
        bytes = bytes.slice(offset, length == null ? undefined : offset + length);
      }
      return objectBody(key, o, bytes);
    },
    async head(key) {
      const o = store.get(key);
      return o ? { key, size: o.bytes.length, httpMetadata: o.httpMetadata } : null;
    },
    async delete(keys) {
      for (const k of [].concat(keys)) { log.deletes.push(k); store.delete(k); }
    }
  };
  return r2;
}

function objectBody(key, o, bytes) {
  return {
    key,
    size: o.bytes.length,
    httpMetadata: o.httpMetadata,
    get body() { return new Blob([bytes]).stream(); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async text() { return new TextDecoder().decode(bytes); }
  };
}

export function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  if (typeof v === "string") return new TextEncoder().encode(v);
  throw new TypeError("unsupported body in test R2");
}

// ── D1 (just enough SQL for the Worker's statements) ────────────────────────
export function makeD1(rows = []) {
  const data = rows.map((r) => ({ ...r }));
  const log = [];
  function exec(sql, binds) {
    const s = sql.replace(/\s+/g, " ").trim();
    log.push({ sql: s, binds });
    if (/^UPDATE applications SET status = \?, decided_at = \?, decided_note = \? WHERE id = \?$/.test(s)) {
      const row = data.find((r) => r.id === binds[3]);
      if (row) Object.assign(row, { status: binds[0], decided_at: binds[1], decided_note: binds[2] });
      return { rows: [], changes: row ? 1 : 0 };
    }
    const m = /^SELECT (.+?) FROM applications(?: WHERE (id|status) = \?)?(?: ORDER BY created_at (ASC|DESC)(?:, id ASC)?)?(?: LIMIT (\d+))?$/.exec(s);
    if (!m) throw new Error("test D1: unsupported SQL: " + s);
    const [, cols, whereCol, order, limit] = m;
    let out = data.filter((r) => !whereCol || r[whereCol] === binds[0]);
    if (order) out = out.slice().sort((a, b) => (order === "ASC" ? 1 : -1) * String(a.created_at).localeCompare(String(b.created_at)));
    if (limit) out = out.slice(0, Number(limit));
    const pick = cols.trim() === "*" ? null : cols.split(",").map((x) => x.trim());
    return { rows: out.map((r) => (pick ? Object.fromEntries(pick.map((k) => [k, r[k] ?? null])) : { ...r })), changes: 0 };
  }
  return {
    rows: data,
    log,
    prepare(sql) {
      let binds = [];
      const stmt = {
        bind(...b) { binds = b; return stmt; },
        async all() { return { results: exec(sql, binds).rows, success: true }; },
        async first() { return exec(sql, binds).rows[0] || null; },
        async run() { return { success: true, meta: { changes: exec(sql, binds).changes } }; }
      };
      return stmt;
    }
  };
}

// ── env ─────────────────────────────────────────────────────────────────────
export function makeEnv(extra = {}) {
  return {
    SUPABASE_URL: SB_URL,
    SUPABASE_PUBLISHABLE_KEY: PUB_KEY,
    ALLOWED_ORIGINS: "https://erastusm.github.io, https://admin.quickserve.group",
    INTAKE_KEY,
    OWNER_TOKEN,
    DOCS: makeR2(),
    DB: makeD1(),
    ...extra
  };
}

// ── fetch stub (records every Supabase call) ────────────────────────────────
export function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}));
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, method: init.method || "GET", headers, body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// PostgREST's shape for `raise exception using errcode = 'P0001'`.
export function pgError(message, status = 400) {
  return jsonResponse({ code: "P0001", details: null, hint: null, message }, status);
}

// ── files with real magic bytes ─────────────────────────────────────────────
const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  webp: [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x24, 0, 0, 0], [..."WEBPVP8 "].map((c) => c.charCodeAt(0))),
  pdf: [..."%PDF-1.7\n%\xe2\xe3"].map((c) => c.charCodeAt(0) & 0xff),
  heic: [0, 0, 0, 0x18].concat([..."ftypheic"].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]),
  heix: [0, 0, 0, 0x18].concat([..."ftypheix"].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]),
  mif1: [0, 0, 0, 0x1c].concat([..."ftypmif1"].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]),
  html: [..."<!doctype html><script>alert(document.cookie)</script>"].map((c) => c.charCodeAt(0)),
  svg: [..."<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"].map((c) => c.charCodeAt(0)),
  gif: [..."GIF89a"].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0, 0, 0, 0])
};

export function magicBytes(type, size = 64) {
  const head = MAGIC[type];
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head, 0);
  return out;
}

// A File whose bytes are `type` but whose name/claimed MIME can lie.
export function fileOf(type, name, { size = 64, claimed } = {}) {
  return new File([magicBytes(type, size)], name, { type: claimed || "application/octet-stream" });
}

export const VALID_FIELDS = {
  fullName: "Selma Nangolo",
  nationalId: "89031200457",
  dateOfBirth: "1989-03-12",
  phone: "+264 81 234 5678",
  email: "selma@example.com",
  address: "14 Moses Garoeb St, Mondesa",
  town: "Swakopmund",
  dependants: "2",
  employer: "Rössing Uranium",
  jobTitle: "Plant operator",
  employmentType: "Permanent",
  payDay: "25th",
  bankName: "FNB Namibia",
  bankAccountHolder: "Selma Nangolo",
  bankAccountNo: "62 1044 4471",
  salaryIntoAccount: "yes",
  kinName: "Martha Nangolo",
  kinRelationship: "Mother",
  kinPhone: "+264 85 612 3390",
  amountRequested: "4000",
  repayDate: "2026-10-28",
  purpose: "School fees",
  declaredIncome: "18,400",
  declaredDeductions: "1500",
  declaredExpenses: "9000.50",
  otherLenderLoans: "yes",
  otherLenderCount: "1",
  consentProcessing: "yes",
  consentBureau: "yes",
  consentVersion: "2026-09",
  website: ""
};

export function validFiles() {
  return {
    docId: [fileOf("jpeg", "id-front.jpg", { claimed: "image/jpeg" })],
    docPayslip: [fileOf("pdf", "payslip-aug.pdf", { claimed: "application/pdf" })],
    docBank: [
      fileOf("pdf", "bank-jun.pdf", { claimed: "application/pdf" }),
      fileOf("png", "bank-jul.png", { claimed: "image/png" }),
      fileOf("webp", "bank-aug.webp", { claimed: "image/webp" })
    ],
    docAddress: [fileOf("heic", "IMG_0042.HEIC", { claimed: "image/heic" })]
  };
}

// Build a multipart form. `fields` values of undefined are left out.
export function buildForm(fields = {}, files = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...VALID_FIELDS, ...fields })) if (v !== undefined) fd.append(k, v);
  for (const [k, list] of Object.entries({ ...validFiles(), ...files })) {
    for (const f of [].concat(list || [])) fd.append(k, f);
  }
  return fd;
}

export function submitRequest(fd, { origin = ORIGIN, ip = "203.0.113.7", headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (ip) h["CF-Connecting-IP"] = ip;
  return new Request("https://intake.example.workers.dev/applications", { method: "POST", body: fd, headers: h });
}

export function totalDocsWritten(env) {
  return env.DOCS.log.puts.length;
}
