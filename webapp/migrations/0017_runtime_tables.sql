-- Version 3.46: the tables the Worker has made at runtime since Version
-- 3.38-3.43 (CREATE TABLE IF NOT EXISTS in worker.js), now as a migration
-- too, so the schema is in one place. IF NOT EXISTS: they exist already.
CREATE TABLE IF NOT EXISTS ai_usage (
  date    TEXT PRIMARY KEY,
  neurons REAL NOT NULL,
  calls   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_visits (
  day      TEXT NOT NULL,
  vid      TEXT NOT NULL,
  first_ts TEXT NOT NULL,
  hits     INTEGER NOT NULL,
  sections INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, vid)
);
CREATE TABLE IF NOT EXISTS hit_counts (
  day  TEXT NOT NULL,
  kind TEXT NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);
