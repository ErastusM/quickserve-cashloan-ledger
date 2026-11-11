-- After approval the applicant, on their tracking page: accepts the
-- Pre-Agreement Statement, gives their bank details and address, and signs
-- the loan agreement electronically. The loan is paid into a bank account or
-- sent to an e-wallet (cellphone number). Staff can also enter the bank details.
ALTER TABLE applications ADD COLUMN accepted_at TEXT;
ALTER TABLE applications ADD COLUMN accepted_name TEXT;
ALTER TABLE applications ADD COLUMN accepted_statement_key TEXT;
ALTER TABLE applications ADD COLUMN payout_method TEXT;
ALTER TABLE applications ADD COLUMN ewallet_provider TEXT;
ALTER TABLE applications ADD COLUMN ewallet_number TEXT;
ALTER TABLE applications ADD COLUMN bank_name TEXT;
ALTER TABLE applications ADD COLUMN bank_account_holder TEXT;
ALTER TABLE applications ADD COLUMN bank_account_no TEXT;
ALTER TABLE applications ADD COLUMN bank_branch_code TEXT;
ALTER TABLE applications ADD COLUMN bank_account_type TEXT;
ALTER TABLE applications ADD COLUMN physical_address TEXT;
ALTER TABLE applications ADD COLUMN bank_saved_at TEXT;
ALTER TABLE applications ADD COLUMN bank_saved_by TEXT;
ALTER TABLE applications ADD COLUMN agreement_key TEXT;
ALTER TABLE applications ADD COLUMN agreement_sent_at TEXT;
ALTER TABLE applications ADD COLUMN agreement_signed_key TEXT;
ALTER TABLE applications ADD COLUMN agreement_signed_at TEXT;
ALTER TABLE applications ADD COLUMN agreement_signed_name TEXT;
