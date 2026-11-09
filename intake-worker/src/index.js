// QuickServe Cashloan — application service (Cloudflare Worker), v2.
//
// Public (website, protected by Turnstile + per-IP limits)
//   POST   /v2/applications                      create a draft (JSON) → { reference, uploadToken }
//   PUT    /v2/applications/:id                  change a draft's details          X-Upload-Token
//   PUT    /v2/applications/:id/files/:kind      upload one file (raw body)       X-Upload-Token
//   DELETE /v2/applications/:id/files/:fileId    remove a file from a draft       X-Upload-Token
//   POST   /v2/applications/:id/submit           hand in → { trackToken }         X-Upload-Token
//   POST   /v2/track                             { reference, phone } or { trackToken } → status
//   PUT    /v2/track/:id/files/:kind             upload a requested document      X-Track-Token
//
// Staff (Authorization: Bearer <Supabase access token from the admin console>,
//        or the OWNER_TOKEN secret as a fallback)
//   GET    /v2/admin/me
//   GET    /v2/admin/applications[?status=&q=]
//   GET    /v2/admin/applications/:id
//   GET    /v2/admin/applications/:id/files/:fileId
//   POST   /v2/admin/applications/:id/status        { status, note, applicantMessage }
//   PUT    /v2/admin/applications/:id/affordability { ...worksheet }
//   GET    /v2/admin/audit[?from=&to=&actor=&type=&q=&before=&format=csv]   owners only
//   POST   /v2/admin/push/subscribe                 { subscription, device }   this device gets notifications
//   POST   /v2/admin/push/unsubscribe               { endpoint }
//   POST   /v2/admin/push/test                      sends a test to your devices
//   POST   /v2/admin/applications/:id/recommend     { recommendation: approve|decline, note }
//   POST   /v2/admin/applications/:id/converted     { clientId, loanId, clientRef, loanRef }   owners only
//
// Roles come from the Supabase `staff` table (supabase/migrations/020):
// owners do everything; credit analysts approve up to their approval limit
// and recommend above it; only owners turn an application into a loan.
//
// Kept for the current admin console's Applications tab:
//   GET    /applications                          staff list in the v1 shape
//
// Bindings: DB (D1), DOCS (R2). Secrets: OWNER_TOKEN, TURNSTILE_SECRET.
// Vars: ALLOWED_ORIGINS, SUPABASE_URL, SUPABASE_KEY, MIN_AMOUNT, MAX_AMOUNT,
//       INTEREST_RATE_BP, RETENTION_DAYS.

import {
  HttpError, json, corsHeaders, formatReference, yymm, REF_PATTERN, makeToken, makeId, sha256Hex, safeEqual,
  validateApplication, normalisePhone, sniffMime, applicantStage, missingKinds,
  MAX_FILE_BYTES, MAX_FILES, FILE_KINDS, STAFF_STATUSES, CONSENT_VERSION
} from "./lib.js";
import { sendPush } from "./webpush.js";

const now = () => new Date().toISOString();

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json(request, env, err.body, err.status);
      console.error(err && err.stack || err);
      return json(request, env, { error: "Something went wrong on our side. Please try again." }, 500);
    }
  },

  // Daily clean-up: unsent drafts after 7 days; documents of declined or
  // withdrawn applications after RETENTION_DAYS.
  async scheduled(_event, env) {
    await cleanUp(env);
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  let p;

  if (path === "/" && m === "GET") return json(request, env, { service: "quickserve-applications", ok: true });

  // ---- public
  if (path === "/v2/applications" && m === "POST") return createDraft(request, env);
  if ((p = path.match(/^\/v2\/applications\/(QSA-\d{4}-\d{4,5})$/)) && m === "PUT") return updateDraft(request, env, p[1]);
  if ((p = path.match(/^\/v2\/applications\/(QSA-\d{4}-\d{4,5})\/files\/([a-z]+)$/)) && m === "PUT") return uploadDraftFile(request, env, p[1], p[2]);
  if ((p = path.match(/^\/v2\/applications\/(QSA-\d{4}-\d{4,5})\/files\/([0-9a-f-]{36})$/)) && m === "DELETE") return deleteDraftFile(request, env, p[1], p[2]);
  if ((p = path.match(/^\/v2\/applications\/(QSA-\d{4}-\d{4,5})\/submit$/)) && m === "POST") return submit(request, env, p[1], ctx);
  if (path === "/v2/track" && m === "POST") return track(request, env);
  if ((p = path.match(/^\/v2\/track\/(QSA-\d{4}-\d{4,5})\/files\/([a-z]+)$/)) && m === "PUT") return uploadRequestedFile(request, env, p[1], p[2], ctx);

  // ---- staff
  if (path.startsWith("/v2/admin/") || path === "/applications") {
    const staff = await requireStaff(request, env);
    if (path === "/v2/admin/audit" && m === "GET") return auditLog(request, env, staff);
    if (path === "/v2/admin/push/subscribe" && m === "POST") return pushSubscribe(request, env, staff);
    if (path === "/v2/admin/push/unsubscribe" && m === "POST") return pushUnsubscribe(request, env, staff);
    if (path === "/v2/admin/push/test" && m === "POST") return pushTest(request, env, staff);
    if (path === "/v2/admin/me" && m === "GET") return json(request, env, { email: staff.email, role: staff.role, approvalLimit: staff.limitCents == null ? null : staff.limitCents / 100 });
    if ((path === "/v2/admin/applications" || path === "/applications") && m === "GET") return listApplications(request, env, path === "/applications");
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})$/)) && m === "GET") return getApplication(request, env, staff, p[1]);
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})\/files\/([0-9a-f-]{36})$/)) && m === "GET") return streamFile(request, env, staff, p[1], p[2]);
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})\/status$/)) && m === "POST") return setStatus(request, env, staff, p[1]);
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})\/affordability$/)) && m === "PUT") return saveAffordability(request, env, staff, p[1]);
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})\/recommend$/)) && m === "POST") return recommend(request, env, staff, p[1]);
    if ((p = path.match(/^\/v2\/admin\/applications\/(QSA-\d{4}-\d{4,5})\/converted$/)) && m === "POST") return markConverted(request, env, staff, p[1]);
  }

  throw new HttpError(404, "Not found.");
}

// ---- guards ------------------------------------------------------------------

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function rateLimit(env, key, limit, windowSeconds) {
  const nowS = Math.floor(Date.now() / 1000);
  const start = nowS - (nowS % windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`
  ).bind(key, start).first();
  if (row && row.count > limit) throw new HttpError(429, "Too many attempts. Please wait a while and try again.");
}

async function checkTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET) return; // not configured yet (staging)
  if (!token) throw new HttpError(400, "Please complete the security check.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", clientIp(request));
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json().catch(() => ({}));
  if (!out.success) throw new HttpError(400, "The security check didn't pass. Please try again.");
}

const staffCache = new Map(); // token hash -> { email, until }

async function requireStaff(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sign in to the admin console first.");
  if (env.OWNER_TOKEN && safeEqual(token, env.OWNER_TOKEN)) return { email: "owner", role: "owner", limitCents: null, token: null };

  const key = await sha256Hex(token);
  const hit = staffCache.get(key);
  if (hit && hit.until > Date.now()) return hit;

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new HttpError(401, "Staff sign-in is not configured.");
  const res = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_KEY, Authorization: "Bearer " + token }
  });
  if (!res.ok) throw new HttpError(401, "Your session has expired. Sign in again.");
  const user = await res.json();
  const role = await staffRole(env, token, user.id);
  if (!role) throw new HttpError(403, "Your login isn't on the staff list yet. Ask the owner to add you under Settings → Staff & roles.");
  const staff = { email: user.email || user.id, role: role.role, limitCents: role.limitCents, token, until: Date.now() + 60_000 };
  staffCache.set(key, staff);
  return staff;
}

// The staff member's role, read with their own login (row-level security
// lets each person read their own row). Before the roles migration is
// installed every signed-in user is treated as an owner, as before.
async function staffRole(env, token, userId) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/staff?user_id=eq.${encodeURIComponent(userId)}&select=role,approval_limit`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: "Bearer " + token }
  });
  if (res.status === 404) return { role: "owner", limitCents: null };           // roles not installed yet
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body && (body.code === "PGRST205" || body.code === "42P01")) return { role: "owner", limitCents: null };
    throw new HttpError(502, "Couldn't check your access. Try again.");
  }
  const rows = await res.json();
  if (!rows.length) return null;
  const r = rows[0];
  return { role: r.role, limitCents: r.approval_limit == null ? null : Math.round(Number(r.approval_limit) * 100) };
}

function requireOwner(staff) {
  if (staff.role !== "owner") throw new HttpError(403, "Only an owner can do this.");
}

async function ledgerMatch(env, staff, app) {
  if (!staff.token || !env.SUPABASE_URL) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_client`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_KEY, Authorization: "Bearer " + staff.token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_national_id: app.national_id, p_phone: app.phone })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function loadApp(env, id) {
  const app = await env.DB.prepare(`SELECT * FROM applications WHERE id = ?`).bind(id).first();
  if (!app) throw new HttpError(404, "We couldn't find that application.");
  return app;
}

async function requireToken(request, env, id, header, column) {
  const token = request.headers.get(header) || "";
  const app = await loadApp(env, id);
  if (!token || !app[column] || !safeEqual(await sha256Hex(token), app[column])) {
    throw new HttpError(403, "This link has expired. Start again or contact us on WhatsApp.");
  }
  return app;
}

async function event(env, id, actor, type, detail) {
  await env.DB.prepare(
    `INSERT INTO application_events (application_id, at, actor, type, detail_json) VALUES (?,?,?,?,?)`
  ).bind(id, now(), actor, type, detail ? JSON.stringify(detail) : null).run();
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Expected a JSON body."); }
}

// ---- public: draft → files → submit -----------------------------------------

async function createDraft(request, env) {
  // Check the details first, so a typo doesn't use up the applicant's
  // security check or count against their hourly limit.
  const body = await readJson(request);
  const { row, errors } = validateApplication(body, env);
  if (Object.keys(errors).length) throw new HttpError(400, "Some details need fixing.", { fields: errors });
  await rateLimit(env, "draft:" + clientIp(request), Number(env.DRAFTS_PER_HOUR || 5), 3600);
  await checkTurnstile(request, env, body.turnstileToken);

  const uploadToken = makeToken();
  const t = now();
  // Next number in the QSA- sequence, matching the ledger's QS-/QSL- style.
  const period = yymm();
  const seq = await env.DB.prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
  ).bind("application:" + period).first();
  const id = formatReference(period, seq.value);
  const cols = { id, created_at: t, updated_at: t, status: "draft", source: "web", upload_token_hash: await sha256Hex(uploadToken), ...row };
  const names = Object.keys(cols);
  await env.DB.prepare(`INSERT INTO applications (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .bind(...names.map((k) => cols[k])).run();
  await event(env, id, "applicant", "draft_created", null);

  return json(request, env, {
    reference: id,
    uploadToken,
    amountCents: row.amount_cents,
    interestCents: row.interest_cents,
    totalCents: row.total_cents
  }, 201);
}

async function updateDraft(request, env, id) {
  const app = await requireToken(request, env, id, "X-Upload-Token", "upload_token_hash");
  if (app.status !== "draft") throw new HttpError(409, "This application has already been handed in.");
  const { row, errors } = validateApplication(await readJson(request), env);
  if (Object.keys(errors).length) throw new HttpError(400, "Some details need fixing.", { fields: errors });
  const names = Object.keys(row);
  await env.DB.prepare(`UPDATE applications SET ${names.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...names.map((k) => row[k]), now(), id).run();
  return json(request, env, { reference: id, amountCents: row.amount_cents, interestCents: row.interest_cents, totalCents: row.total_cents });
}

async function storeFile(request, env, app, kind, uploadedBy) {
  if (!FILE_KINDS.includes(kind)) throw new HttpError(400, "Unknown document type.");
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_FILE_BYTES) throw new HttpError(413, "That file is over 10 MB. Try a photo instead of a scan.");

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, "The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "That file is over 10 MB. Try a photo instead of a scan.");
  const mime = sniffMime(bytes);
  if (!mime) throw new HttpError(415, "Use a photo (JPG, PNG, HEIC) or a PDF.");

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM application_files WHERE application_id = ? AND deleted_at IS NULL`
  ).bind(app.id).first();
  if (count.n >= MAX_FILES) throw new HttpError(400, `You can attach up to ${MAX_FILES} files.`);

  const fileId = makeId();
  const key = `applications/${app.id}/${kind}/${fileId}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: mime } });
  const label = (new URL(request.url).searchParams.get("label") || "").slice(0, 60) || null;
  await env.DB.prepare(
    `INSERT INTO application_files (id, application_id, kind, label, r2_key, mime, bytes, sha256, uploaded_at, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(fileId, app.id, kind, label, key, mime, bytes.length, await sha256Hex(bytes), now(), uploadedBy).run();
  return { fileId, kind, mime, bytes: bytes.length };
}

async function uploadDraftFile(request, env, id, kind) {
  const app = await requireToken(request, env, id, "X-Upload-Token", "upload_token_hash");
  if (app.status !== "draft") throw new HttpError(409, "This application has already been handed in.");
  const file = await storeFile(request, env, app, kind, "applicant");
  return json(request, env, file, 201);
}

async function deleteDraftFile(request, env, id, fileId) {
  const app = await requireToken(request, env, id, "X-Upload-Token", "upload_token_hash");
  if (app.status !== "draft") throw new HttpError(409, "This application has already been handed in.");
  const file = await env.DB.prepare(`SELECT * FROM application_files WHERE id = ? AND application_id = ?`).bind(fileId, id).first();
  if (!file) throw new HttpError(404, "File not found.");
  await env.DOCS.delete(file.r2_key);
  await env.DB.prepare(`DELETE FROM application_files WHERE id = ?`).bind(fileId).run();
  return json(request, env, { ok: true });
}

async function submit(request, env, id, ctx) {
  const app = await requireToken(request, env, id, "X-Upload-Token", "upload_token_hash");
  if (app.status !== "draft") throw new HttpError(409, "This application has already been handed in.");
  const body = await readJson(request);

  const consent = body.consent || {};
  if (!consent.creditCheck || !consent.privacy || !consent.truthful) {
    throw new HttpError(400, "Tick all three boxes to hand in your application.");
  }
  const signed = String(body.signedName || "").trim().replace(/\s+/g, " ");
  if (signed.toLowerCase() !== String(app.full_name).toLowerCase()) {
    throw new HttpError(400, "Type your full name exactly as on sheet 2 to sign.");
  }
  const { results: files } = await env.DB.prepare(
    `SELECT kind, deleted_at FROM application_files WHERE application_id = ?`
  ).bind(id).all();
  const missing = missingKinds(files);
  if (missing.length) throw new HttpError(400, "Some documents are missing.", { missing });

  const trackToken = makeToken();
  const t = now();
  await env.DB.prepare(
    `UPDATE applications SET status = 'new', submitted_at = ?, updated_at = ?, consent_version = ?, consent_at = ?,
       consent_ip = ?, consent_ua = ?, signed_name = ?, upload_token_hash = NULL, track_token_hash = ?
     WHERE id = ? AND status = 'draft'`
  ).bind(t, t, CONSENT_VERSION, t, clientIp(request), (request.headers.get("User-Agent") || "").slice(0, 300),
    signed, await sha256Hex(trackToken), id).run();
  await event(env, id, "applicant", "submitted", { files: files.length });
  const notify = notifyStaff(env, {
    title: "New application " + id,
    body: [app.full_name, "N$ " + Math.round((app.amount_cents || 0) / 100).toLocaleString("en-US").replace(/,/g, " "),
      app.above_standard ? "over N$ 10 000" : null].filter(Boolean).join(" · "),
    url: "/?app=" + id,
    tag: id
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(notify); else await notify;

  return json(request, env, { reference: id, submittedAt: t, trackToken });
}

// ---- public: tracking ----------------------------------------------------------

async function track(request, env) {
  await rateLimit(env, "track:" + clientIp(request), Number(env.TRACKS_PER_HOUR || 20), 3600);
  const body = await readJson(request);
  let app = null;

  if (body.trackToken) {
    app = await env.DB.prepare(`SELECT * FROM applications WHERE track_token_hash = ?`).bind(await sha256Hex(String(body.trackToken))).first();
  } else {
    await checkTurnstile(request, env, body.turnstileToken);
    const ref = String(body.reference || "").trim().toUpperCase();
    const phone = normalisePhone(body.phone);
    if (new RegExp("^" + REF_PATTERN + "$").test(ref) && phone) {
      app = await env.DB.prepare(`SELECT * FROM applications WHERE id = ? AND phone = ?`).bind(ref, phone).first();
    }
  }
  if (!app || app.status === "draft") throw new HttpError(404, "We couldn't find an application with those details.");

  const { results: files } = await env.DB.prepare(
    `SELECT kind, deleted_at FROM application_files WHERE application_id = ?`
  ).bind(app.id).all();
  const { results: events } = await env.DB.prepare(
    `SELECT at, type, detail_json FROM application_events WHERE application_id = ? AND type IN ('submitted','status') ORDER BY id`
  ).bind(app.id).all();

  // One stamp per step reached, dated the first time it happened.
  const firstAt = {};
  for (const e of events) {
    if (e.type !== "status") continue;
    const to = JSON.parse(e.detail_json || "{}").to;
    if (to && !firstAt[to]) firstAt[to] = e.at;
  }
  const reached = (s) => ({ in_review: ["in_review", "info_requested", "approved", "converted", "declined"], approved: ["approved", "converted"], paid: ["converted"] })[s].includes(app.status);
  const stamps = [{ stamp: "received", at: app.submitted_at }];
  if (reached("in_review")) stamps.push({ stamp: "in_review", at: firstAt.in_review || firstAt.info_requested || firstAt.approved || firstAt.declined || app.updated_at });
  if (reached("approved")) stamps.push({ stamp: "approved", at: firstAt.approved || app.decided_at });
  if (reached("paid")) stamps.push({ stamp: "paid", at: app.converted_at });

  return json(request, env, {
    reference: app.id,
    stage: applicantStage(app.status),
    stamps,
    message: app.status === "info_requested" || app.status === "declined" ? app.applicant_message : null,
    amountCents: app.amount_cents,
    totalCents: app.total_cents,
    submittedAt: app.submitted_at,
    missing: missingKinds(files),
    canUpload: app.status === "info_requested" && Boolean(body.trackToken)
  });
}

async function uploadRequestedFile(request, env, id, kind, ctx) {
  const app = await requireToken(request, env, id, "X-Track-Token", "track_token_hash");
  if (app.status !== "info_requested") throw new HttpError(409, "We're not waiting for any documents on this application.");
  const file = await storeFile(request, env, app, kind, "applicant");
  await env.DB.prepare(`UPDATE applications SET status = 'in_review', updated_at = ? WHERE id = ?`).bind(now(), id).run();
  await event(env, id, "applicant", "document_added", { kind, fileId: file.fileId });
  await event(env, id, "system", "status", { from: "info_requested", to: "in_review" });
  const what = { id: "ID / passport", payslip: "payslip", bank: "bank statement", other: "document" }[kind] || "document";
  const notify = notifyStaff(env, {
    title: "Document received " + id,
    body: (app.full_name || "The applicant") + " sent the requested " + what + ". Back in review.",
    url: "/?app=" + id,
    tag: id + "-doc"
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(notify); else await notify;
  return json(request, env, file, 201);
}

// ---- staff ---------------------------------------------------------------------

async function listApplications(request, env, legacyShape) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") || "").trim();
  const where = ["status <> 'draft'"];
  const binds = [];
  if (status === "recommended") where.push("recommendation IS NOT NULL AND status IN ('new','in_review','info_requested')");
  else if (status === "open") where.push("status IN ('new','in_review')");
  else if (status && STAFF_STATUSES.concat(["new", "converted"]).includes(status)) { where.push("status = ?"); binds.push(status); }
  const month = (url.searchParams.get("month") || "").replace(/\D/g, "");
  if (month.length === 4) { where.push("id LIKE ?"); binds.push("QSA-" + month + "-%"); }
  if (q) {
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const digits = q.replace(/\D/g, "");
    where.push("(full_name LIKE ? OR id LIKE ?" + (digits.length >= 4 ? " OR national_id LIKE ? OR phone LIKE ?" : "") + ")");
    binds.push(like, like);
    if (digits.length >= 4) binds.push("%" + digits + "%", "%" + digits + "%");
  }
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, submitted_at, status, full_name, phone, national_id, employer, purpose,
            amount_cents, total_cents, payday, id_type, above_standard, ledger_client_ref, ledger_loan_ref,
            recommendation, recommended_by
     FROM applications WHERE ${where.join(" AND ")} ORDER BY submitted_at DESC LIMIT 300`
  ).bind(...binds).all();
  const { results: counts } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM applications WHERE status <> 'draft' GROUP BY status
     UNION ALL SELECT 'recommended', COUNT(*) FROM applications WHERE recommendation IS NOT NULL AND status IN ('new','in_review','info_requested')`
  ).all();

  if (legacyShape) {
    return json(request, env, {
      applications: results.map((a) => ({ ...a, created_at: a.submitted_at || a.created_at, repay_date: a.payday }))
    });
  }
  return json(request, env, {
    applications: results,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n]))
  });
}

async function getApplication(request, env, staff, id) {
  let app = await loadApp(env, id);
  if (app.status === "draft") throw new HttpError(404, "This application hasn't been handed in yet.");
  await eventOnce(env, id, "staff:" + staff.email, "opened", null);
  if (app.status === "new") {
    await env.DB.prepare(`UPDATE applications SET status = 'in_review', updated_at = ? WHERE id = ? AND status = 'new'`).bind(now(), id).run();
    await event(env, id, "staff:" + staff.email, "status", { from: "new", to: "in_review" });
    app = await loadApp(env, id);
  }
  const { results: files } = await env.DB.prepare(
    `SELECT id, kind, label, mime, bytes, uploaded_at, uploaded_by FROM application_files
     WHERE application_id = ? AND deleted_at IS NULL ORDER BY uploaded_at`
  ).bind(id).all();
  const { results: events } = await env.DB.prepare(
    `SELECT at, actor, type, detail_json FROM application_events WHERE application_id = ? ORDER BY id DESC`
  ).bind(id).all();
  const { results: others } = await env.DB.prepare(
    `SELECT id, status, submitted_at, amount_cents FROM applications
     WHERE id <> ? AND status <> 'draft' AND (national_id = ? OR phone = ?) ORDER BY submitted_at DESC LIMIT 10`
  ).bind(id, app.national_id, app.phone).all();

  for (const k of ["upload_token_hash", "track_token_hash"]) delete app[k];
  app.affordability = app.affordability_json ? JSON.parse(app.affordability_json) : null;
  delete app.affordability_json;
  return json(request, env, {
    application: app,
    you: { email: staff.email, role: staff.role, approvalLimit: staff.limitCents == null ? null : staff.limitCents / 100 },
    ledgerMatches: await ledgerMatch(env, staff, app),
    files,
    events: events.map((e) => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null, detail_json: undefined })),
    otherApplications: others
  });
}

async function streamFile(request, env, staff, id, fileId) {
  const file = await env.DB.prepare(
    `SELECT * FROM application_files WHERE id = ? AND application_id = ? AND deleted_at IS NULL`
  ).bind(fileId, id).first();
  if (!file) throw new HttpError(404, "File not found.");
  await eventOnce(env, id, "staff:" + staff.email, "document_viewed", { fileId, kind: file.kind });
  const object = await env.DOCS.get(file.r2_key);
  if (!object) throw new HttpError(404, "File missing from storage.");
  return new Response(object.body, {
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": file.mime,
      "Content-Disposition": `inline; filename="${id}-${file.kind}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function setStatus(request, env, staff, id) {
  const app = await loadApp(env, id);
  const body = await readJson(request);
  const to = String(body.status || "");
  if (!STAFF_STATUSES.includes(to)) throw new HttpError(400, "Unknown status.");
  if (app.status === "draft" || app.status === "converted") throw new HttpError(409, `Can't change an application that is ${app.status}.`);
  const message = String(body.applicantMessage || "").trim().slice(0, 500) || null;
  if (to === "info_requested" && !message) throw new HttpError(400, "Write what the applicant needs to send.");
  if (to === "declined" && !message) throw new HttpError(400, "Write the reason the applicant will see on their tracking page.");
  if (to === "approved" && staff.role !== "owner" && (staff.limitCents == null || app.amount_cents > staff.limitCents)) {
    throw new HttpError(403, staff.limitCents == null
      ? "You can't approve applications. Recommend it to the owner instead."
      : `This is above your approval limit of N$ ${(staff.limitCents / 100).toLocaleString("en-US")}. Recommend it to the owner instead.`, { code: "above_limit" });
  }
  const note = String(body.note || "").trim().slice(0, 1000) || null;
  const t = now();
  const decided = to === "approved" || to === "declined";

  await env.DB.prepare(
    `UPDATE applications SET status = ?, updated_at = ?, applicant_message = ?,
       decided_at = CASE WHEN ? THEN ? ELSE decided_at END,
       decided_by = CASE WHEN ? THEN ? ELSE decided_by END,
       decided_note = COALESCE(?, decided_note)
     WHERE id = ?`
  ).bind(to, t, message, decided ? 1 : 0, t, decided ? 1 : 0, staff.email, note, id).run();
  await event(env, id, "staff:" + staff.email, "status", {
    from: app.status, to, note, applicantMessage: message,
    // What the decision was based on, kept with the decision.
    basis: decided ? {
      role: staff.role, approvalLimit: staff.limitCents == null ? null : staff.limitCents / 100,
      amount: app.amount_cents / 100, total: app.total_cents / 100, aboveStandard: Boolean(app.above_standard),
      affordability: app.affordability_json ? JSON.parse(app.affordability_json) : null,
      recommendation: app.recommendation ? { by: app.recommended_by, recommendation: app.recommendation, note: app.recommendation_note } : null
    } : undefined
  });
  return json(request, env, { ok: true, status: to });
}

async function saveAffordability(request, env, staff, id) {
  await loadApp(env, id);
  const body = await readJson(request);
  const sheet = JSON.stringify(body).slice(0, 8000);
  await env.DB.prepare(`UPDATE applications SET affordability_json = ?, updated_at = ? WHERE id = ?`).bind(sheet, now(), id).run();
  await event(env, id, "staff:" + staff.email, "affordability_saved", null);
  return json(request, env, { ok: true });
}

async function recommend(request, env, staff, id) {
  const app = await loadApp(env, id);
  if (!["new", "in_review", "info_requested"].includes(app.status)) throw new HttpError(409, `Can't recommend an application that is ${app.status}.`);
  const body = await readJson(request);
  const rec = String(body.recommendation || "");
  if (!["approve", "decline"].includes(rec)) throw new HttpError(400, "Recommend approve or decline.");
  const note = String(body.note || "").trim().slice(0, 1000);
  if (!note) throw new HttpError(400, "Add a short note on why, for the owner.");
  const t = now();
  await env.DB.prepare(
    `UPDATE applications SET recommendation = ?, recommendation_note = ?, recommended_by = ?, recommended_at = ?,
       status = CASE WHEN status = 'new' THEN 'in_review' ELSE status END, updated_at = ? WHERE id = ?`
  ).bind(rec, note, staff.email, t, t, id).run();
  await event(env, id, "staff:" + staff.email, "recommended", { recommendation: rec, note });
  return json(request, env, { ok: true });
}

async function markConverted(request, env, staff, id) {
  requireOwner(staff);
  const app = await loadApp(env, id);
  if (app.status !== "approved") throw new HttpError(409, "Approve the application before creating the loan.");
  const body = await readJson(request);
  const clientId = String(body.clientId || "").slice(0, 80), loanId = String(body.loanId || "").slice(0, 80);
  const clientRef = String(body.clientRef || "").slice(0, 20) || null, loanRef = String(body.loanRef || "").slice(0, 20) || null;
  if (!clientId || !loanId) throw new HttpError(400, "clientId and loanId are required.");
  const t = now();
  await env.DB.prepare(
    `UPDATE applications SET status = 'converted', ledger_client_id = ?, ledger_loan_id = ?, ledger_client_ref = ?, ledger_loan_ref = ?,
       converted_at = ?, updated_at = ? WHERE id = ?`
  ).bind(clientId, loanId, clientRef, loanRef, t, t, id).run();
  await event(env, id, "staff:" + staff.email, "status", { from: "approved", to: "converted", clientId, loanId, clientRef, loanRef });
  return json(request, env, { ok: true });
}

// Logs a view at most once per person per application (or file) per 30 minutes,
// so the trail shows who looked at what without filling up with refreshes.
async function eventOnce(env, id, actor, type, detail) {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const key = detail && detail.fileId ? `%"fileId":"${detail.fileId}"%` : "%";
  const seen = await env.DB.prepare(
    `SELECT 1 FROM application_events WHERE application_id = ? AND actor = ? AND type = ? AND at > ? AND COALESCE(detail_json, '') LIKE ? LIMIT 1`
  ).bind(id, actor, type, since, key).first();
  if (!seen) await event(env, id, actor, type, detail);
}

// ---- audit trail (owners) -----------------------------------------------------------

const AUDIT_LABELS = {
  draft_created: "Started an application", submitted: "Handed in", document_added: "Sent a requested document",
  opened: "Opened the application", document_viewed: "Viewed a document", affordability_saved: "Saved the affordability worksheet",
  recommended: "Recommended", status: "Changed status"
};

async function auditLog(request, env, staff) {
  requireOwner(staff);
  const u = new URL(request.url);
  const where = ["1 = 1"], binds = [];
  const from = u.searchParams.get("from"), to = u.searchParams.get("to");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push("e.at >= ?"); binds.push(from + "T00:00:00Z"); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("e.at < ?"); binds.push(new Date(Date.parse(to + "T00:00:00Z") + 86_400_000).toISOString()); }
  const actor = u.searchParams.get("actor");
  if (actor) { where.push("e.actor = ?"); binds.push(actor); }
  const type = u.searchParams.get("type");
  if (type === "decision") where.push("e.type = 'status' AND json_extract(e.detail_json, '$.to') IN ('approved','declined','converted')");
  else if (type && AUDIT_LABELS[type]) { where.push("e.type = ?"); binds.push(type); }
  const q = (u.searchParams.get("q") || "").trim();
  if (q) { where.push("(e.application_id LIKE ? OR a.full_name LIKE ?)"); binds.push("%" + q + "%", "%" + q + "%"); }
  const csv = u.searchParams.get("format") === "csv";
  const before = Number(u.searchParams.get("before") || 0);
  if (before > 0 && !csv) { where.push("e.id < ?"); binds.push(before); }
  const limit = csv ? 20000 : 200;
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.at, e.actor, e.type, e.detail_json, e.application_id, a.full_name, a.amount_cents, a.status AS current_status
     FROM application_events e LEFT JOIN applications a ON a.id = e.application_id
     WHERE ${where.join(" AND ")} AND a.status <> 'draft'
     ORDER BY e.id DESC LIMIT ${limit}`
  ).bind(...binds).all();
  const rows = results.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null, detail_json: undefined }));

  if (csv) {
    const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [["When (UTC)", "Who", "Application", "Applicant", "Amount (N$)", "Action", "From", "To", "Note / reason", "Message to applicant", "Details"].join(",")];
    for (const r of rows.reverse()) {
      const d = r.detail || {};
      lines.push([r.at, r.actor.replace(/^staff:/, ""), r.application_id, r.full_name, r.amount_cents == null ? "" : (r.amount_cents / 100).toFixed(2),
        AUDIT_LABELS[r.type] || r.type, d.from || "", d.to || "", d.note || d.recommendation || "", d.applicantMessage || "",
        d.basis ? JSON.stringify(d.basis) : (d.kind || d.loanRef || "")].map(cell).join(","));
    }
    return new Response(lines.join("\r\n") + "\r\n", {
      headers: { ...corsHeaders(request, env), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="quickserve-audit-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" }
    });
  }
  const { results: actors } = await env.DB.prepare(`SELECT DISTINCT actor FROM application_events ORDER BY actor`).all();
  return json(request, env, { events: rows, actors: actors.map((a) => a.actor), more: rows.length === limit });
}

// ---- push notifications to staff ----------------------------------------------------

async function pushSubscribe(request, env, staff) {
  const body = await readJson(request);
  const sub = body.subscription || {};
  const keys = sub.keys || {};
  let host = "";
  try { host = new URL(sub.endpoint).hostname; } catch { /* checked below */ }
  const known = /(^|\.)(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(host);
  if (!known || !keys.p256dh || !keys.auth) throw new HttpError(400, "That isn't a valid notification subscription.");
  const id = await sha256Hex(sub.endpoint);
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, staff_email, device, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, staff_email = excluded.staff_email,
       device = excluded.device, failures = 0`
  ).bind(id, sub.endpoint, keys.p256dh, keys.auth, staff.email, String(body.device || "").slice(0, 80), now()).run();
  return json(request, env, { ok: true });
}

async function pushUnsubscribe(request, env, staff) {
  const body = await readJson(request);
  if (body.endpoint) await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(await sha256Hex(String(body.endpoint))).run();
  return json(request, env, { ok: true });
}

async function pushTest(request, env, staff) {
  const result = await notifyStaff(env, {
    title: "QuickServe notifications are on",
    body: "You'll get a notification like this for every new application.",
    url: "/?app=",
    tag: "test"
  }, staff.email);
  return json(request, env, result);
}

// Sends to every staff device (or only `onlyEmail`'s). Never throws: a
// notification problem must not stop an application being handed in.
export async function notifyStaff(env, message, onlyEmail) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, devices: 0, configured: false };
  try {
    const q = onlyEmail
      ? env.DB.prepare(`SELECT * FROM push_subscriptions WHERE staff_email = ?`).bind(onlyEmail)
      : env.DB.prepare(`SELECT * FROM push_subscriptions`);
    const { results: subs } = await q.all();
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      let status = 0;
      try { status = await sendPush(s, message, env); } catch (e) { console.error("push", e && e.message); }
      if (status >= 200 && status < 300) {
        sent += 1;
        await env.DB.prepare(`UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?`).bind(now(), s.id).run();
      } else if (status === 404 || status === 410 || s.failures >= 20) {
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(s.id).run();   // device turned them off
      } else {
        await env.DB.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?`).bind(s.id).run();
      }
    }));
    return { sent, devices: subs.length, configured: true };
  } catch (e) {
    console.error("notifyStaff", e && e.message);
    return { sent: 0, devices: 0, configured: true, error: true };
  }
}

// ---- retention -------------------------------------------------------------------

export async function cleanUp(env) {
  const day = 86_400_000;
  const draftCutoff = new Date(Date.now() - 7 * day).toISOString();
  const keepDays = Number(env.RETENTION_DAYS || 180);
  const closedCutoff = new Date(Date.now() - keepDays * day).toISOString();

  const { results: drafts } = await env.DB.prepare(
    `SELECT id FROM applications WHERE status = 'draft' AND created_at < ?`
  ).bind(draftCutoff).all();
  for (const d of drafts) {
    const { results: files } = await env.DB.prepare(`SELECT r2_key FROM application_files WHERE application_id = ?`).bind(d.id).all();
    for (const f of files) await env.DOCS.delete(f.r2_key);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM application_files WHERE application_id = ?`).bind(d.id),
      env.DB.prepare(`DELETE FROM application_events WHERE application_id = ?`).bind(d.id),
      env.DB.prepare(`DELETE FROM applications WHERE id = ?`).bind(d.id)
    ]);
  }

  const { results: old } = await env.DB.prepare(
    `SELECT f.id, f.r2_key, f.application_id FROM application_files f JOIN applications a ON a.id = f.application_id
     WHERE a.status IN ('declined','withdrawn') AND a.updated_at < ? AND f.deleted_at IS NULL`
  ).bind(closedCutoff).all();
  const t = now();
  for (const f of old) {
    await env.DOCS.delete(f.r2_key);
    await env.DB.prepare(`UPDATE application_files SET deleted_at = ? WHERE id = ?`).bind(t, f.id).run();
  }
  return { draftsRemoved: drafts.length, filesRemoved: old.length };
}
