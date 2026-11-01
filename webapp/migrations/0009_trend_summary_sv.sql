-- 1 Nov 2026: each trend's Swedish summary (src/trends.py puts every new
-- Russian post, and open items in other languages, into Swedish each run).
ALTER TABLE trends ADD COLUMN summary_sv TEXT;
