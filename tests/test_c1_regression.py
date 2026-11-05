"""Regression tests with known cases (review docs/review/1-traffsakerhet.md, #11).

Each case is a saved article list and model answer in tests/fixtures/c1/,
run through the public functions: app_data.enrich_events,
news_sources.Pool, news_sources.blocked_source, forces.is_news and
common.extract_json. The tests describe the behaviour EXPECTED after the
launch fixes: only verified sources (#1), one block list on host and
outlet name (#3), the date check (#13) and social media never alone (#15).
Tests main does not meet by design are marked expectedFailure, so the
suite stays green; the comment says when the mark goes.
"""
import copy
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "c1"
sys.path.insert(0, str(ROOT / "src"))
import app_data  # noqa: E402
import common  # noqa: E402
import forces  # noqa: E402
import news_sources  # noqa: E402

DATE = "2026-11-05"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def enrich(case: dict, key: str = "events") -> list:
    # decode_google_link would ask Google; the tests run offline.
    with mock.patch.object(news_sources, "decode_google_link", side_effect=lambda u: u):
        return app_data.enrich_events(copy.deepcopy(case[key]), DATE, case["search_results"])


def pool_items(items: list) -> list:
    out = []
    for it in copy.deepcopy(items):
        if isinstance(it.get("published"), str):
            it["published"] = datetime.fromisoformat(it["published"])
        else:
            it.setdefault("published", None)
        out.append(it)
    return out


def _unconfirmed(ev: dict) -> bool:
    if ev.get("unconfirmed") is True or ev.get("unverified") is True or ev.get("verified") is False:
        return True
    text = " ".join(str(ev.get(k) or "") for k in ("status", "label", "flag", "badge_sv")).lower()
    return "obekräftad" in text or "unconfirmed" in text


def carried(events: list, title: str):
    """The event with this title if it is still published as confirmed."""
    for ev in events:
        if ev.get("title") == title and not _unconfirmed(ev):
            return ev
    return None


def outlets(ev: dict) -> list:
    return [a["outlet"] for a in ev.get("articles") or []]


class FabricatedRef(unittest.TestCase):
    case = fixture("fabricated_ref.json")

    def test_verified_article_keeps_its_link(self):
        ev = enrich(self.case)[0]
        reuters = [a for a in ev["articles"] if a["outlet"] == "Reuters"]
        self.assertEqual(reuters[0]["url"], self.case["search_results"][0]["url"])

    def test_fabricated_ref_never_gets_a_link(self):
        for ev in enrich(self.case):
            for a in ev["articles"]:
                if a["outlet"] == "BBC" or ev["title"].startswith("Cable"):
                    self.assertIsNone(a.get("url"))

    def test_fabricated_article_is_dropped(self):
        ev = carried(enrich(self.case), "Drones over Danish air base")
        self.assertEqual(outlets(ev), ["Reuters"])

    def test_event_with_only_fabricated_refs_is_not_carried(self):
        self.assertIsNone(carried(enrich(self.case), "Cable cut off Gotland"))


class TassViaGoogleNews(unittest.TestCase):
    case = fixture("tass_google_news.json")

    def test_tass_host_is_blocked(self):
        self.assertTrue(news_sources.blocked_source("https://tass.com/world/1999999"))

    def test_pool_refuses_tass_by_outlet_name(self):
        self.assertEqual(news_sources.Pool().add(pool_items(self.case["pool_items"])).items, [])

    def test_tass_article_never_reaches_the_app(self):
        for ev in enrich(self.case):
            self.assertNotIn("TASS", outlets(ev))


class LoneYouTube(unittest.TestCase):
    case = fixture("youtube_alone.json")

    def test_youtube_is_not_news(self):
        self.assertFalse(forces.is_news({"outlet": "YouTube", "url": "https://www.youtube.com/watch?v=x"}))
        self.assertTrue(forces.is_news({"outlet": "SVT", "url": "https://www.svt.se/nyheter/x"}))

    def test_youtube_beside_news_is_carried(self):
        ev = carried(enrich(self.case, "events_with_news"), "Navy investigates submarine report")
        self.assertIsNotNone(ev)
        self.assertIn("SVT", outlets(ev))

    def test_lone_youtube_does_not_carry_an_event(self):
        self.assertIsNone(carried(enrich(self.case), "Russian submarine off Stockholm"))


class SyndicatedAP(unittest.TestCase):
    case = fixture("ap_syndicated.json")

    def test_identical_titles_are_one_item(self):
        pool = news_sources.Pool().add(pool_items(self.case["pool_items_same_title"]))
        self.assertEqual(len(pool.items), 1)

    # By design the pool keeps syndicated copies; their common origin is
    # counted per event instead (test_one_origin_caps_the_score).
    @unittest.expectedFailure
    def test_varied_titles_same_ap_lead_are_one_origin(self):
        pool = news_sources.Pool().add(pool_items(self.case["pool_items_varied_titles"]))
        self.assertEqual(len(pool.items), 1)

    def test_one_origin_caps_the_score(self):
        ev = enrich(self.case)[0]
        self.assertLessEqual(ev["score"], 6)


class OldNewsNewDate(unittest.TestCase):
    case = fixture("old_news_new_date.json")

    def test_pool_since_drops_the_old_article(self):
        pool = news_sources.Pool().add(pool_items(self.case["pool_items"]))
        self.assertEqual(pool.since(datetime(2026, 11, 4)).items, [])

    def test_published_comes_from_the_article_not_the_model(self):
        art = enrich(self.case)[0]["articles"][0]
        self.assertEqual(art.get("published"), "2025-03-01")


class LiteModelShortened(unittest.TestCase):
    def test_truncated_json_is_refused(self):
        text = (FIXTURES / "lite_truncated.txt").read_text(encoding="utf-8")
        with mock.patch.object(common, "_dump_debug"):
            with self.assertRaises(ValueError):
                common.extract_json(text)

    def test_truncated_twice_raises_never_half_a_report(self):
        text = (FIXTURES / "lite_truncated.txt").read_text(encoding="utf-8")
        with mock.patch.object(common, "ask_model", return_value=text), mock.patch.object(common, "_dump_debug"):
            with self.assertRaises(ValueError):
                common.ask_model_json("prompt")

    def test_shortened_answer_does_not_crash(self):
        events = enrich(fixture("lite_shortened.json"))
        ev = carried(events, "Narva border queue")
        self.assertEqual(ev["articles"][0]["url"], "https://www.err.ee/1609999999/narva")

    def test_event_without_articles_is_not_carried(self):
        self.assertIsNone(carried(enrich(fixture("lite_shortened.json")), "Estonia border"))


if __name__ == "__main__":
    unittest.main()
