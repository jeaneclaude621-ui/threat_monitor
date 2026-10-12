-- Version 3.4: scheduled runs. schedule/run_job.py reports each run of the
-- daily report and the hourly monitor - from the Mac or GitHub Actions -
-- when it starts and when it ends (PUT /api/ingest/runs/<id>), so the
-- admin status page can show whether they keep running.
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,              -- daily | hourly
  host        TEXT NOT NULL,              -- mac | cloud
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,              -- running | ok | failed
  exit_code   INTEGER,
  warnings    TEXT NOT NULL DEFAULT '[]', -- JSON array of the run's "!" lines
  log_url     TEXT                        -- the GitHub Actions run, if any
);
CREATE INDEX runs_job_started ON runs (job, started_at);
