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


class RealDates(unittest.TestCase):
    def test_model_date_is_overwritten(self):
        """An old story given today's date by the model keeps its real date."""
        results = [{"ref": "A1", "url": "https://www.bbc.com/news/old", "title": "Old story", "outlet": "BBC World",
                    "published": "2026-10-01", "via": "feed"}]
        ev = app_data.enrich_events([event({"ref": "A1", "outlet": "BBC", "published": "2026-11-05"})],
                                    "2026-11-05", results)[0]
        self.assertEqual(ev["articles"][0]["published"], "2026-10-01")

    def test_undated_only_from_the_app(self):
        results = [{"ref": "A1", "url": "https://example.org/a", "title": "Undated feed item", "outlet": "Example",
                    "published": None, "via": "feed"},
                   {"ref": "A2", "url": "https://example.org/b", "title": "Undated app article", "outlet": "Example",
                    "published": None, "via": "app"}]
        ev = app_data.enrich_events([event({"ref": "A1", "published": "2026-11-05"}, {"ref": "A2", "published": "2026-11-05"})],
                                    "2026-11-05", results)[0]
        self.assertEqual([a["title"] for a in ev["articles"]], ["Undated app article"])
        self.assertNotIn("published", ev["articles"][0])


class SocialNeverAlone(unittest.TestCase):
    def test_youtube_alone_is_unverified(self):
        ev = app_data.enrich_events([event({"ref": "A3", "outlet": "YouTube"})], "2026-11-05", LIST)[0]
        self.assertEqual([a["outlet"] for a in ev["articles"]], ["YouTube"])
        self.assertTrue(ev["unverified"])

    def test_youtube_beside_news_is_fine(self):
        ev = app_data.enrich_events([event({"ref": "A3"}, {"ref": "A1"})], "2026-11-05", LIST)[0]
        self.assertNotIn("unverified", ev)


class SocialNeverAloneInForces(unittest.TestCase):
    REFS = {"A1": {"url": "https://www.youtube.com/watch?v=x", "outlet": "YouTube", "title": "Video"},
            "A2": {"url": "https://kyivindependent.com/a", "outlet": "The Kyiv Independent", "title": "Report"}}

    def state(self):
        base = lambda i: {"id": i, "name": i, "curated": True, "events": [], "changes": [],  # noqa: E731
                          "units": [], "equipment": ["Su-34"]}
        return {"bases": [base("Q1"), base("Q2")]}

    def test_follow_ups_and_changes_need_a_news_source(self):
        from datetime import date
        import forces
        st = self.state()
        result = {"follow_ups": [{"base": "Q1", "text_sv": "Skador bekräftade", "refs": ["A1"]}],
                  "changes": [{"base": "Q1", "category": "materiel", "what": "Su-34", "kind": "flyttat",
                               "to_base": "Q2", "text_sv": "Flyttade", "refs": ["A1"]}]}
        night = forces.apply(st, result, self.REFS, date(2026, 11, 5))
        self.assertEqual((night["follow_ups"], night["changes"]), ([], []))
        self.assertEqual(st["bases"][0]["equipment"], ["Su-34"])
        for part in result.values():
            part[0]["refs"] = ["A1", "A2"]
        night = forces.apply(st, result, self.REFS, date(2026, 11, 5))
        self.assertEqual((len(night["follow_ups"]), len(night["changes"])), (1, 1))
        self.assertEqual(st["bases"][0]["equipment"], [])


class PoolDates(unittest.TestCase):
    def test_since(self):
        from datetime import datetime
        import news_sources
        p = news_sources.Pool().add([
            {"title": "fresh", "link": "https://a.example/x", "published": datetime(2026, 11, 5, 1), "via": "google"},
            {"title": "old", "link": "https://a.example/y", "published": datetime(2026, 10, 1), "via": "google"},
            {"title": "old link, fresh date", "link": "https://a.example/2025/03/14/story",
             "published": datetime(2026, 11, 5, 2), "via": "feed"},
            {"title": "undated feed", "link": "https://a.example/z", "published": None, "via": "feed"},
            {"title": "undated app", "link": "https://a.example/w", "published": None, "via": "app"},
        ]).since(datetime(2026, 11, 4, 4))
        self.assertEqual([a["title"] for a in p.items], ["fresh", "undated app"])
        p.prompt_block(10)
        import common
        dated = {r["title"]: r["published"] for r in common.LAST_SEARCH_RESULTS}
        self.assertEqual(dated, {"fresh": "2026-11-05", "undated app": None})


if __name__ == "__main__":
    unittest.main()
