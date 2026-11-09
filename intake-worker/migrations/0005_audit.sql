-- Audit trail: application events are permanent. Nothing can change an event,
-- and events can only be removed together with an application that was never
-- handed in (the 7-day clean-up of abandoned drafts).
CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON application_events
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON application_events
WHEN COALESCE((SELECT status FROM applications WHERE id = OLD.application_id), 'draft') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be deleted');
END;

CREATE INDEX IF NOT EXISTS idx_events_at    ON application_events (at);
CREATE INDEX IF NOT EXISTS idx_events_actor ON application_events (actor, at);
CREATE INDEX IF NOT EXISTS idx_events_type  ON application_events (type, at);
