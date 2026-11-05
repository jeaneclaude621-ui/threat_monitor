-- Version 3.22: someone who has proved an address through Access but has
-- no account asks for one (POST /api/access-request). Only the address and
-- the time are kept; an admin approves (a reader account) or denies.
CREATE TABLE access_requests (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  ts         TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'requested'
             CHECK (status IN ('requested', 'approved', 'denied')),
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX access_requests_email ON access_requests (email, ts);
CREATE INDEX access_requests_status ON access_requests (status, ts);
