-- Version 3.12: the forces map (src/forces.py), updated after the 04:00
-- report. One row per day: the bases with units, status and the nights'
-- findings, as JSON.
CREATE TABLE force_maps (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
