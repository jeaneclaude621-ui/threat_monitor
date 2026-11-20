"""Version 3.45: the band floor and the daily move limit."""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import daily_report as dr


def day(n):
    return (date.today() - timedelta(days=n)).isoformat()


def rep(band, idx, score=8, countries=("EE", "RU"), floor=False, evidence=(1,)):
    r = {"index_band": band, "threat_index": idx, "threat_index_30d": idx, "index_band_30d": band,
         "band_evidence": list(evidence),
         "events": [{"id": "e1", "model_score": score, "score": score, "countries": list(countries)}]}
    if floor:
        r["index_floor"] = {"band": band}
    return r


def test_floor_holds_the_band_while_the_evidence_holds():
    week = [(day(3), rep(6, 6.3)), (day(1), rep(6, 6.2))]
    result = {"index_band": 5, "threat_index": 5.5}
    checks = dr.hold_band_floor(result, week)
    assert result["index_band"] == 6 and result["threat_index"] == 6.0 and checks
    assert result["index_floor"]["model_band"] == 5


def test_floor_runs_out_after_the_window():
    week = [(day(dr.EVIDENCE_WINDOW_DAYS + 1), rep(6, 6.3))]
    result = {"index_band": 5, "threat_index": 5.5}
    assert dr.hold_band_floor(result, week) == [] and result["index_band"] == 5


def test_a_floored_day_does_not_carry_the_floor_on():
    week = [(day(2), rep(6, 6.0, floor=True))]
    result = {"index_band": 5, "threat_index": 5.4}
    assert dr.hold_band_floor(result, week) == [] and result["index_band"] == 5


def test_weak_or_ukraine_only_evidence_holds_nothing():
    week = [(day(2), rep(6, 6.2, score=6)), (day(1), rep(6, 6.2, countries=("UA", "RU")))]
    result = {"index_band": 5, "threat_index": 5.5}
    assert dr.hold_band_floor(result, week) == []


def test_floor_never_lowers():
    week = [(day(1), rep(5, 5.5))]
    result = {"index_band": 6, "threat_index": 6.4}
    assert dr.hold_band_floor(result, week) == [] and result["threat_index"] == 6.4


def test_daily_move_is_limited_within_a_band():
    week = [(day(1), rep(6, 6.4))]
    result = {"index_band": 6, "threat_index": 5.6, "index_band_30d": 6, "threat_index_30d": 6.4}
    checks = dr.limit_daily_move(result, week)
    assert result["threat_index"] == 6.0 and len(checks) == 1


def test_a_change_of_band_is_not_limited():
    week = [(day(1), rep(6, 6.4))]
    result = {"index_band": 7, "threat_index": 7.2, "index_band_30d": 7, "threat_index_30d": 7.0}
    assert dr.limit_daily_move(result, week) == [] and result["threat_index"] == 7.2
