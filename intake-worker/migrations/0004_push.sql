-- Staff devices that asked for a notification on every new application.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,        -- SHA-256 of the endpoint
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  staff_email TEXT NOT NULL,
  device      TEXT,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0
);
