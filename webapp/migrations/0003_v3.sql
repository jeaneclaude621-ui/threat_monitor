-- Version 3: Web Push subscriptions and the home-screen flag per user.

-- One row per browser/device that asked for notifications. Rows are
-- deleted when the push service says the subscription is gone (404/410)
-- or the user turns notifications off.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prefs      TEXT            -- JSON object, e.g. {"report":true,"alarm":true}
);
CREATE INDEX push_subscriptions_email ON push_subscriptions (email);

-- When the app was first seen running from the home screen, and on what.
ALTER TABLE users ADD COLUMN installed_at TEXT;
ALTER TABLE users ADD COLUMN platform TEXT;
