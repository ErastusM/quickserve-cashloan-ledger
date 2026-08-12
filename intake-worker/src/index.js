// QuickServe Cashloan — loan-application intake Worker (Cloudflare)
//
// A small, single-owner backend for the WhatsApp intake flow. It receives loan
// applications from the public apply form, stores the applicant's documents in
// R2 and the structured details in D1, and lets the owner review, approve or
// decline them from inbox.html.
//
// Routes
//   POST /applications                          public  submit (multipart/form-data)
//   GET  /applications[?status=new|approved|declined]   owner   list
//   GET  /applications/:id                      owner   one application (full)
//   POST /applications/:id/status               owner   { status, note }
//   GET  /applications/:id/file/:field[/:n]     owner   stream a document from R2
//
// Bindings (wrangler.toml):  DB (D1),  DOCS (R2)
// Secret:                    OWNER_TOKEN   (wrangler secret put OWNER_TOKEN)
// Var:                       ALLOWED_ORIGIN (your apply/inbox origin, for CORS)
//
// Nothing here contains data or secrets — those live in Cloudflare, not the repo.

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB, mirrors the form's client-side guard
const STATUSES = ["new", "approved", "declined"];

function cors(env, extra = {}) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    ...extra
  };
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...cors(env) }
  });
}

// Human-friendly, unambiguous reference (no 0/O/1/I).
function makeRef() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return "QS-" + s;
}

// Constant-time-ish bearer-token check against the OWNER_TOKEN secret.
function ownerOk(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env.OWNER_TOKEN || "";
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { headers: cors(env) });

    try {
      // Public: submit an application.
      if (method === "POST" && path === "/applications") return submit(request, env);

      // Everything else under /applications is owner-only.
      if (path === "/applications" || path.startsWith("/applications/")) {
        if (!ownerOk(request, env)) return json({ error: "unauthorized" }, 401, env);

        if (method === "GET" && path === "/applications") return listApplications(request, env);

        const m = path.match(/^\/applications\/([A-Za-z0-9-]+)(?:\/(status|file))?(?:\/([a-z]+))?(?:\/(\d+))?$/);
        if (m) {
          const [, id, action, field, n] = m;
          if (!action && method === "GET") return getApplication(id, env);
          if (action === "status" && method === "POST") return setStatus(id, request, env);
          if (action === "file" && method === "GET") return getFile(id, field, n, env);
        }
      }

      return json({ error: "not found" }, 404, env);
    } catch (err) {
      return json({ error: "server error", detail: String((err && err.message) || err) }, 500, env);
    }
  }
};

async function submit(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "expected multipart form data" }, 400, env);
  }

  const field = (k) => (form.get(k) || "").toString().trim();
  const required = ["fullName", "phone", "nationalId", "employer", "kinName", "kinPhone", "purpose", "repayDate"];
  const missing = required.filter((k) => !field(k));
  if (missing.length) return json({ error: "missing required fields", fields: missing }, 400, env);
  if (field("consent") !== "yes") return json({ error: "consent required" }, 400, env);

  const id = makeRef();
  const now = new Date().toISOString();

  async function store(name, file, index) {
    if (!file || typeof file.arrayBuffer !== "function") return null;
    if (file.size > MAX_FILE_BYTES) throw new Error(`${name} file too large`);
    const safeName = (file.name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const key = `applications/${id}/${name}${index != null ? "-" + index : ""}-${safeName}`;
    await env.DOCS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" }
    });
    return key;
  }

  const docIdKey = await store("id", form.get("docId"));
  const payslipKey = await store("payslip", form.get("docPayslip"));
  const bankKeys = [];
  const bankFiles = form.getAll("docBank");
  for (let i = 0; i < bankFiles.length; i += 1) {
    const key = await store("bank", bankFiles[i], i);
    if (key) bankKeys.push(key);
  }
  if (!docIdKey || !payslipKey || !bankKeys.length) {
    return json({ error: "all three documents are required" }, 400, env);
  }

  await env.DB.prepare(
    `INSERT INTO applications
       (id, created_at, status, full_name, phone, national_id, address, employer, income,
        kin_name, kin_phone, purpose, repay_date, consent, doc_id_key, doc_bank_keys, doc_payslip_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, now, "new",
    field("fullName"), field("phone"), field("nationalId"), field("address"),
    field("employer"), field("income"), field("kinName"), field("kinPhone"),
    field("purpose"), field("repayDate"), "yes",
    docIdKey, JSON.stringify(bankKeys), payslipKey
  ).run();

  return json({ ok: true, reference: id }, 201, env);
}

async function listApplications(request, env) {
  const status = new URL(request.url).searchParams.get("status");
  let sql = `SELECT id, created_at, status, full_name, phone, national_id, employer, purpose, repay_date
             FROM applications`;
  const binds = [];
  if (status && STATUSES.includes(status)) { sql += ` WHERE status = ?`; binds.push(status); }
  sql += ` ORDER BY created_at DESC LIMIT 300`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ applications: results }, 200, env);
}

async function getApplication(id, env) {
  const row = await env.DB.prepare(`SELECT * FROM applications WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "not found" }, 404, env);
  row.doc_bank_keys = safeParse(row.doc_bank_keys);
  row.doc_bank_count = row.doc_bank_keys.length;
  delete row.doc_id_key;      // don't leak raw R2 keys to the client
  delete row.doc_payslip_key;
  row.doc_bank_keys = undefined;
  return json({ application: row }, 200, env);
}

async function setStatus(id, request, env) {
  const body = await request.json().catch(() => ({}));
  if (!STATUSES.includes(body.status)) return json({ error: "bad status" }, 400, env);
  const row = await env.DB.prepare(`SELECT full_name, phone FROM applications WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "not found" }, 404, env);
  await env.DB.prepare(
    `UPDATE applications SET status = ?, decided_at = ?, decided_note = ? WHERE id = ?`
  ).bind(body.status, new Date().toISOString(), (body.note || "").toString().slice(0, 500), id).run();

  // Auto-notify the applicant on WhatsApp (approved / declined), if the Cloud
  // API is configured. Never fail the decision if the message can't be sent —
  // report it so the inbox can offer the manual reply as a fallback.
  let notified = false, notifyError = null;
  if ((body.status === "approved" || body.status === "declined") && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
    const template = body.status === "approved"
      ? (env.WA_TEMPLATE_APPROVED || "loan_approved")
      : (env.WA_TEMPLATE_DECLINED || "loan_declined");
    try {
      await sendWhatsAppTemplate(env, row.phone, template, [firstName(row.full_name), id]);
      notified = true;
    } catch (e) { notifyError = String((e && e.message) || e); }
  }
  return json({ ok: true, notified, notifyError }, 200, env);
}

function firstName(n) { return String(n || "").trim().split(/\s+/)[0] || "there"; }

// Namibian numbers to WhatsApp's international format (digits only, 264…).
function waNormalize(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("264")) return d;
  if (d.startsWith("0")) return "264" + d.slice(1);
  if (d.length === 9) return "264" + d;
  return d;
}

async function sendWhatsAppTemplate(env, toPhone, templateName, bodyParams) {
  const to = waNormalize(toPhone);
  if (!to) throw new Error("no recipient phone");
  const version = env.WA_API_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: env.WA_LANG || "en" },
      components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })) }]
    }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error("whatsapp " + r.status + " " + detail.slice(0, 200));
  }
  return true;
}

async function getFile(id, field, n, env) {
  const row = await env.DB.prepare(
    `SELECT doc_id_key, doc_bank_keys, doc_payslip_key FROM applications WHERE id = ?`
  ).bind(id).first();
  if (!row) return new Response("not found", { status: 404, headers: cors(env) });

  let key = null;
  if (field === "id") key = row.doc_id_key;
  else if (field === "payslip") key = row.doc_payslip_key;
  else if (field === "bank") key = safeParse(row.doc_bank_keys)[Number(n || 0)];
  if (!key) return new Response("no such file", { status: 404, headers: cors(env) });

  const object = await env.DOCS.get(key);
  if (!object) return new Response("file missing", { status: 404, headers: cors(env) });

  return new Response(object.body, {
    headers: cors(env, {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, no-store"
    })
  });
}
