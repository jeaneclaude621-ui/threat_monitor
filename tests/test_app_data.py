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


class Independence(unittest.TestCase):
    def count(self, *arts):
        return app_data.independent_sources([dict(zip(("outlet", "title", "text", "url"), a)) for a in arts])

    def test_one_ap_text_in_many_papers_is_one(self):
        self.assertEqual(self.count(
            ("AP", "Drones spotted over Danish airport", "", "https://apnews.com/x"),
            ("Washington Post", "Drones spotted over Danish airport, police say", "COPENHAGEN (AP) - Police said", ""),
            ("ABC News", "Police: drones seen over airport in Denmark", "COPENHAGEN (AP) - Police", ""),
            ("Seattle Times", "Drones spotted over Danish airport", "", "")), 1)

    def test_aggregators_are_one_origin(self):
        self.assertEqual(self.count(
            ("MSN", "Russia warns Baltic states", "", "https://www.msn.com/a"),
            ("Yahoo News", "Kremlin issues warning to Baltics", "", "https://news.yahoo.com/b"),
            ("Devdiscourse", "Moscow sends message to Baltic capitals", "", "https://www.devdiscourse.com/c")), 1)

    def test_independent_outlets_and_social(self):
        self.assertEqual(self.count(
            ("Reuters", "Cable damaged in Baltic Sea", "", ""),
            ("ERR", "Estonia investigates undersea cable", "", ""),
            ("YouTube", "Cable footage", "", "https://youtube.com/watch?v=1"),
            ("Reuters", "Finland seizes ship after cable break", "", "")), 2)

    def test_stored_per_event(self):
        ev = app_data.enrich_events([event({"ref": "A1"}, {"ref": "A2"}, {"ref": "A3"})], "2026-11-05", LIST)[0]
        self.assertEqual(ev["independent_sources"], 2)
        ev = app_data.enrich_events([event({"ref": "A3"})], "2026-11-05", LIST)[0]
        self.assertEqual(ev["independent_sources"], 0)


class Credibility(unittest.TestCase):
    def test_tier_from_config_not_model(self):
        self.assertEqual(app_data.source_tier("BBC", None, "BBC World"), 1)          # feeds.json
        self.assertEqual(app_data.source_tier("TT", "https://www.tt.se/x"), 1)        # named_sources
        self.assertEqual(app_data.source_tier("X", "https://news.err.ee/1"), 2)       # outlet_tiers domain
        self.assertEqual(app_data.source_tier("Kyiv Independent"), 3)
        self.assertIsNone(app_data.source_tier("Some Blog", "https://someblog.example/x"))
        ev = app_data.enrich_events([event({"ref": "A1", "tier": 4})], "2026-11-05", LIST)[0]
        self.assertEqual(ev["articles"][0]["tier"], 1)

    def cap(self, score, *outlets):
        results = [{"ref": f"A{n}", "url": f"https://site{n}.example/a", "title": ["Drones seen over air base", "Moscow denies involvement",
                    "Estonia summons ambassador", "Police investigate"][n - 1],
                    "outlet": o, "published": "2026-11-05", "via": "google"} for n, o in enumerate(outlets, 1)]
        ev = event(*({"ref": r["ref"]} for r in results))
        ev["score"] = score
        return app_data.enrich_events([ev], "2026-11-05", results)[0]

    def test_one_tier1_source_max_6(self):
        ev = self.cap(9, "Reuters")
        self.assertEqual((ev["score"], ev["model_score"]), (6, 9))
        self.assertIn("en oberoende källa", ev["score_capped_reason"])

    def test_one_tier3_source_max_5(self):
        self.assertEqual(self.cap(8, "Kyiv Independent")["score"], 5)
        self.assertEqual(self.cap(8, "Unknown Local Site")["score"], 5)

    def test_seven_needs_two_origins_one_tier_1_2(self):
        self.assertEqual(self.cap(8, "Kyiv Independent", "Meduza")["score"], 6)
        self.assertEqual(self.cap(8, "Reuters", "Meduza")["score"], 8)
        self.assertNotIn("score_capped_reason", self.cap(8, "Reuters", "Meduza"))

    def test_nine_needs_three(self):
        self.assertEqual(self.cap(9.5, "Reuters", "Meduza")["score"], 8)
        self.assertEqual(self.cap(9.5, "Reuters", "Meduza", "ERR News")["score"], 9.5)

    def test_syndicated_copies_do_not_lift_the_cap(self):
        results = [{"ref": f"A{n}", "url": f"https://site{n}.example/a", "title": "Drones over Danish airport",
                    "outlet": o, "published": "2026-11-05", "via": "google"}
                   for n, o in enumerate(("AP", "Washington Post", "Guardian"), 1)]
        ev = event(*({"ref": r["ref"]} for r in results))
        ev["score"] = 9
        ev = app_data.enrich_events([ev], "2026-11-05", results)[0]
        self.assertEqual((ev["independent_sources"], ev["score"]), (1, 6))

    def test_unverified_max_4(self):
        self.assertEqual(self.cap(7)["score"], 4)


class KnownWithRefs(unittest.TestCase):
    def run_one(self, known):
        ev = event({"ref": "A1"}, {"ref": "A2"}, {"ref": "A99"}, known_sv=known)
        return app_data.enrich_events([ev], "2026-11-05", LIST)[0]

    def test_sentences_carry_verified_article_ids(self):
        ev = self.run_one([{"text": "Drönare sågs över basen.", "refs": ["A1", "A2"]},
                           {"text": "Påhittad uppgift.", "refs": ["A99"]},
                           {"text": "Utan ref.", "refs": []},
                           {"text": "Delvis verifierad.", "refs": ["[A2]", "A99"]},
                           "En bar sträng utan ref."])
        ids = {a["title"]: a["id"] for a in ev["articles"]}
        self.assertEqual(ev["known_sv"], [
            {"text": "Drönare sågs över basen.", "refs": [ids["Drones seen over base"], ids["Drönare över basen"]]},
            {"text": "Delvis verifierad.", "refs": [ids["Drönare över basen"]]}])

    def test_old_string_format_still_works(self):
        ev = self.run_one(["Drönare sågs.", "", "Basen stängdes."])
        self.assertEqual(ev["known_sv"], ["Drönare sågs.", "Basen stängdes."])

    def test_refs_to_dropped_blocked_articles_do_not_count(self):
        results = LIST + [{"ref": "A4", "url": "https://tass.com/x", "title": "Kremlin", "outlet": "TASS",
                           "published": "2026-11-05", "via": "gdelt"}]
        ev = event({"ref": "A4"}, known_sv=[{"text": "Enligt TASS ...", "refs": ["A4"]}])
        ev = app_data.enrich_events([ev], "2026-11-05", results)[0]
        self.assertEqual(ev["known_sv"], [])


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
