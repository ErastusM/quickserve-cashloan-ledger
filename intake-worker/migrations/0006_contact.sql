-- Whether the applicant still has to be told about the latest change
-- (info request, approval or decline) on WhatsApp. Cleared when staff confirm
-- they sent the message.
ALTER TABLE applications ADD COLUMN contact_pending TEXT;   -- info_requested | approved | declined
