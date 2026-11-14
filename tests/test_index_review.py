"""Version 3.36, after the independent review of 14 Nov 2026: a reserve
day holds the band, the week's band evidence is kept by code, band 7+
needs its own kind of condition, and the war inside Ukraine takes at most
one event."""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import daily_report as D

TODAY = date.today()


def day(n):
    return (TODAY - timedelta(days=n)).isoformat()


def report(n, idx, band, reserve=False, events=()):
    return (day(n), {"threat_index": idx, "index_band": band, "threat_index_30d": idx, "index_band_30d": band,
                     "generated_by": {"sweep": {"reserve": reserve}}, "events": list(events)})


def test_reserve_day_holds_the_last_main_band():
    reports = [report(3, 6.4, 6), report(2, 5.2, 5, reserve=True)]
    res = {"threat_index": 5.2, "index_band": 5, "threat_index_30d": 5.3, "index_band_30d": 5}
    checks = D.hold_reserve_day(res, reports)
    assert res["index_band"] == 6 and res["threat_index"] == 6.1      # 6.4 - 0.3
    assert res["index_band_30d"] == 6 and res["threat_index_30d"] == 6.1
    assert res["index_preliminary"]["held_from"] == day(3) and res["index_preliminary"]["model_index"] == 5.2
    assert checks and "Reservmodellen" in checks[0]


def test_reserve_day_without_a_main_day_this_week_is_left_alone():
    res = {"threat_index": 5.2, "index_band": 5}
    assert D.hold_reserve_day(res, [report(9, 6.4, 6)]) == []
    assert res["threat_index"] == 5.2 and "index_preliminary" not in res


def test_band_7_needs_its_own_kind_of_condition():
    res = {"threat_index": 7.0, "index_band": 7, "band_conditions_met": ["Poland deploys special forces to the border"],
           "next_band_partial": [], "threat_index_30d": 6.5, "index_band_30d": 6}
    checks = D.check_band_condition(res)
    assert res["index_band"] == 6 and res["threat_index"] == 6.1 and checks
    ok = {"threat_index": 7.1, "index_band": 7, "band_conditions_met": ["Article 4 consultations requested by Poland"]}
    assert D.check_band_condition(ok) == [] and ok["index_band"] == 7


def test_ukraine_only_events_limited_and_evidence_renumbered():
    evs = [{"title": "UA grid", "countries": ["RU", "UA"], "score": 9},
           {"title": "Baltic drones", "countries": ["LV", "RU"], "score": 8, "articles": []},
           {"title": "Refinery", "countries": ["RU", "UA"], "score": 6, "articles": [{"url": "https://x.example/a", "outlet": "X"}]}]
    res = {"events": evs, "band_evidence": [2], "also_reported": []}
    assert D.limit_ukraine_only(res) == 1
    assert [e["title"] for e in res["events"]] == ["UA grid", "Baltic drones"]
    assert res["band_evidence"] == [2]
    assert res["also_reported"][0]["refs"][0]["outlet"] == "X"


def test_evidence_events_keep_the_week_and_skip_ukraine_only():
    reports = [report(2, 6, 6, events=[{"id": "a", "title": "Interception", "countries": ["LT", "RU"], "score": 8},
                                       {"id": "b", "title": "Grid", "countries": ["RU", "UA"], "score": 9},
                                       {"id": "c", "title": "Weak", "countries": ["PL"], "score": 6}]),
               report(9, 6, 6, events=[{"id": "d", "title": "Old", "countries": ["PL"], "score": 9}])]
    assert [e["id"] for e in D.evidence_events(reports)] == ["a"]
