"""A2 #17: FIRMS compares with the normal level the week before the
attack, and only counts "fire seen" when clearly above it. No network."""
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import forces_firms  # noqa: E402

LAT, LON = 47.7, 39.9
HEAD = "latitude,longitude,acq_date,acq_time,confidence\n"


def rows_csv(days_counts):
    """A CSV with `n` detections at the site on each given day."""
    lines = [f"{LAT + i * 0.0001},{LON},{d},{1000 + i},n" for d, n in days_counts for i in range(n)]
    return HEAD + "\n".join(lines) + "\n"


def site(day="2026-11-02"):
    o = {"place": "Raffinaderi", "date": day, "lat": LAT, "lon": LON, "precision": "site"}
    return o, {"bases": [], "nights": [{"date": day, "other": [o]}]}


class Baseline(unittest.TestCase):
    def test_fire_seen_rule(self):
        base0 = {"days": 7, "count": 0}
        base7 = {"days": 7, "count": 14}          # two a day: a flaring refinery
        self.assertTrue(forces_firms.fire_seen(1, base0))
        self.assertFalse(forces_firms.fire_seen(0, base0))
        self.assertFalse(forces_firms.fire_seen(5, base7))   # four expected in 48 h
        self.assertTrue(forces_firms.fire_seen(13, base7))

    def test_flaring_refinery_is_not_fire_seen(self):
        o, st = site()
        # Two a day every day in the week before, and two a day after.
        week = [(f"2026-10-{d}", 2) for d in range(26, 32)] + [("2026-11-01", 2)]
        text = rows_csv(week + [("2026-11-02", 2), ("2026-11-03", 2)])
        n = forces_firms.run(st, today=date(2026, 11, 5), key="k", get=lambda u: text)
        self.assertEqual(n, 0)
        self.assertIsNone(o["firms"])
        self.assertEqual(o["firms_normal"]["baseline"]["count"], 14)
        self.assertFalse(o["firms_normal"]["fire_seen"])

    def test_fire_above_normal_keeps_baseline(self):
        o, st = site()
        text = rows_csv([("2026-10-28", 1), ("2026-11-02", 6)])
        n = forces_firms.run(st, today=date(2026, 11, 5), key="k", get=lambda u: text)
        self.assertEqual(n, 1)
        self.assertEqual(o["firms"]["count"], 6)
        self.assertEqual(o["firms"]["baseline"], {"days": 7, "from": "2026-10-26", "to": "2026-11-01", "count": 1})
        self.assertTrue(o["firms"]["fire_seen"])

    def test_no_baseline_is_retried(self):
        o, st = site()

        def get(url):
            if "/2026-11-02" in url:
                return rows_csv([("2026-11-02", 3)])
            raise OSError("down")
        forces_firms.run(st, today=date(2026, 11, 5), key="k", get=get)
        self.assertNotIn("firms", o)

    def test_docstring_says_fire_seen(self):
        doc = forces_firms.__doc__.lower()
        self.assertIn("fire seen", doc)
        self.assertNotIn("satellite confirmation", doc)


if __name__ == "__main__":
    unittest.main()
