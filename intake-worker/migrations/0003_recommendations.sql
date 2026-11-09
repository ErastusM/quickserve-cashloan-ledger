-- Credit analysts approve up to their limit; above it they recommend and an
-- owner decides.
ALTER TABLE applications ADD COLUMN recommendation TEXT;        -- approve | decline
ALTER TABLE applications ADD COLUMN recommendation_note TEXT;
ALTER TABLE applications ADD COLUMN recommended_by TEXT;
ALTER TABLE applications ADD COLUMN recommended_at TEXT;
