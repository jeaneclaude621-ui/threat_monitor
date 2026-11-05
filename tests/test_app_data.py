"""The report's events only show sources that were really fetched
(src/app_data.py, review 1 #1, #13, #15, #12)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import app_data  # noqa: E402

LIST = [
    {"ref": "A1", "url": "https://www.reuters.com/world/europe/drones-1", "title": "Drones seen over base",
     "outlet": "Reuters", "published": "2026-11-05", "via": "google"},
    {"ref": "A2", "url": "https://www.svt.se/nyheter/utrikes/x", "title": "Drönare över basen",
     "outlet": "SVT Utrikes", "published": "2026-11-04", "via": "feed"},
    {"ref": "A3", "url": "https://www.youtube.com/watch?v=abc", "title": "Video of drones",
     "outlet": "YouTube", "published": "2026-11-05", "via": "app"},
]


def event(*articles, **kw):
    return {"title": "Drones", "score": 7, "sources": "Reuters (Tier 1); Made Up Times (Tier 2)",
            "articles": list(articles), **kw}


class VerifiedOnly(unittest.TestCase):
    def run_one(self, ev, results=LIST):
        return app_data.enrich_events([ev], "2026-11-05", results)[0]

    def test_invented_ref_is_dropped(self):
        ev = self.run_one(event({"ref": "A1", "outlet": "Reuters", "title": "x", "tier": 1},
                                {"ref": "A99", "outlet": "Made Up Times", "title": "Invented", "tier": 2}))
        self.assertEqual([a["outlet"] for a in ev["articles"]], ["Reuters"])
        self.assertTrue(all(a["url"] for a in ev["articles"]))
        self.assertNotIn("unverified", ev)

    def test_only_invented_refs_marks_unverified_but_keeps_event(self):
        ev = self.run_one(event({"ref": "A99", "outlet": "Made Up Times", "title": "Invented"}))
        self.assertEqual(ev["articles"], [])
        self.assertTrue(ev["unverified"])
        self.assertEqual(ev["title"], "Drones")

    def test_sources_line_not_parsed_for_new_reports(self):
        ev = self.run_one({"title": "Drones", "score": 7, "sources": "Reuters (Tier 1); Made Up Times (Tier 2)"})
        self.assertEqual(ev["articles"], [])
        self.assertTrue(ev["unverified"])

    def test_list_title_and_outlet_win_over_the_model(self):
        ev = self.run_one(event({"ref": "A1", "outlet": "Associated Press", "title": "Model's own headline"}))
        self.assertEqual(ev["articles"][0]["title"], "Drones seen over base")
        self.assertEqual(ev["articles"][0]["outlet"], "Reuters")

    def test_model_short_name_kept_for_feed_section(self):
        ev = self.run_one(event({"ref": "A2", "outlet": "SVT"}))
        self.assertEqual(ev["articles"][0]["outlet"], "SVT")

    def test_url_match_still_works(self):
        ev = self.run_one(event({"url": "https://reuters.com/world/europe/drones-1/", "outlet": "Reuters"}))
        self.assertEqual(len(ev["articles"]), 1)

    def test_blocked_outlet_in_list_is_dropped(self):
        results = LIST + [{"ref": "A4", "url": "https://news.google.com/rss/articles/x", "title": "Kremlin",
                           "outlet": "TASS", "published": "2026-11-05", "via": "google"}]
        ev = self.run_one(event({"ref": "A4", "outlet": "TASS"}), results)
        self.assertEqual(ev["articles"], [])
        self.assertTrue(ev["unverified"])

    def test_backfill_keeps_outlets_unlinked_and_unverified(self):
        ev = app_data.enrich_events([{"title": "x", "sources": "Reuters (Tier 1); BBC (Tier 1)"}], "2026-09-01", None)[0]
        self.assertEqual([a["outlet"] for a in ev["articles"]], ["Reuters", "BBC"])
        self.assertTrue(all(a["url"] is None for a in ev["articles"]))
        self.assertTrue(ev["unverified"])


if __name__ == "__main__":
    unittest.main()
