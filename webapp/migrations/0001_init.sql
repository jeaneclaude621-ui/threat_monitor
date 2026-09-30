-- Reports: one row per day, the full report JSON in `data`.
CREATE TABLE reports (
  date             TEXT PRIMARY KEY,
  threat_index     REAL,
  threat_index_30d REAL,
  top_sv           TEXT,
  data             TEXT NOT NULL,
  updated_at       TEXT
);

-- Operator assessments: append-only. A change is a new row whose
-- `supersedes` points at the row it replaces.
CREATE TABLE assessments (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  operator    TEXT NOT NULL,
  article_id  TEXT NOT NULL,
  report_date TEXT NOT NULL,
  event_id    TEXT,
  outlet      TEXT,
  value       INTEGER NOT NULL CHECK (value BETWEEN -2 AND 2),
  supersedes  TEXT,
  client_id   TEXT UNIQUE
);

CREATE INDEX assessments_ts ON assessments (ts);
CREATE INDEX assessments_article ON assessments (article_id);

CREATE TRIGGER assessments_no_update BEFORE UPDATE ON assessments
BEGIN
  SELECT RAISE(ABORT, 'assessments are append-only');
END;

CREATE TRIGGER assessments_no_delete BEFORE DELETE ON assessments
BEGIN
  SELECT RAISE(ABORT, 'assessments are append-only');
END;
