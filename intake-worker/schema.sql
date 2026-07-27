-- QuickServe Cashloan — intake database (Cloudflare D1)
-- Apply with:
--   wrangler d1 execute quickserve-intake --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS applications (
  id              TEXT PRIMARY KEY,          -- reference, e.g. QS-ABC123
  created_at      TEXT NOT NULL,             -- ISO timestamp
  status          TEXT NOT NULL DEFAULT 'new', -- new | approved | declined

  full_name       TEXT,
  phone           TEXT,
  national_id     TEXT,
  address         TEXT,
  employer        TEXT,
  income          TEXT,

  kin_name        TEXT,
  kin_phone       TEXT,

  purpose         TEXT,
  repay_date      TEXT,
  consent         TEXT,

  doc_id_key      TEXT,   -- R2 object key: ID copy
  doc_bank_keys   TEXT,   -- JSON array of R2 object keys: bank statement pages
  doc_payslip_key TEXT,   -- R2 object key: payslip

  decided_at      TEXT,
  decided_note    TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_created ON applications (created_at DESC);
