-- Version 3.10: the Swedish authorities' brief (src/authorities.py), apart
-- from the analysis. One row per run, the brief as JSON; the newest 60 are
-- kept.
CREATE TABLE authority_briefs (
  generated_at TEXT PRIMARY KEY,
  data         TEXT NOT NULL
);
