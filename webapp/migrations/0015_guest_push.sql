-- Version 3.23: guests may subscribe to Web Push. A guest's subscription
-- has email NULL (the endpoint is the key), so the NOT NULL goes: SQLite
-- cannot drop it in place, hence the copy. Each subscription may follow
-- topics and countries (JSON lists; empty or NULL = everything).
CREATE TABLE push_subscriptions_new (
  endpoint   TEXT PRIMARY KEY,
  email      TEXT,              -- NULL: a guest
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prefs      TEXT,
  topics     TEXT,
  countries  TEXT
);
INSERT INTO push_subscriptions_new (endpoint, email, p256dh, auth, created_at, prefs)
  SELECT endpoint, email, p256dh, auth, created_at, prefs FROM push_subscriptions;
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
CREATE INDEX push_subscriptions_email ON push_subscriptions (email);
