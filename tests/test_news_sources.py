"""The second lock on the app's sources: Telegram and Russian state media
never reach the analysis (src/news_sources.py, Worker Version 3.16)."""
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import news_sources  # noqa: E402


class BlockedSources(unittest.TestCase):
    def test_blocked(self):
        for url in ("https://t.me/s/tass_agency", "https://tass.com/politics/1", "https://russian.rt.com/x",
                    "https://ria.ru/20261103/x.html", "https://sputnikglobe.com/x", "https://iz.ru/1",
                    "https://www.rg.ru/x", "http://TVZVEZDA.RU/news", "https://telegra.ph/x"):
            self.assertTrue(news_sources.blocked_source(url), url)

    def test_allowed(self):
        for url in ("https://www.reuters.com/world/", "https://kyivindependent.com/x", "https://www.meduza.io/en",
                    "https://art.com/x", "https://myria.ru.example.org/x", "https://notass.com/x", ""):
            self.assertFalse(news_sources.blocked_source(url), url)

    def test_app_sources_filters(self):
        rows = [{"url": "https://tass.ru/x", "kind": "article"}, {"url": "https://www.svt.se/x", "kind": "article"}]
        with mock.patch("app_sync._config", return_value=True), mock.patch("app_sync._request", return_value=rows):
            self.assertEqual([r["url"] for r in news_sources.app_sources()], ["https://www.svt.se/x"])


if __name__ == "__main__":
    unittest.main()
