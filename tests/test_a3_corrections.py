"""Self-check: corrections on yesterday's report (#8) and an accuracy
counted in code (#10) (lansering A3, 2)."""
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import common  # noqa: E402
import daily_report  # noqa: E402

LIST = [{"ref": "A1", "url": "https://www.reuters.com/world/europe/denied-1", "title": "Ministry denies drone claim",
         "outlet": "Reuters", "published": "2026-11-05", "via": "google"}]


class Pool:
    items = []


def yesterday():
    return {"date": "2026-11-04", "events": [
        {"id": "2026-11-04-e1", "title": "Drones over base", "detail": "d", "score": 7},
        {"id": "2026-11-04-e2", "title": "Cable cut", "detail": "d", "score": 6},
        {"id": "2026-11-04-e3", "title": "Talks", "detail": "d", "score": 6}]}


class SelfCheck(unittest.TestCase):
    def run_check(self, answer):
        state = {"self_eval_log": []}

        class FakePool:
            def __init__(self):
                self.items = []

            def add(self, items):
                return self

            def prompt_block(self, n):
                common.LAST_SEARCH_RESULTS[:] = LIST
                return "[A1] Reuters · x"
        with mock.patch.object(daily_report.news_sources, "Pool", FakePool), \
                mock.patch.object(daily_report.news_sources, "google_news", lambda *a, **k: []), \
                mock.patch.object(daily_report, "ask_model_json", lambda *a, **k: answer):
            return daily_report.run_self_check(state, yesterday(), Pool()), state

    def test_accuracy_counted_in_code_not_taken_from_model(self):
        out, state = self.run_check({"results": [
            {"id": "2026-11-04-e1", "outcome": "CONTRADICTED", "note": "denied", "note_sv": "Dementerat.",
             "refs": ["A1", "A9"]},
            {"id": "2026-11-04-e2", "outcome": "CONFIRMED", "note": "ok", "refs": ["A1"]},
            {"id": "2026-11-04-e3", "outcome": "UNRESOLVED", "note": "?"},
            {"id": "made-up", "outcome": "CONFIRMED"}],
            "accuracy_pct": 99, "confirmed_count": 7})
        self.assertEqual(out["log_entry"]["accuracy_pct"], 50)
        self.assertEqual((out["log_entry"]["confirmed"], out["log_entry"]["contradicted"],
                          out["log_entry"]["unresolved"]), (1, 1, 1))
        self.assertEqual(state["self_eval_log"], [out["log_entry"]])
        first = out["results"][0]
        self.assertEqual(first["note_sv"], "Dementerat.")
        self.assertEqual([a["url"] for a in first["refs"]], [LIST[0]["url"]])

    def test_nothing_resolved_gives_no_accuracy(self):
        self.assertIsNone(daily_report.self_check_counts([{"outcome": "UNRESOLVED"}])["accuracy_pct"])
        self.assertIsNone(daily_report.self_check_counts([])["accuracy_pct"])


class Corrections(unittest.TestCase):
    REF = [{"id": "x", "outlet": "Reuters", "url": LIST[0]["url"], "title": "t", "tier": 1}]

    def test_correction_on_contradicted_event_only(self):
        rep = yesterday()
        n = daily_report.apply_corrections(rep, [
            {"event_id": "2026-11-04-e1", "outcome": "CONTRADICTED", "note_sv": "Dementerat.", "refs": self.REF},
            {"event_id": "2026-11-04-e2", "outcome": "CONFIRMED", "note_sv": "Ja.", "refs": self.REF},
            {"event_id": "2026-11-04-e3", "outcome": "CONTRADICTED", "note_sv": "Utan källa.", "refs": []}],
            "2026-11-05")
        self.assertEqual(n, 1)
        self.assertEqual(rep["events"][0]["correction"],
                         {"date": "2026-11-05", "note_sv": "Dementerat.", "refs": self.REF})
        self.assertNotIn("correction", rep["events"][1])
        self.assertNotIn("correction", rep["events"][2])

    def test_saved_report_is_rewritten_and_uploaded(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "2026-11-04_report_data.json").write_text(json.dumps(yesterday()), encoding="utf-8")
            pushed = []
            with mock.patch.object(daily_report, "OUTPUT_DIR", out), \
                    mock.patch.object(daily_report, "push_report", lambda r: pushed.append(r) or True):
                ok = daily_report.publish_corrections(
                    [{"event_id": "2026-11-04-e2", "outcome": "CONTRADICTED", "note_sv": "Nej.", "refs": self.REF}],
                    date(2026, 11, 5))
            self.assertTrue(ok)
            saved = json.loads((out / "2026-11-04_report_data.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["events"][1]["correction"]["note_sv"], "Nej.")
            self.assertEqual(pushed, [saved])

    def test_no_contradiction_no_upload(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "2026-11-04_report_data.json").write_text(json.dumps(yesterday()), encoding="utf-8")
            with mock.patch.object(daily_report, "OUTPUT_DIR", out), \
                    mock.patch.object(daily_report, "push_report", lambda r: self.fail("uploaded")):
                self.assertFalse(daily_report.publish_corrections(
                    [{"event_id": "2026-11-04-e1", "outcome": "CONFIRMED", "refs": self.REF}], date(2026, 11, 5)))


if __name__ == "__main__":
    unittest.main()
