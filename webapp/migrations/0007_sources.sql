-- Version 3.5: sources added in the app. An admin pastes a link; the
-- Worker decides whether it is an RSS/Atom feed or a single article. The
-- scheduled jobs read the active rows (GET /api/export/sources): feeds
-- join config/feeds.json, articles are read by the next runs.
CREATE TABLE sources (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,                 -- rss | article
  url       TEXT NOT NULL,
  title     TEXT,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sources_active ON sources (active, added_at);
