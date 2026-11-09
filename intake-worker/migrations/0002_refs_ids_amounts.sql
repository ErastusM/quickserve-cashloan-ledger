-- Application numbers in the ledger's style with year and month:
-- QSA-2611-0001 (one counter per month, e.g. name 'application:2611').
CREATE TABLE IF NOT EXISTS counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

-- Foreign nationals apply with a passport.
ALTER TABLE applications ADD COLUMN id_type TEXT NOT NULL DEFAULT 'nam_id';   -- nam_id | passport
ALTER TABLE applications ADD COLUMN nationality TEXT;

-- Amounts above the standard limit are allowed but flagged for staff.
ALTER TABLE applications ADD COLUMN above_standard INTEGER NOT NULL DEFAULT 0;

-- The ledger's own references once the loan is created (QS-0054, QSL-0137).
ALTER TABLE applications ADD COLUMN ledger_client_ref TEXT;
ALTER TABLE applications ADD COLUMN ledger_loan_ref TEXT;
