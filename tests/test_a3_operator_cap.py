"""The operator's adjustment of an event's score stays within the
credibility cap its verified sources carry (lansering A3, 4)."""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import operator_weight  # noqa: E402

NOW = datetime(2026, 11, 5, tzinfo=timezone.utc)


def verdict(value, article="a1"):
    return {"id": f"v{article}{value}", "operator": "op", "article_id": article, "outlet": "Reuters",
            "value": value, "ts": "2026-11-05T06:00:00Z"}


def event(model, score, independent, tier=1):
    return {"model_score": model, "score": score, "independent_sources": independent,
            "articles": [{"id": "a1", "outlet": "Reuters", "url": "https://www.reuters.com/x", "tier": tier}]}


class OperatorCap(unittest.TestCase):
    def test_plus_cannot_lift_above_cap(self):
        ev = event(6, 6, 1)          # one independent tier-1 source: at most 6
        operator_weight.apply_to_events([ev], [verdict(2)], NOW)
        self.assertEqual(ev["score"], 6)
        self.assertTrue(ev["operator"]["capped"])
        self.assertTrue(ev["score_capped_reason"])

    def test_model_above_cap_stays_capped_after_adjustment(self):
        ev = event(9, 6, 1)          # already capped from 9 to 6 by app_data
        operator_weight.apply_to_events([ev], [verdict(-1)], NOW)
        self.assertEqual(ev["score"], 6)

    def test_within_cap_adjusts_freely(self):
        ev = event(7, 7, 3)          # three independent, tier 1: no cap
        operator_weight.apply_to_events([ev], [verdict(2)], NOW)
        self.assertEqual(ev["score"], 8)
        self.assertNotIn("capped", ev["operator"])
        ev = event(6, 6, 1)
        operator_weight.apply_to_events([ev], [verdict(-2)], NOW)
        self.assertEqual(ev["score"], 5)

    def test_no_verified_source_holds_at_four(self):
        ev = event(4, 4, 0)
        operator_weight.apply_to_events([ev], [verdict(2)], NOW)
        self.assertEqual(ev["score"], 4)

    def test_event_without_check_is_not_capped(self):
        ev = {"model_score": 6, "score": 6, "articles": [{"id": "a1", "outlet": "Reuters"}]}
        operator_weight.apply_to_events([ev], [verdict(2)], NOW)
        self.assertEqual(ev["score"], 7)


if __name__ == "__main__":
    unittest.main()
