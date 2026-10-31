-- Version 3.9: the trends feed (src/trends.py), apart from the analysis.
-- Two sides: 'open' (Wikipedia, Google Trends, Reddit, Mastodon, Bluesky)
-- and 'ru' (Russian state and pro-Kremlin Telegram channels). Items are
-- upserted by id at each run and pruned after 30 days; one summary row per
-- day holds both sides' Swedish text.
CREATE TABLE trends (
  id          TEXT PRIMARY KEY,
  side        TEXT NOT NULL,              -- open | ru
  source      TEXT NOT NULL,              -- wikipedia | google_trends | reddit | mastodon | bluesky | telegram
  place       TEXT,                       -- sv.wikipedia, SE, r/europe, @rybar ...
  title       TEXT NOT NULL,
  title_sv    TEXT,
  url         TEXT,
  detail      TEXT,
  metric      REAL,
  spike       REAL,
  metric_sv   TEXT,
  published   TEXT,
  thread_id   TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX trends_side_seen ON trends (side, last_seen);
CREATE TABLE trend_summaries (
  date     TEXT PRIMARY KEY,
  open_sv  TEXT,
  ru_sv    TEXT
);
