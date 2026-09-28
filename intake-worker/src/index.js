// QuickServe Cashloan — loan-application intake Worker v2 (Cloudflare)
//
// The public door of the credit desk. It receives applications from the apply
// form, checks every field and file, stores the documents privately in R2 and
// hands the details to Supabase (rpc/intake_submit), the system of record.
// Staff read documents back through GET /docs/:docId, which forwards their own
// Supabase login to rpc/doc_access (staff check + audit) before streaming.
//
// Routes
//   POST /applications                          public  submit (multipart/form-data)
//   GET  /docs/:docId                           staff   stream a document (Supabase login token)
//   POST /legacy/migrate                        owner   copy the old D1 inbox into Supabase (OWNER_TOKEN)
//   Legacy owner routes for the old inbox.html (OWNER_TOKEN) — retire together with D1:
//   GET  /applications[?status=new|approved|declined]
//   GET  /applications/:id
//   POST /applications/:id/status               { status, note }
//   GET  /applications/:id/file/:field[/:n]
//
// Bindings (wrangler.toml):  DB (D1, legacy only),  DOCS (R2)
// Vars:                      SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_ORIGINS (comma list, "*" allowed)
// Secrets:                   INTAKE_KEY, OWNER_TOKEN   (wrangler secret put …)
//
// Nothing here contains data or secrets. The Worker never holds a service-role
// key: it can only call the key-checked intake RPCs, or act as the signed-in
// staff member whose token it forwards.
//
// The free plan allows ~10 ms of CPU per request, so files are handed to R2 as
// Blobs (streamed, never copied or hashed in JS) and only their first 16 bytes
// are ever read.

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 10 * MB;                 // per document, mirrors the form's guard
const MAX_TOTAL_BYTES = 40 * MB;                // all documents together
const MAX_BODY_BYTES = MAX_TOTAL_BYTES + MB;    // + form fields and multipart overhead
const LEGACY_STATUSES = ["new", "approved", "declined"];
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const IMPORT_BATCH = 25;
const MAX_PRINCIPAL = 100000;                   // legal cap; the database also checks the live policy
const MAX_MONEY = 10000000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The only document types we accept or serve. Decided by magic bytes, never by
// the file name or the browser's claimed MIME type.
const TYPES = {
  "image/jpeg":      { ext: "jpg",  inline: true },
  "image/png":       { ext: "png",  inline: true },
  "image/webp":      { ext: "webp", inline: true },
  "application/pdf": { ext: "pdf",  inline: true },
  "image/heic":      { ext: "heic", inline: false }, // browsers can't show it: download
  "image/heif":      { ext: "heif", inline: false }  // served only (the database allows it)
};
const DOC_KINDS = ["id", "payslip", "bank", "proof_address", "other"];

// Upload slots on the form: field name → document kind and how many files.
const DOC_SLOTS = [
  { field: "docId",      kind: "id",            min: 1, max: 1 },
  { field: "docPayslip", kind: "payslip",       min: 1, max: 1 },
  { field: "docBank",    kind: "bank",          min: 1, max: 6 },
  { field: "docAddress", kind: "proof_address", min: 0, max: 1 }
];

// Form field → p_app key, check, required, max length (text only). Limits
// mirror the database's (intake_submit re-validates everything), so a bad value
// is named here, before any upload. Required = what both the old and the new
// form send.
const FIELDS = [
  ["fullName",          "full_name",           "name",    true],
  ["nationalId",        "national_id",         "idno",    true],
  ["dateOfBirth",       "date_of_birth",       "dob",     false],
  ["phone",             "phone",               "phone",   true],
  ["email",             "email",               "email",   false],
  ["address",           "address",             "text",    false, 300],
  ["town",              "town",                "text",    false, 80],
  ["dependants",        "dependants",          "count",   false],
  ["employer",          "employer",            "text",    true,  120],
  ["jobTitle",          "job_title",           "text",    false, 80],
  ["employmentType",    "employment_type",     "text",    false, 40],
  ["payDay",            "pay_day",             "text",    false, 40],
  ["bankName",          "bank_name",           "text",    false, 80],
  ["bankAccountHolder", "bank_account_holder", "text",    false, 120],
  ["bankAccountNo",     "bank_account_no",     "account", false],
  ["salaryIntoAccount", "salary_into_account", "yesno",   false],
  ["kinName",           "kin_name",            "text",    true,  120],
  ["kinRelationship",   "kin_relationship",    "text",    false, 60],
  ["kinPhone",          "kin_phone",           "phone",   true],
  ["amountRequested",   "amount_requested",    "amount",  false],
  ["repayDate",         "repay_date",          "date",    true],
  ["purpose",           "purpose",             "text",    true,  300],
  ["declaredIncome",    "declared_income",     "money",   false],
  ["declaredDeductions","declared_deductions", "money",   false],
  ["declaredExpenses",  "declared_expenses",   "money",   false],
  ["otherLenderLoans",  "other_lender_loans",  "yesno",   false],
  ["otherLenderCount",  "other_lender_count",  "count",   false],
  ["consentBureau",     "consent_bureau",      "yesno",   false],
  ["consentVersion",    "consent_version",     "text",    false, 40]
];

// D1 columns handed to intake_import_legacy (raw document keys become `docs`).
const LEGACY_COLUMNS = ["id", "created_at", "status", "full_name", "phone", "national_id", "address",
  "employer", "income", "kin_name", "kin_phone", "purpose", "repay_date", "consent",
  "decided_at", "decided_note"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const c = { env, ...corsFor(request, env) };

    // A browser on a site we don't know gets nothing, not even a submission.
    if (!c.allowed) return json({ error: "forbidden" }, 403, c);
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: c.cors });

    try {
      if (method === "POST" && path === "/applications") return await submit(request, c);

      const doc = path.match(/^\/docs\/([^/]+)$/);
      if (doc && method === "GET") return await getDoc(request, doc[1], c);

      if (method === "POST" && path === "/legacy/migrate") return await legacyMigrate(request, c);

      // Legacy: everything else under /applications is owner-only (old inbox).
      if (path === "/applications" || path.startsWith("/applications/")) {
        if (!ownerOk(request, env)) return json({ error: "unauthorized" }, 401, c);

        if (method === "GET" && path === "/applications") return await listApplications(request, c);

        const m = path.match(/^\/applications\/([A-Za-z0-9-]+)(?:\/(status|file))?(?:\/([a-z]+))?(?:\/(\d+))?$/);
        if (m) {
          const [, id, action, field, n] = m;
          if (!action && method === "GET") return await getApplication(id, c);
          if (action === "status" && method === "POST") return await setStatus(id, request, c);
          if (action === "file" && method === "GET") return await getFile(id, field, n, c);
        }
      }

      return json({ error: "not_found" }, 404, c);
    } catch {
      // Never echo internal messages to the caller.
      return json({ error: "server_error" }, 500, c);
    }
  }
};

// ── helpers ─────────────────────────────────────────────────────────────────

// ALLOWED_ORIGINS (comma list, "*" = any); falls back to the old ALLOWED_ORIGIN.
// Unset → no browser origin is allowed (server-to-server calls still work).
function corsFor(request, env) {
  const raw = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "");
  const list = raw.split(",").map((s) => s.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  const origin = request.headers.get("Origin");
  const base = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (!origin) return { allowed: true, cors: base };
  if (list.includes("*") || list.includes(origin.toLowerCase())) {
    return { allowed: true, cors: { ...base, "Access-Control-Allow-Origin": origin } };
  }
  return { allowed: false, cors: { "Vary": "Origin" } };
}

function json(obj, status, c, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...c.cors,
      ...extra
    }
  });
}

// Human-friendly, unambiguous reference (no 0/O/1/I) — only used for the honeypot.
function fakeRef() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return "QSA-" + s;
}

// Constant-time-ish bearer-token check against the OWNER_TOKEN secret.
function ownerOk(request, env) {
  const token = bearer(request);
  const expected = env.OWNER_TOKEN || "";
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

// Magic-byte sniffing of the first 16 bytes. Returns a TYPES key or null.
function sniff(b) {
  const at = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (b.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (b.length >= 5 && at(0, "%PDF-")) return "application/pdf";
  if (b.length >= 12 && at(4, "ftyp") && ["heic", "heix", "mif1", "msf1", "hevc"].some((t) => at(8, t))) return "image/heic";
  return null;
}

async function head16(blobOrObject) {
  return new Uint8Array(await blobOrObject.arrayBuffer()).subarray(0, 16);
}

// Response headers for serving a stored document. Unknown types download as bytes.
function docHeaders(mime, kind) {
  const t = TYPES[mime];
  const type = t ? mime : "application/octet-stream";
  const name = (DOC_KINDS.includes(kind) ? kind : "document") + "." + (t ? t.ext : "bin");
  const headers = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${t && t.inline ? "inline" : "attachment"}; filename="${name}"`
  };
  if (type.startsWith("image/")) headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
  return headers;
}

// The Worker must only ever carry the public (publishable/anon) key.
function looksSecret(key) {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload && payload.role === "service_role";
  } catch { return false; }
}

function supabaseReady(env) {
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || "");
  return /^https:\/\/[^/\s]+/.test(String(env.SUPABASE_URL || "")) && !!key && !looksSecret(key);
}

// POST /rest/v1/rpc/<name>. Anonymous calls carry the publishable key as the
// bearer; staff calls forward the caller's own Supabase access token.
function rpc(env, name, params, userToken) {
  const base = String(env.SUPABASE_URL).replace(/\/+$/, "");
  return fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_PUBLISHABLE_KEY,
      "Authorization": `Bearer ${userToken || env.SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(params)
  });
}

// An RPC's jsonb result (a one-row array is accepted too). null when unreadable.
async function rpcResult(res) {
  const out = await res.json().catch(() => null);
  return Array.isArray(out) ? out[0] || null : out;
}

// "QS_RATE_LIMIT: …" → { code: "QS_RATE_LIMIT", message }. The message stays
// inside the Worker; only the code and known field names are ever used.
async function rpcError(res) {
  try {
    const body = await res.json();
    const message = String((body && body.message) || "");
    const m = /^(QS_[A-Z_]+)\b/.exec(message);
    return { code: m ? m[1] : "", message };
  } catch { return { code: "", message: "" }; }
}

async function rpcCode(res) {
  return (await rpcError(res)).code;
}

// intake_submit's "QS_INVALID: Check these fields: amount_requested, phone."
// → the form's names (["amountRequested", "phone"]). Unknown keys are dropped.
const FORM_NAME = Object.fromEntries(FIELDS.map(([form, key]) => [key, form])
  .concat([["consent_processing", "consentProcessing"], ["documents", "documents"]]));
function formFields(message) {
  const m = /^QS_INVALID: Check these fields: ([a-z0-9_, ]+)\.$/.exec(message);
  return m ? unique(m[1].split(",").map((k) => FORM_NAME[k.trim()]).filter(Boolean)) : [];
}

// hex(HMAC-SHA256(INTAKE_KEY, ip)) — lets the database rate-limit per sender
// without ever storing an IP address.
async function ipHash(secret, ip) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ip || "unknown")));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

// One rpc/intake_submit call, sorted by what it means for the uploaded files:
//   ok       stored (2xx);
//   refused  a 4xx: PostgREST turned the call down and rolled it back, so
//            nothing was stored (QS_INVALID, QS_RATE_LIMIT, a bad key, …);
//   unclear  no answer, a 5xx (gateway or database), 408 (the request may not
//            have arrived whole) or 409 (it clashes with a row that exists).
async function submitOnce(env, params) {
  let res;
  try {
    res = await rpc(env, "intake_submit", params);
  } catch {
    return { unclear: true };
  }
  if (res.ok) return { ok: true, res };
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 409) return { refused: true, res };
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
  return { unclear: true };
}

async function removeKeys(env, keys) {
  if (!keys.length) return;
  try { await env.DOCS.delete(keys); } catch { /* best effort; the upload id is random */ }
}

// ── field parsing ───────────────────────────────────────────────────────────

// Text value of a form field: "" when absent, null when it isn't text at all.
function formText(form, name) {
  const v = form.get(name);
  if (v == null) return "";
  if (typeof v !== "string") return null;
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

// "18,400" / "18 400" / "N$18400.50" → number. A comma is only accepted as a
// thousands separator ("18400,50" is refused rather than misread).
function parseMoney(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/^N\$/i, "").replace(/\s+/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, "");
  return /^\d{1,9}(\.\d{1,2})?$/.test(s) ? Number(s) : null;
}

// "Today" is Windhoek's date (UTC+2, no DST), as in the database.
function todayWindhoek() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const ok = y >= 1900 && y <= 2100 && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return ok ? raw : null;
}

// Returns the parsed value, or undefined when the value is not acceptable.
function parseValue(type, raw, max) {
  switch (type) {
    case "text": return raw.length <= max ? raw : undefined;
    case "name": return raw.length >= 2 && raw.length <= 120 ? raw : undefined;
    case "idno": {
      const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return raw.length <= 30 && norm.length >= 4 && norm.length <= 20 ? raw : undefined;
    }
    case "phone": {
      const digits = raw.replace(/\D/g, "").length;
      return /^\+?[0-9 ()-]{7,24}$/.test(raw) && digits >= 7 && digits <= 15 ? raw : undefined;
    }
    case "email":
      return raw.length <= 120 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(raw) ? raw : undefined;
    case "account": return /^[A-Za-z0-9 -]{4,30}$/.test(raw) ? raw : undefined;
    case "date": return parseDate(raw) || undefined;
    case "dob": { const d = parseDate(raw); return d && d <= todayWindhoek() ? d : undefined; }
    case "count": return /^\d{1,2}$/.test(raw) && Number(raw) <= 50 ? Number(raw) : undefined;
    case "money": { const n = parseMoney(raw); return n == null || n > MAX_MONEY ? undefined : n; }
    case "amount": { const n = parseMoney(raw); return n == null || n <= 0 || n > MAX_PRINCIPAL ? undefined : n; }
    case "yesno": {
      const v = raw.toLowerCase();
      return v === "yes" ? true : v === "no" ? false : undefined;
    }
    default: return undefined;
  }
}

// Form → p_app (contract §8). Returns { app, fields } where fields lists the
// form names that are missing or invalid.
function readApplication(form) {
  const app = {};
  const fields = [];
  for (const [name, key, type, required, max] of FIELDS) {
    const raw = formText(form, name);
    app[key] = null;
    if (raw === null) { fields.push(name); continue; }
    if (!raw) { if (required) fields.push(name); continue; }
    const value = parseValue(type, raw, max);
    if (value === undefined) fields.push(name);
    else app[key] = value;
  }
  app.consent_bureau = app.consent_bureau === true;

  // Processing consent must be an explicit yes (new form: consentProcessing,
  // old form: consent — whose wording the database calls "legacy-v0").
  const cp = formText(form, "consentProcessing");
  const legacy = formText(form, "consent");
  if (cp) { if (cp.toLowerCase() !== "yes") fields.push("consentProcessing"); }
  else if (legacy) {
    if (legacy.toLowerCase() !== "yes") fields.push("consent");
    else if (app.consent_version === null) app.consent_version = "legacy-v0";
  }
  else fields.push("consentProcessing");
  app.consent_processing = true;

  // Old form: free-text "income" becomes declared_income when it is a number.
  if (app.declared_income === null) {
    const income = formText(form, "income");
    if (income) {
      const n = parseMoney(income);
      if (n !== null) app.declared_income = n;
      else app.declared = { income_text: income.slice(0, 120) };
    }
  }
  return { app, fields };
}

// Files posted under one slot. Empty file inputs arrive as "" or 0-byte files.
function slotFiles(form, name) {
  const files = [];
  let bad = false;
  for (const v of form.getAll(name)) {
    if (typeof v === "string") { if (v !== "") bad = true; continue; }
    if (!v || typeof v.slice !== "function" || typeof v.size !== "number") { bad = true; continue; }
    if (v.size > 0) files.push(v);
  }
  return { files, bad };
}

function originalName(name) {
  const s = String(name || "").replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim();
  return s ? s.slice(-120) : null;
}

const unique = (a) => [...new Set(a)];

// ── public: submit ──────────────────────────────────────────────────────────

async function submit(request, c) {
  const env = c.env;
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
    return json({ error: "too_large", fields: ["documents"] }, 413, c);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid" }, 400, c);
  }

  // Honeypot: people never see "website"; bots fill it. Pretend, store nothing.
  const trap = form.get("website");
  if (trap != null && (typeof trap !== "string" || trap.trim() !== "")) {
    return json({ ok: true, reference: fakeRef() }, 201, c);
  }

  // 1. Every field and file is checked before anything is written.
  const { app, fields } = readApplication(form);
  const docs = [];
  for (const slot of DOC_SLOTS) {
    const { files, bad } = slotFiles(form, slot.field);
    if (bad || files.length < slot.min || files.length > slot.max) { fields.push(slot.field); continue; }
    files.forEach((file, i) => docs.push({ slot, seq: i + 1, file }));
  }
  if (fields.length) return json({ error: "invalid", fields: unique(fields) }, 400, c);

  const big = unique(docs.filter((d) => d.file.size > MAX_FILE_BYTES).map((d) => d.slot.field));
  if (big.length) return json({ error: "too_large", fields: big }, 413, c);
  if (docs.reduce((sum, d) => sum + d.file.size, 0) > MAX_TOTAL_BYTES) {
    return json({ error: "too_large", fields: ["documents"] }, 413, c);
  }

  const wrongType = [];
  for (const d of docs) {
    d.mime = sniff(await head16(d.file.slice(0, 16)));
    if (!d.mime) wrongType.push(d.slot.field);
  }
  if (wrongType.length) return json({ error: "unsupported_type", fields: unique(wrongType) }, 415, c);

  if (!supabaseReady(env) || !env.INTAKE_KEY || !env.DOCS) return json({ error: "server_error" }, 500, c);
  app.ip_hash = await ipHash(env.INTAKE_KEY, request.headers.get("CF-Connecting-IP"));

  // 2. Store the documents under a fresh, unguessable upload id.
  const uploadId = crypto.randomUUID();
  for (const d of docs) d.key = `apps/${uploadId}/${d.slot.kind}-${d.seq}.${TYPES[d.mime].ext}`;
  const keys = docs.map((d) => d.key);
  const p_docs = docs.map((d) => ({
    kind: d.slot.kind,
    seq: d.seq,
    r2_key: d.key,
    mime: d.mime,
    bytes: d.file.size,
    original_name: originalName(d.file.name)
  }));

  try {
    // Blobs go to R2 as-is (streamed). Wait for every put before judging, so
    // a late put can't land after the clean-up.
    const puts = await Promise.allSettled(docs.map((d) =>
      env.DOCS.put(d.key, d.file, { httpMetadata: { contentType: d.mime } })));
    if (puts.some((p) => p.status !== "fulfilled")) throw new Error("upload failed");
  } catch {
    await removeKeys(env, keys);
    return json({ error: "server_error" }, 500, c);
  }

  // 3. Record the application in Supabase. If we can't tell whether that
  //    worked (the connection dropped, a gateway timed out, a 5xx that may
  //    have come after the commit), ask once more: intake_submit answers a
  //    repeat of the same upload folder with the application it stored.
  const params = { p_key: env.INTAKE_KEY, p_app: app, p_docs };
  let sent = await submitOnce(env, params);
  if (sent.unclear) sent = await submitOnce(env, params);
  if (sent.unclear) {
    // Maybe stored, maybe not. Deleting now could leave a stored application
    // pointing at nothing, so the files stay; the keys (no personal data)
    // go to the Worker log for a later check against the database.
    console.error(JSON.stringify({ event: "intake_unclear", keys }));
    return json({ error: "server_error" }, 500, c);
  }

  if (sent.refused) {
    // Turned down and rolled back: nothing points at the files.
    const { code, message } = await rpcError(sent.res);
    await removeKeys(env, keys);
    if (code === "QS_RATE_LIMIT") return json({ error: "rate_limited" }, 429, c, { "Retry-After": "3600" });
    if (code === "QS_INVALID") {
      const named = formFields(message);
      return json(named.length ? { error: "invalid", fields: named } : { error: "invalid" }, 400, c);
    }
    return json({ error: "server_error" }, 500, c);
  }

  // Stored: from here on the files belong to the application, never delete.
  const out = await rpcResult(sent.res);
  const reference = out && typeof out.ref === "string" ? out.ref : null;
  return json({ ok: true, reference }, 201, c);
}

// ── staff: documents ────────────────────────────────────────────────────────

async function getDoc(request, docId, c) {
  const env = c.env;
  const token = bearer(request);
  if (!token || token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    return json({ error: "unauthorized" }, 401, c);
  }
  if (!UUID_RE.test(docId)) return json({ error: "not_found" }, 404, c);
  if (!supabaseReady(env) || !env.DOCS) return json({ error: "server_error" }, 500, c);

  // Supabase decides (staff only) and audits the view.
  const res = await rpc(env, "doc_access", { p_doc_id: docId }, token);
  if (!res.ok) {
    const code = await rpcCode(res);
    if (res.status === 401) return json({ error: "unauthorized" }, 401, c);
    if (res.status === 403 || code === "QS_FORBIDDEN") return json({ error: "forbidden" }, 403, c);
    if (res.status === 404 || code === "QS_NOT_FOUND") return json({ error: "not_found" }, 404, c);
    return json({ error: "server_error" }, 500, c);
  }
  const info = await rpcResult(res);
  const key = info && typeof info.r2_key === "string" ? info.r2_key : "";
  if (!/^(apps|applications)\/[\x21-\x7e]+$/.test(key) || key.includes("..")) {
    return json({ error: "not_found" }, 404, c);
  }

  const object = await env.DOCS.get(key);
  if (!object) return json({ error: "not_found" }, 404, c);
  return new Response(object.body, { status: 200, headers: { ...c.cors, ...docHeaders(info.mime, info.kind) } });
}

// ── owner: one-off import of the old D1 inbox ───────────────────────────────

async function legacyMigrate(request, c) {
  const env = c.env;
  if (!ownerOk(request, env)) return json({ error: "unauthorized" }, 401, c);
  if (!supabaseReady(env) || !env.INTAKE_KEY || !env.DB || !env.DOCS) return json({ error: "server_error" }, 500, c);

  const { results } = await env.DB.prepare(`SELECT * FROM applications ORDER BY created_at ASC, id ASC`).all();
  const rows = results || [];
  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
    const batch = await Promise.all(rows.slice(i, i + IMPORT_BATCH).map((row) => legacyRow(row, env)));
    // The database skips references it already has, so re-running is safe.
    const res = await rpc(env, "intake_import_legacy", { p_key: env.INTAKE_KEY, p_rows: batch });
    if (!res.ok) return json({ error: "server_error", imported, skipped }, 500, c);
    const out = (await rpcResult(res)) || {};
    imported += Number(out.imported) || 0;
    skipped += Number(out.skipped) || 0;
  }
  return json({ imported, skipped }, 200, c);
}

// One D1 row → an import row: the D1 columns as-is, plus `ref` and the
// documents re-typed by sniffing the first 16 bytes of each R2 object.
async function legacyRow(row, env) {
  const out = {};
  for (const col of LEGACY_COLUMNS) out[col] = row[col] == null ? null : row[col];
  out.ref = row.id;
  out.consent_processing = row.consent === "yes";
  const income = parseMoney(row.income);
  out.declared_income = income;

  const refs = [];
  if (row.doc_id_key) refs.push(["id", 1, row.doc_id_key]);
  if (row.doc_payslip_key) refs.push(["payslip", 1, row.doc_payslip_key]);
  safeParse(row.doc_bank_keys).forEach((key, i) => {
    if (typeof key === "string" && key) refs.push(["bank", i + 1, key]);
  });

  out.docs = [];
  out.docs_skipped = [];
  for (const [kind, seq, key] of refs) {
    let object = null;
    try { object = await env.DOCS.get(key, { range: { offset: 0, length: 16 } }); } catch { object = null; }
    if (!object) { out.docs_skipped.push({ kind, seq, reason: "missing" }); continue; }
    const mime = sniff(await head16(object));
    // Anything that isn't a real image/PDF (e.g. an uploaded web page) stays out.
    if (!mime) { out.docs_skipped.push({ kind, seq, reason: "unsupported_type" }); continue; }
    const base = String(key).split("/").pop().replace(/^(?:id|payslip|bank-\d+)-/, "");
    out.docs.push({ kind, seq, r2_key: key, mime, bytes: object.size, original_name: originalName(base) });
  }
  return out;
}

// ── legacy owner routes (old inbox.html, D1) ────────────────────────────────

async function listApplications(request, c) {
  const status = new URL(request.url).searchParams.get("status");
  let sql = `SELECT id, created_at, status, full_name, phone, national_id, employer, purpose, repay_date
             FROM applications`;
  const binds = [];
  if (status && LEGACY_STATUSES.includes(status)) { sql += ` WHERE status = ?`; binds.push(status); }
  sql += ` ORDER BY created_at DESC LIMIT 300`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return json({ applications: results }, 200, c);
}

async function getApplication(id, c) {
  const row = await c.env.DB.prepare(`SELECT * FROM applications WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "not_found" }, 404, c);
  row.doc_bank_count = safeParse(row.doc_bank_keys).length;
  delete row.doc_id_key;      // don't leak raw R2 keys to the client
  delete row.doc_payslip_key;
  delete row.doc_bank_keys;
  return json({ application: row }, 200, c);
}

async function setStatus(id, request, c) {
  const body = await request.json().catch(() => ({}));
  if (!LEGACY_STATUSES.includes(body.status)) return json({ error: "bad status" }, 400, c);
  const res = await c.env.DB.prepare(
    `UPDATE applications SET status = ?, decided_at = ?, decided_note = ? WHERE id = ?`
  ).bind(body.status, new Date().toISOString(), (body.note || "").toString().slice(0, 500), id).run();
  if (!res.meta.changes) return json({ error: "not_found" }, 404, c);
  return json({ ok: true }, 200, c);
}

// Old uploads were stored with whatever type the browser claimed, so the type
// is re-decided from the file's own first bytes and served with safe headers.
async function getFile(id, field, n, c) {
  const env = c.env;
  const row = await env.DB.prepare(
    `SELECT doc_id_key, doc_bank_keys, doc_payslip_key FROM applications WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ error: "not_found" }, 404, c);

  let key = null;
  if (field === "id") key = row.doc_id_key;
  else if (field === "payslip") key = row.doc_payslip_key;
  else if (field === "bank") key = safeParse(row.doc_bank_keys)[Number(n || 0)];
  if (!key || typeof key !== "string") return json({ error: "not_found" }, 404, c);

  const first = await env.DOCS.get(key, { range: { offset: 0, length: 16 } });
  if (!first) return json({ error: "not_found" }, 404, c);
  const mime = sniff(await head16(first));

  const object = await env.DOCS.get(key);
  if (!object) return json({ error: "not_found" }, 404, c);
  return new Response(object.body, { status: 200, headers: { ...c.cors, ...docHeaders(mime, field) } });
}
