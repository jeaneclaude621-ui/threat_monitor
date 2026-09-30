-- Version 2: the app decides who gets in (Access only proves the email),
-- plus read state, the live update feed and the admin/security logs.

-- Who may use the app. Rows are never deleted: removing a user sets
-- active = 0, so their assessments keep a known author. OWNER (a Worker
-- var) is always an admin whatever this table says.
CREATE TABLE users (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT,
  created_by TEXT,
  last_seen  TEXT,
  prev_visit TEXT   -- last_seen as it was before the current visit began
);

-- Every change to users, by whom. Append-only.
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Refused and suspicious requests. Pruned after 90 days by the Worker.
CREATE TABLE security_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  email      TEXT,
  ip_country TEXT,
  path       TEXT,
  method     TEXT,
  reason     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX security_log_ts ON security_log (ts);

-- What each user has read: event ids (2026-09-30-e1) and update ids.
CREATE TABLE reads (
  email   TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ts      TEXT NOT NULL,
  PRIMARY KEY (email, item_id)
);

-- The live feed: the Mac's hourly monitor, uploaded as it runs.
CREATE TABLE updates (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  thread_id      TEXT,
  thread_label   TEXT,
  classification TEXT,
  title_sv       TEXT,
  summary_sv     TEXT,
  outlets        TEXT,   -- JSON array
  report_date    TEXT
);
CREATE INDEX updates_ts ON updates (ts);

-- Small key/value facts for the status page (last_machine_pull_at).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
