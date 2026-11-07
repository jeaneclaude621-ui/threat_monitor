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
