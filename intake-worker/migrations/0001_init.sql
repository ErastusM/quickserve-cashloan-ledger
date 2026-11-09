-- QuickServe Cashloan — application service database (Cloudflare D1), v2.
-- Fresh start on the QuickServe Cloudflare account (no data carried over).
-- Apply with:  npx wrangler d1 migrations apply quickserve-intake --remote

CREATE TABLE IF NOT EXISTS applications (
  id                 TEXT PRIMARY KEY,               -- reference, e.g. AP-7KD4MP
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  submitted_at       TEXT,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','new','in_review','info_requested','approved','declined','withdrawn','converted')),
  source             TEXT NOT NULL DEFAULT 'web',     -- web | whatsapp

  full_name          TEXT,
  national_id        TEXT,
  phone              TEXT,                            -- digits, international: 264812345678
  email              TEXT,
  employer           TEXT,
  net_income_cents   INTEGER,
  payday             TEXT,
  kin_name           TEXT,
  kin_phone          TEXT,

  amount_cents       INTEGER,
  term               TEXT NOT NULL DEFAULT 'payday',  -- payday only for now
  purpose            TEXT,
  interest_rate_bp   INTEGER,                         -- 3000 = 30%
  interest_cents     INTEGER,
  total_cents        INTEGER,

  consent_version    TEXT,
  consent_at         TEXT,
  consent_ip         TEXT,
  consent_ua         TEXT,
  signed_name        TEXT,

  upload_token_hash  TEXT,                            -- SHA-256 of the draft upload token
  track_token_hash   TEXT,                            -- SHA-256 of the tracking token

  applicant_message  TEXT,                            -- shown to the applicant on /track
  affordability_json TEXT,                            -- staff worksheet (document 03)
  decided_at         TEXT,
  decided_by         TEXT,
  decided_note       TEXT,                            -- internal only
  ledger_client_id   TEXT,
  ledger_loan_id     TEXT,
  converted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_status    ON applications (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_nid       ON applications (national_id);
CREATE INDEX IF NOT EXISTS idx_app_phone     ON applications (phone);
CREATE INDEX IF NOT EXISTS idx_app_created   ON applications (created_at);

CREATE TABLE IF NOT EXISTS application_files (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id),
  kind            TEXT NOT NULL CHECK (kind IN ('id','payslip','bank','other')),
  label           TEXT,
  r2_key          TEXT NOT NULL,
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  uploaded_at     TEXT NOT NULL,
  uploaded_by     TEXT NOT NULL,                      -- applicant | staff:<email>
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_app ON application_files (application_id);

CREATE TABLE IF NOT EXISTS application_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  TEXT NOT NULL,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,                      -- applicant | system | staff:<email>
  type            TEXT NOT NULL,
  detail_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_app ON application_events (application_id, id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key             TEXT PRIMARY KEY,
  window_start    INTEGER NOT NULL,
  count           INTEGER NOT NULL
);
