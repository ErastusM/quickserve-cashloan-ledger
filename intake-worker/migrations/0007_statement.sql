-- The Pre-Agreement Statement as issued to the applicant (stored in R2), so
-- they can open it from the tracking page and we keep a record of exactly
-- what was disclosed and when.
ALTER TABLE applications ADD COLUMN statement_key TEXT;
ALTER TABLE applications ADD COLUMN statement_issued_at TEXT;
