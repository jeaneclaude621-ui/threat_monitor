-- Version 3.13: Russia's air attacks on Ukraine (src/strikes.py), per
-- night from the Kaggle dataset, refreshed after the 04:00 report. One row
-- per day, the last 30 nights as JSON.
CREATE TABLE strike_maps (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
