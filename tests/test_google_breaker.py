"""20 Nov 2026: Google News down must not eat the morning run's hour."""
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import news_sources as n


def test_google_news_switches_off_after_repeated_failures(monkeypatch):
    calls = []

    def boom(url, headers=None):
        calls.append(url)
        raise urllib.error.HTTPError(url, 503, "down", {}, None)

    monkeypatch.setattr(n, "_get", boom)
    monkeypatch.setattr(n.time, "sleep", lambda s: None)
    monkeypatch.setattr(n, "_google_fails", 0)
    monkeypatch.setattr(n, "_google_off", False)
    for i in range(20):
        assert n.google_news(f"q{i}") == []
    # three searches, each tried three times; then no more requests
    assert len(calls) == 3 * n.GOOGLE_OFF_AFTER
    assert n._google_off
