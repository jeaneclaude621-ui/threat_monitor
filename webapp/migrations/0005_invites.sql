-- Version 3.3: invitation emails. The Worker cannot send mail itself, so
-- adding a user queues a row here; the Mac picks pending rows up
-- (GET /api/export/invites), mails them over its SMTP account and reports
-- back (PUT /api/ingest/invites/<id>).
CREATE TABLE invites (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | cancelled
  sent_at      TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invites_status ON invites (status, requested_at);
CREATE INDEX invites_email ON invites (email, requested_at);
