-- Version 3.11: Russia's courses of action (src/courses.py), updated after
-- the 04:00 report. One row per day, the assessment as JSON.
CREATE TABLE course_assessments (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
