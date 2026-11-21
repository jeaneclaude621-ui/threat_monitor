-- Version 3.48: the incident log (src/incidents.py), the whole log as one
-- JSON document per day, the newest served at /api/incidents. A week kept.
CREATE TABLE IF NOT EXISTS incident_maps (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
