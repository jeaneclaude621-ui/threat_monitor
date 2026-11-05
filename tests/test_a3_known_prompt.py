"""The sweep's prompt asks for known_sv as [{text, refs}] (lansering A3, 6)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import app_data  # noqa: E402
import daily_report  # noqa: E402


class KnownPrompt(unittest.TestCase):
    def test_fields_ask_for_refs(self):
        self.assertIn('{"text": "...", "refs": ["A3"]}', daily_report.SWEEP_EVENT_FIELDS)
        self.assertNotIn(daily_report._KNOWN_FIELD, daily_report.SWEEP_EVENT_FIELDS)
        self.assertIn('"known_sv": [{"text": "...", "refs": ["A1"]}]', daily_report.SWEEP_EVENT_JSON)
        # The rest of app_data's event fields unchanged.
        self.assertIn('"unknown_sv"', daily_report.SWEEP_EVENT_FIELDS)
        self.assertIn('"articles": [{"ref": "A1"', daily_report.SWEEP_EVENT_JSON)

    def test_answer_in_that_form_keeps_verified_refs(self):
        listed = [{"ref": "A1", "url": "https://www.reuters.com/world/x", "title": "t", "outlet": "Reuters",
                   "published": "2026-11-05", "via": "google"}]
        ev = {"title": "x", "score": 5, "articles": [{"ref": "A1", "outlet": "Reuters"}],
              "known_sv": [{"text": "Fastställt.", "refs": ["A1"]}, {"text": "Påhittat.", "refs": ["A5"]}]}
        app_data.enrich_events([ev], "2026-11-05", listed)
        self.assertEqual(ev["known_sv"], [{"text": "Fastställt.", "refs": [ev["articles"][0]["id"]]}])


if __name__ == "__main__":
    unittest.main()
