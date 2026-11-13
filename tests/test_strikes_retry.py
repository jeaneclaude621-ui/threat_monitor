"""The strike map's nights after the dataset: the 12:00 and 21:00 runs read
the night that ended this morning too; Google News is asked again on 503."""
import sys
import urllib.error
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import news_sources
import strikes




def test_morning_run_stops_at_yesterday(monkeypatch, capsys):
    monkeypatch.setattr("common.lite_model", lambda: "m")
    asked = {}
    monkeypatch.setattr(strikes, "headlines", lambda days: asked.setdefault("days", days) and {})
    strikes.preliminary("2026-11-03", {"days": []}, date(2026, 11, 7))
    assert "2026-11-04, 2026-11-05, 2026-11-06" in capsys.readouterr().out


def test_day_run_includes_this_morning(monkeypatch, capsys):
    monkeypatch.setattr("common.lite_model", lambda: "m")
    monkeypatch.setattr(strikes, "headlines", lambda days: {})
    strikes.preliminary("2026-11-03", {"days": []}, date(2026, 11, 7), with_today=True)
    assert "2026-11-06, 2026-11-07" in capsys.readouterr().out


def test_google_news_asks_again_on_503(monkeypatch):
    calls = []

    def fake_get(url, headers=None):
        calls.append(url)
        if len(calls) < 3:
            raise urllib.error.HTTPError(url, 503, "Service Unavailable", {}, None)
        return b"<rss><channel></channel></rss>"
    monkeypatch.setattr(news_sources, "_get", fake_get)
    monkeypatch.setattr(news_sources.time, "sleep", lambda s: None)
    assert news_sources.google_news("x") == []
    assert len(calls) == 3


def test_google_news_gives_up_on_404(monkeypatch):
    calls = []

    def fake_get(url, headers=None):
        calls.append(url)
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
    monkeypatch.setattr(news_sources, "_get", fake_get)
    monkeypatch.setattr(news_sources.time, "sleep", lambda s: None)
    assert news_sources.google_news("x") == []
    assert len(calls) == 1


def test_places_with_cyrillic_lookalike_and_orenburg():
    assert strikes.places("Zakarpattia оblast", strikes.TARGET)[0][0]["lat"] == 48.4
    assert strikes.places("Orenburg oblast", strikes.LAUNCH)[0][0]["lon"] == 55.1


def test_a_headline_night_without_launch_places_is_read_again(monkeypatch, capsys):
    monkeypatch.setattr("common.lite_model", lambda: "m")
    monkeypatch.setattr(strikes, "headlines", lambda days: {})
    old = {"days": [{"date": "2026-11-06", "preliminary": True, "rows": [{"from": [], "to": [{"name": "Kyiv"}]}]},
                    {"date": "2026-11-05", "preliminary": True, "launch_tried": True, "rows": [{"from": [], "to": []}]}]}
    strikes.preliminary("2026-11-04", old, date(2026, 11, 7))
    out = capsys.readouterr().out
    assert "2026-11-06" in out and "2026-11-05" not in out


def test_a_night_read_again_without_result_is_kept(monkeypatch):
    monkeypatch.setattr("common.lite_model", lambda: "m")
    monkeypatch.setattr(strikes, "headlines", lambda days: {})
    night = {"date": "2026-11-06", "preliminary": True, "rows": [{"from": [], "to": [{"name": "Kyiv"}]}]}
    got = strikes.preliminary("2026-11-04", {"days": [night]}, date(2026, 11, 7))
    assert [n["date"] for n in got] == ["2026-11-06"]


def test_more_shot_down_than_launched_is_left_out():
    rows = [{"time_end": "2026-11-03 09:00", "model": "Shahed-136/131", "launched": "81", "destroyed": "139",
             "launch_place": "", "target": "Ukraine"},
            {"time_end": "2026-11-03 09:00", "model": "Shahed-136/131", "launched": "289", "destroyed": "257",
             "launch_place": "", "target": "Ukraine"}]
    day = strikes.build(rows, date(2026, 11, 4))["days"][0]
    assert [r["destroyed"] for r in day["rows"]] == [None, 257]
    t = day["totals"]["drönare"]
    assert t["launched"] == 370 and t["destroyed"] == 257 and t["destroyed_partial"] is True
