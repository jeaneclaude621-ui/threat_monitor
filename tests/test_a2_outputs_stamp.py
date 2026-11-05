"""A2 #4: the courses, authorities and hourly outputs carry generated_by.
No network: the model call is replaced by one that records a call on the
reserve model, as common.ask_model does."""
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import common  # noqa: E402


def reserve_answer(answer):
    def ask(prompt, **k):
        common.MODEL_CALLS.append({"model": "lite-x", "requested": common.MODEL, "fallback": True})
        return answer
    return ask


class Outputs(unittest.TestCase):
    def setUp(self):
        common.MODEL_CALLS.clear()
        common.MODEL_CALLS.append({"model": common.MODEL, "requested": common.MODEL, "fallback": False})

    def tearDown(self):
        common.MODEL_CALLS.clear()

    def test_courses(self):
        import app_sync
        import courses
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(courses, "COURSES_PATH", Path(d) / "courses.json"), \
                mock.patch.object(courses, "AUTHORITIES_PATH", Path(d) / "none.json"), \
                mock.patch.object(courses, "ask_model_json", reserve_answer({"courses": []})), \
                mock.patch.object(app_sync, "push_courses", lambda s: True):
            courses.run({"date": "2026-11-05", "events": []}, [])
            saved = json.loads((Path(d) / "courses.json").read_text(encoding="utf-8"))
        g = saved["generated_by"]
        # Only the call made for the courses, not the earlier one.
        self.assertEqual((g["models"], g["fallback_used"], g["calls"]), (["lite-x"], True, 1))

    def test_authorities(self):
        import authorities
        with mock.patch.object(authorities, "ask_model_json", reserve_answer({})):
            brief = authorities.summarise({}, datetime(2026, 11, 5, 8))
        self.assertTrue(brief["generated_by"]["fallback_used"])
        self.assertEqual(brief["generated_by"]["models"], ["lite-x"])

    def test_hourly_entries(self):
        import hourly_monitor
        state = {"watchlist": [{"id": "t1", "label": "Thread one", "last_snapshot": "s"}]}
        entries = []
        answer = {"threads": {"t1": {"classification": "NEW_DEVELOPMENT", "summary": "x"}}}
        with mock.patch.object(hourly_monitor, "load_state", lambda: state), \
                mock.patch.object(hourly_monitor, "save_state", lambda s: None), \
                mock.patch.object(hourly_monitor, "check_replies", lambda s: None), \
                mock.patch.object(hourly_monitor.news_sources, "app_sources", lambda: []), \
                mock.patch.object(hourly_monitor.news_sources, "all_feeds", lambda app: []), \
                mock.patch.object(hourly_monitor.feed_prefilter, "check", lambda *a, **k: ({}, [])), \
                mock.patch.object(hourly_monitor.feed_prefilter, "record_shadow", lambda *a: None), \
                mock.patch.object(hourly_monitor.news_sources, "for_thread",
                                  lambda *a: mock.Mock(prompt_block=lambda n, record=False: "(none)")), \
                mock.patch.object(hourly_monitor, "lite_model", lambda: "lite-x"), \
                mock.patch.object(hourly_monitor, "ask_model_json", reserve_answer(answer)), \
                mock.patch.object(hourly_monitor, "append_hourly_entry", lambda e, when=None: entries.append(e)), \
                mock.patch.object(hourly_monitor, "push_updates", lambda u: True):
            hourly_monitor.run_once()
        self.assertEqual(entries[0]["generated_by"]["models"], ["lite-x"])
        self.assertTrue(entries[0]["generated_by"]["fallback_used"])


if __name__ == "__main__":
    unittest.main()
