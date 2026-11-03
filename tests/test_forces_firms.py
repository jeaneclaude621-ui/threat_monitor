"""Offline tests for src/forces_firms.py with a saved FIRMS answer (a
made-up CSV in FIRMS's format, near Mozdok air base). No network.

    python3 -m unittest discover -s tests
"""
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import forces_firms  # noqa: E402

CSV = (ROOT / "tests" / "data" / "firms_sample.csv").read_text(encoding="utf-8")
LAT, LON = 43.7875, 44.6031


def state(day="2026-10-30"):
    return {"bases": [{"name": "Mozdok", "lat": LAT, "lon": LON,
                       "events": [{"date": day, "kind": "anfallen", "text_sv": "x"},
                                  {"date": day, "kind": "uppföljning", "text_sv": "y"}]}]}


class Firms(unittest.TestCase):
    def test_parse_and_match(self):
        rows = forces_firms.parse(CSV)
        self.assertEqual(len(rows), 4)
        hit = forces_firms.match(rows, LAT, LON, date(2026, 10, 30))
        # Two points within 3 km in the 48 hours; the one 13 km away and the
        # one three days earlier are not counted.
        self.assertEqual(hit, {"date": "2026-10-30", "count": 2, "confidence": "hög"})

    def test_error_text_is_not_csv(self):
        self.assertEqual(forces_firms.parse("Invalid MAP_KEY."), [])

    def test_no_key_does_nothing(self):
        st = state()
        calls = []
        n = forces_firms.run(st, today=date(2026, 11, 1), key="", get=lambda u: calls.append(u) or CSV)
        self.assertEqual((n, calls), (0, []))
        self.assertNotIn("firms", st["bases"][0]["events"][0])

    def test_run_marks_the_attack(self):
        st = state()
        urls = []
        n = forces_firms.run(st, today=date(2026, 11, 1), key="TEST", get=lambda u: urls.append(u) or CSV)
        self.assertEqual(n, 1)
        self.assertEqual(st["bases"][0]["events"][0]["firms"]["count"], 2)   # the same rows from each satellite source count once
        self.assertNotIn("firms", st["bases"][0]["events"][1])               # follow-ups are not checked
        self.assertTrue(all("/TEST/" in u and "/2/2026-10-30" in u for u in urls))

    def test_old_attacks_are_not_checked(self):
        st = state("2026-10-01")
        self.assertEqual(forces_firms.pending(st, date(2026, 11, 1)), [])

    def test_miss_is_final_after_the_window(self):
        st = state("2026-10-29")
        forces_firms.run(st, today=date(2026, 11, 1), key="TEST", get=lambda u: "latitude,longitude,acq_date\n")
        self.assertIsNone(st["bases"][0]["events"][0]["firms"])


if __name__ == "__main__":
    unittest.main()
