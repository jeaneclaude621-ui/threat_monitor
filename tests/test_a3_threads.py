"""Thread monitor with sources (#14): a numbered list per thread, refs
per update, nothing to the app without a verified ref, snapshot history
(lansering A3, 3)."""
import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import hourly_monitor  # noqa: E402
import news_sources  # noqa: E402


def item(n, day, outlet="Reuters"):
    return {"link": f"https://www.reuters.com/world/europe/story-{n}", "title": f"Story {n}",
            "source": outlet, "published": datetime(2026, 11, day, 9), "via": "google"}


class ThreadList(unittest.TestCase):
    def test_list_numbered_as_prompt_block(self):
        pool = news_sources.Pool().add([item(1, 3), item(2, 5), item(3, 4)])
        block = pool.prompt_block(60, record=False)
        listed = hourly_monitor.listed_articles(pool)
        self.assertEqual([x["ref"] for x in listed], ["A1", "A2", "A3"])
        for x in listed:
            self.assertIn(f"[{x['ref']}] {x['outlet']}", block)
            line = next(l for l in block.splitlines() if l.startswith(f"[{x['ref']}]"))
            self.assertIn(x["title"], line)

    def test_verified_refs(self):
        listed = hourly_monitor.listed_articles(news_sources.Pool().add([item(1, 5)]))
        refs = hourly_monitor.verified_refs(["A1", "A7"], "2026-11-05", listed)
        self.assertEqual([r["url"] for r in refs], [listed[0]["url"]])
        self.assertEqual(hourly_monitor.verified_refs(["A7"], "2026-11-05", listed), [])
        self.assertEqual(hourly_monitor.verified_refs(None, "2026-11-05", listed), [])


class Snapshots(unittest.TestCase):
    def test_history_kept(self):
        t = {"last_snapshot": "old"}
        hourly_monitor.update_snapshot(t, "new", "2026-11-05T12:00")
        hourly_monitor.update_snapshot(t, "new", "2026-11-05T21:00")
        hourly_monitor.update_snapshot(t, "newer", "2026-11-06T12:00")
        self.assertEqual(t["last_snapshot"], "newer")
        self.assertEqual([h["snapshot"] for h in t["snapshot_history"]], ["old", "new"])
        self.assertEqual(t["snapshot_history"][1]["since"], "2026-11-05T12:00")

    def test_history_capped(self):
        t = {"last_snapshot": "s0"}
        for i in range(1, hourly_monitor.SNAPSHOT_HISTORY + 10):
            hourly_monitor.update_snapshot(t, f"s{i}", f"t{i}")
        self.assertEqual(len(t["snapshot_history"]), hourly_monitor.SNAPSHOT_HISTORY)


class RunOnce(unittest.TestCase):
    def test_only_updates_with_verified_ref_reach_the_app(self):
        state = {"watchlist": [
            {"id": "a", "label": "Thread A", "last_snapshot": "A0", "last_checked": None},
            {"id": "b", "label": "Thread B", "last_snapshot": "B0", "last_checked": None}],
            "outlet_scores": {}, "author_scores": {}}
        answer = {"threads": {
            "a": {"classification": "NEW_DEVELOPMENT", "outlets": ["Reuters"], "refs": ["A1"],
                  "summary": "s", "title_sv": "t", "summary_sv": "s", "new_snapshot": "A1"},
            "b": {"classification": "NEW_DEVELOPMENT", "outlets": ["X"], "refs": ["A9"],
                  "summary": "s", "new_snapshot": "B1"}}}
        pushed, logged, prompts = [], [], []

        def ask(prompt, **k):
            prompts.append(prompt)
            return answer
        with mock.patch.object(hourly_monitor, "load_state", lambda: state), \
                mock.patch.object(hourly_monitor, "save_state", lambda s: None), \
                mock.patch.object(hourly_monitor, "check_replies", lambda s: None), \
                mock.patch.object(hourly_monitor.news_sources, "app_sources", lambda: []), \
                mock.patch.object(hourly_monitor.news_sources, "all_feeds", lambda app: []), \
                mock.patch.object(hourly_monitor.news_sources, "for_thread",
                                  lambda t, f, a: news_sources.Pool().add([item(1, 5)])), \
                mock.patch.object(hourly_monitor.feed_prefilter, "check", lambda *a, **k: ({}, [])), \
                mock.patch.object(hourly_monitor.feed_prefilter, "record_shadow", lambda *a: None), \
                mock.patch.object(hourly_monitor, "append_hourly_entry", lambda e, when=None: logged.append(e)), \
                mock.patch.object(hourly_monitor, "ask_model_json", ask), \
                mock.patch.object(hourly_monitor, "push_updates", lambda rows: pushed.extend(rows)):
            hourly_monitor.run_once()
        self.assertIn("[A1] Reuters", prompts[0])
        self.assertEqual([u["thread_id"] for u in pushed], ["a"])
        self.assertEqual(pushed[0]["refs"][0]["url"], item(1, 5)["link"])
        self.assertEqual([e["thread_id"] for e in logged], ["a", "b"])
        self.assertEqual(logged[1]["refs"], [])
        self.assertEqual(state["watchlist"][0]["snapshot_history"][0]["snapshot"], "A0")
        self.assertEqual(state["watchlist"][1]["last_snapshot"], "B1")


if __name__ == "__main__":
    unittest.main()
