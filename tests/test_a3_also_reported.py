"""The sweep gives a varying number of events, and the stories that did
not make it as also_reported with verified refs only (lansering A3, 1)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import daily_report  # noqa: E402

LIST = [
    {"ref": "A1", "url": "https://www.reuters.com/world/europe/drones-1", "title": "Drones seen over base",
     "outlet": "Reuters", "published": "2026-11-05", "via": "google"},
    {"ref": "A2", "url": "https://www.svt.se/nyheter/utrikes/x", "title": "Drönare över basen",
     "outlet": "SVT Utrikes", "published": "2026-11-04", "via": "feed"},
]


class AlsoReported(unittest.TestCase):
    def test_verified_refs_become_articles(self):
        out = daily_report.verify_also_reported(
            [{"title_sv": "Drönare över basen", "refs": ["A2", "A99"]}], "2026-11-05", LIST)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["title_sv"], "Drönare över basen")
        self.assertEqual([a["url"] for a in out[0]["refs"]], [LIST[1]["url"]])
        self.assertTrue(out[0]["refs"][0]["id"])
        self.assertEqual(out[0]["refs"][0]["published"], "2026-11-04")

    def test_item_without_verified_ref_is_dropped(self):
        out = daily_report.verify_also_reported(
            [{"title_sv": "Påhittad", "refs": ["A99"]}, {"title_sv": "Utan ref"},
             {"refs": ["A1"]}, "skräp"], "2026-11-05", LIST)
        self.assertEqual(out, [])

    def test_article_cited_by_an_event_is_not_repeated(self):
        events = [{"articles": [{"url": LIST[0]["url"]}]}]
        out = daily_report.verify_also_reported(
            [{"title_sv": "Samma", "refs": ["A1"]}, {"title_sv": "Annan", "refs": "A2"}],
            "2026-11-05", LIST, events)
        self.assertEqual([x["title_sv"] for x in out], ["Annan"])

    def test_capped_in_number(self):
        items = [{"title_sv": f"t{i}", "refs": ["A1"]} for i in range(20)]
        self.assertEqual(len(daily_report.verify_also_reported(items, "2026-11-05", LIST)),
                         daily_report.ALSO_REPORTED_MAX)


class EventCount(unittest.TestCase):
    def test_limits(self):
        self.assertEqual(daily_report.SWEEP_EVENTS, 10)
        self.assertEqual(daily_report.SWEEP_EVENTS_TYPICAL, 6)
        self.assertEqual(daily_report.RESERVE_SWEEP_EVENTS, 4)


if __name__ == "__main__":
    unittest.main()
