"""A2 #5, #6, #16, #18 and the recalibrated history: the band check on
the model's own scores, symmetric room for the operator, standing
conditions that must name an earlier report's event, the reduced sweep
on the reserve model, and original_value in the index history."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import common  # noqa: E402
import daily_report  # noqa: E402
import operator_weight  # noqa: E402


def result(band=6, idx=6.0, evidence=(1,), standing=None, partial=None):
    return {"index_band": band, "threat_index": idx, "band_evidence": list(evidence),
            "band_standing_conditions": standing or [], "next_band_partial": partial or [],
            "index_band_30d": band, "threat_index_30d": idx, "next_band_partial_30d": []}


class BandOnModelScore(unittest.TestCase):
    def test_operator_cannot_hold_up_a_band(self):
        # The operator lifted 6.8 to 7.3; the band rests on the model's 6.8.
        ev = [{"score": 7.3, "model_score": 6.8}]
        r = daily_report.apply_index_rules(result(), ev)
        self.assertEqual(r["index_band"], 5)

    def test_operator_cannot_drop_a_band(self):
        ev = [{"score": 6.6, "model_score": 7.2}]
        r = daily_report.apply_index_rules(result(), ev)
        self.assertEqual(r["index_band"], 6)

    def test_prompt_does_not_ask_for_high_weight(self):
        src = (ROOT / "src" / "daily_report.py").read_text(encoding="utf-8")
        self.assertNotIn("HIGH weight", src)


class StandingConditions(unittest.TestCase):
    def test_needs_an_earlier_event_id(self):
        ev = [{"score": 5, "model_score": 5}]
        bad = [{"condition": "x", "established": "2026-10-01"}]
        r = daily_report.apply_index_rules(result(standing=bad), ev, known_event_ids={"2026-11-03-e1"})
        self.assertEqual(r["index_band"], 5)
        self.assertEqual(r["band_standing_dropped"], bad)
        self.assertTrue(any("bestående villkor" in c for c in r["index_checks"]))

    def test_known_id_holds_the_band(self):
        ev = [{"score": 5, "model_score": 5}]
        ok = [{"condition": "x", "established": "2026-11-03", "event_id": "2026-11-03-e1"}]
        r = daily_report.apply_index_rules(result(standing=ok), ev, known_event_ids={"2026-11-03-e1"})
        self.assertEqual(r["index_band"], 6)

    def test_contradicted_events_are_not_known(self):
        reports = [("2026-11-03", {"events": [{"id": "2026-11-03-e1", "title": "a"},
                                              {"id": "2026-11-03-e2", "title": "b"}]})]
        with mock.patch.object(daily_report, "load_recent_reports", lambda days: reports):
            ids = daily_report.known_event_ids(outcomes={"2026-11-03-e2": "CONTRADICTED"})
        self.assertEqual(set(ids), {"2026-11-03-e1"})

    def test_without_a_list_the_check_is_skipped(self):
        # recalibrate.py has no list of earlier events.
        kept, dropped = daily_report.check_standing([{"condition": "x"}], None)
        self.assertEqual((len(kept), dropped), (1, []))


def scored(direction, signal, eid="2026-11-05-e1"):
    return {"id": eid, "direction": direction, "operator": {"signal": signal, "trace": [{"x": 1}]}}


class OperatorRoom(unittest.TestCase):
    def test_room_is_symmetric(self):
        self.assertEqual(operator_weight.index_bounds(6.0, 6), (5.7, 6.3))
        lo, hi = operator_weight.index_bounds(6.4, 6)
        self.assertEqual((round(lo, 2), hi), (6.1, 6.5))

    def test_rise_not_stopped_by_placement_cap(self):
        r = {"threat_index": 6.1, "index_band": 6, "index_range": (5.5, 6.1),
             "events": [scored("escalating", 1.0)]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual(out["index_delta"], 0.3)
        self.assertEqual(r["threat_index"], 6.4)
        self.assertEqual(out["reason"], "applied")

    def test_reason_cap(self):
        r = {"threat_index": 6.5, "index_band": 6, "events": [scored("escalating", 1.0)]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual((out["index_delta"], out["reason"]), (0.0, "cap"))
        self.assertIn("gräns", out["reason_sv"])

    def test_reason_rounding(self):
        r = {"threat_index": 6.0, "index_band": 6, "events": [scored("escalating", 0.1)]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual((out["index_delta"], out["reason"]), (0.0, "rounding"))

    def test_reason_no_direction(self):
        r = {"threat_index": 6.0, "index_band": 6,
             "events": [scored("escalating", 0.5), scored("escalating", -0.5, "2026-11-05-e2")]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual(out["reason"], "no_direction")

    def test_reason_no_events(self):
        r = {"threat_index": 6.0, "index_band": 6, "events": [{"id": "e", "direction": "neutral"}]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual(out["reason"], "no_events")
        self.assertTrue(out["reason_sv"])

    def test_partly_capped(self):
        r = {"threat_index": 6.4, "index_band": 6, "events": [scored("escalating", 1.0)]}
        out = operator_weight.apply_to_index(r, [])
        self.assertEqual((out["index_delta"], out["reason"]), (0.1, "partly_capped"))


class Pool:
    def __init__(self):
        self.limits = []

    def prompt_block(self, n, record=True):
        self.limits.append(n)
        return "[A1] Reuters · 2026-11-05 · x"


SWEEP = {"events": [{"title": f"t{i}", "score": 7, "detail": "d", "direction": "neutral"} for i in range(6)],
         "threat_index": 6.0, "index_band": 6, "band_evidence": [1], "band_standing_conditions": [],
         "threat_index_30d": 6.0, "index_band_30d": 6, "deescalation_factors": ["x"]}


class ReserveSweep(unittest.TestCase):
    def sweep(self, answer):
        state = common._default_state()
        pool = Pool()
        calls = []

        def ask(prompt, **k):
            calls.append((k.get("model"), k.get("fallback"), prompt))
            return answer(k.get("model"))
        with mock.patch.object(daily_report, "ask_model_json", ask), \
                mock.patch.object(common, "lite_model", lambda: "lite-x"), \
                mock.patch.object(daily_report, "load_recent_reports", lambda days=3: []), \
                mock.patch.object(daily_report, "load_outcomes", lambda: {}), \
                mock.patch.object(operator_weight, "load_rows", lambda: []):
            r = daily_report.run_broad_sweep(state, [], pool)
        return r, pool, calls

    def test_main_model_full_sweep(self):
        r, pool, calls = self.sweep(lambda m: json.loads(json.dumps(SWEEP)))
        self.assertEqual(pool.limits, [450])
        self.assertEqual(len(r["events"]), 6)
        self.assertEqual(calls[0][:2], (common.MODEL, False))
        self.assertFalse(r["sweep_generated_by"]["reserve"])

    def test_reserve_gets_the_reduced_sweep(self):
        def answer(model):
            if model == common.MODEL:
                raise common.NoModelAvailable("429 PerDay")
            return json.loads(json.dumps(SWEEP))
        r, pool, calls = self.sweep(answer)
        self.assertEqual(pool.limits, [450, 200])
        self.assertEqual([c[:2] for c in calls], [(common.MODEL, False), ("lite-x", False)])
        self.assertIn("Up to 4 of the most important", calls[1][2])
        self.assertEqual(len(r["events"]), 4)
        self.assertTrue(r["sweep_reduced"])
        self.assertEqual(r["sweep_generated_by"]["articles"], 200)


class RecalibratedHistory(unittest.TestCase):
    def test_original_value_where_recalibration_changed_it(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "recalibration.json"
            p.write_text(json.dumps([{"date": "2026-10-01", "value": 5.5, "original_value": 6.8},
                                     {"date": "2026-10-02", "value": 6.0, "original_value": 6.0},
                                     {"date": "2026-10-03", "value": 5.0, "original_value": 7.0}]))
            hist = [{"date": "2026-10-01", "value": 5.5}, {"date": "2026-10-02", "value": 6.0},
                    {"date": "2026-10-03", "value": 6.4},   # a later rerun replaced it
                    {"date": "2026-10-04", "value": 6.1}]
            out = daily_report.history_with_originals(hist, p)
        self.assertEqual(out[0]["original_value"], 6.8)
        self.assertTrue(all("original_value" not in h for h in out[1:]))
        self.assertNotIn("original_value", hist[0])   # the state is not changed

    def test_no_file(self):
        out = daily_report.history_with_originals([{"date": "x", "value": 1}], Path("/nonexistent/r.json"))
        self.assertEqual(out, [{"date": "x", "value": 1}])


if __name__ == "__main__":
    unittest.main()
