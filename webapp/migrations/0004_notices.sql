-- Version 3.2: in-app announcements from admins, optionally pushed.
CREATE TABLE notices (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  author     TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL
);
CREATE INDEX notices_active ON notices (active, expires_at);
