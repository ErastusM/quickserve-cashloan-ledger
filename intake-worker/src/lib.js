// Shared helpers for the application service. Pure functions where possible,
// so tests/worker.test.mjs can exercise them without Cloudflare.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
export const MAX_FILES = 12;                        // per application
export const FILE_KINDS = ["id", "payslip", "bank", "other"];
export const STAFF_STATUSES = ["in_review", "info_requested", "approved", "declined", "withdrawn"];
export const CONSENT_VERSION = "2026-11";

// ---- responses & CORS -------------------------------------------------------

export function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : "";
}

export function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Upload-Token,X-Track-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(request, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(request, env), ...extra }
  });
}

export class HttpError extends Error {
  constructor(status, error, extra) {
    super(error);
    this.status = status;
    this.body = { error, ...(extra || {}) };
  }
}

// ---- ids, tokens, hashing ---------------------------------------------------

// QSA-YYMM-NNNN: year and month (Namibian time), then a number that starts
// again at 0001 each month. Example: QSA-2611-0001.
export function yymm(date = new Date()) {
  const d = new Date(date.getTime() + 2 * 3600_000); // Namibia is UTC+2 all year
  return String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0");
}
export function formatReference(period, n) {
  return "QSA-" + period + "-" + String(n).padStart(4, "0");
}
export const REF_PATTERN = "QSA-\\d{4}-\\d{4,5}";

export function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makeId() {
  return crypto.randomUUID();
}

export async function sha256Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison of two equal-length strings.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- tracking sessions ----------------------------------------------------------
// After a reference + cellphone lookup (with the bot check), the tracking page
// gets a signed pass for 24 hours, so it can refresh and upload a requested
// document from any phone. Format: s.<reference>.<expiry ms>.<signature>.
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function makeTrackSession(secret, id, ttlMs = 24 * 3600_000) {
  const exp = Date.now() + ttlMs;
  return `s.${id}.${exp}.${await hmacHex(secret, id + "." + exp)}`;
}
export async function readTrackSession(secret, token) {
  const m = /^s\.(QSA-\d{4}-\d{4,5})\.(\d{13})\.([0-9a-f]{64})$/.exec(String(token || ""));
  if (!m || !secret) return null;
  if (Number(m[2]) < Date.now()) return null;
  return safeEqual(await hmacHex(secret, m[1] + "." + m[2]), m[3]) ? m[1] : null;
}

// ---- validation -------------------------------------------------------------

// Namibian numbers: "081 234 5678", "+264 81 234 5678", "264812345678" -> "264812345678".
export function normalisePhone(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "264" + d.slice(1);
  return /^264\d{8,9}$/.test(d) ? d : null;
}

export function normaliseNationalId(value) {
  const d = String(value || "").replace(/\D/g, "");
  return /^\d{11}$/.test(d) ? d : null;
}

// Passports: letters and digits only, 6–20 characters, upper case.
export function normalisePassport(value) {
  const p = String(value || "").toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{6,20}$/.test(p) ? p : null;
}

function text(value, max) {
  const s = String(value == null ? "" : value).trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : "";
}

function cents(value) {
  const n = Number(String(value == null ? "" : value).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function loanCost(amountCents, rateBp) {
  const interest = Math.round((amountCents * rateBp) / 10000);
  return { interest_cents: interest, total_cents: amountCents + interest };
}

// Validates the applicant's details for a draft. Returns { row, errors }.
export function validateApplication(input, env) {
  const errors = {};
  const minN = Number(env.MIN_AMOUNT || 500);
  const standardN = Number(env.STANDARD_MAX_AMOUNT || 10000);   // most loans
  const maxN = Number(env.MAX_AMOUNT || 100000);                 // hard ceiling for "more than standard"
  const idType = input.idType === "passport" ? "passport" : "nam_id";
  const rateBp = Number(env.INTEREST_RATE_BP || 3000);

  const row = {
    full_name: text(input.fullName, 120),
    id_type: idType,
    national_id: idType === "passport" ? normalisePassport(input.nationalId) : normaliseNationalId(input.nationalId),
    nationality: idType === "passport" ? text(input.nationality, 60) : null,
    phone: normalisePhone(input.phone),
    email: text(input.email, 160).toLowerCase(),
    employer: text(input.employer, 120),
    net_income_cents: cents(input.netIncome),
    payday: text(input.payday, 40),
    kin_name: text(input.kinName, 120),
    kin_phone: input.kinPhone ? normalisePhone(input.kinPhone) : null,
    purpose: text(input.purpose, 60),
    amount_cents: cents(input.amount),
    term: "payday",
    interest_rate_bp: rateBp
  };

  if (row.full_name.length < 3) errors.fullName = "Enter your full name as it is on your ID.";
  if (!row.national_id) {
    errors.nationalId = idType === "passport"
      ? "Enter your passport number as it is printed (letters and numbers only)."
      : "Enter your 11-digit Namibian ID number.";
  }
  if (idType === "passport" && !row.nationality) errors.nationality = "Enter your nationality.";
  if (!row.phone) errors.phone = "Enter a Namibian cellphone number, for example 081 234 5678.";
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.email = "Check the email address.";
  if (!row.employer) errors.employer = "Tell us who you work for.";
  if (!row.net_income_cents) errors.netIncome = "Enter your take-home pay per month.";
  if (!row.payday) errors.payday = "Tell us which day you get paid.";
  if (!row.kin_name) errors.kinName = "Enter a next of kin.";
  if (input.kinPhone && !row.kin_phone) errors.kinPhone = "Check your next of kin's number.";
  if (!row.kin_phone) errors.kinPhone = errors.kinPhone || "Enter your next of kin's number.";
  if (!row.purpose) errors.purpose = "Tell us what the loan is for.";
  if (!row.amount_cents || row.amount_cents < minN * 100 || row.amount_cents > maxN * 100) {
    errors.amount = `Choose an amount from N$ ${minN} to N$ ${maxN}.`;
  }
  row.above_standard = row.amount_cents > standardN * 100 ? 1 : 0;
  if (term(input.term) !== "payday") errors.term = "Only payday loans are available for now.";

  if (row.amount_cents) Object.assign(row, loanCost(row.amount_cents, rateBp));
  if (!row.email) row.email = null;
  return { row, errors };
}

function term(value) {
  return value == null || value === "" ? "payday" : String(value);
}

// ---- file type sniffing ------------------------------------------------------

// Returns the real MIME type from the file's first bytes, or null if not allowed.
export function sniffMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(ascii(8, 12))) return "image/heic";
  return null;
}

// ---- what the applicant sees -------------------------------------------------

// What the applicant's tracking page shows, matching the admin portal:
// New → Received, In review, Waiting on applicant → Waiting on you,
// Approved, Paid out → Paid, Declined, Withdrawn.
export function applicantStage(status) {
  return {
    draft: "not_handed_in",
    new: "received",
    in_review: "in_review",
    info_requested: "waiting_on_you",
    approved: "approved",
    converted: "paid",
    declined: "declined",
    withdrawn: "withdrawn"
  }[status] || "received";
}

export function missingKinds(files) {
  const have = new Set(files.filter((f) => !f.deleted_at).map((f) => f.kind));
  return ["id", "payslip", "bank"].filter((k) => !have.has(k));
}
