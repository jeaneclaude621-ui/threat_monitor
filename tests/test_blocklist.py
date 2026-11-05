"""One blocklist for every way in (src/blocklist.py): Russian state media,
the pro-Kremlin network and Telegram never reach the analysis - by link and
by publisher name, since Google News links all go to news.google.com."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import blocklist  # noqa: E402
import news_sources  # noqa: E402

GN = "https://news.google.com/rss/articles/CBMiXYZ?oc=5"


class Hosts(unittest.TestCase):
    def test_blocked(self):
        for url in ("https://tass.com/x", "https://lenta.ru/news/1", "https://www.gazeta.ru/x", "https://www.kp.ru/x",
                    "https://aif.ru/x", "https://ukraina.ru/x", "https://www.kommersant.ru/doc/1",
                    "https://www.interfax.ru/world/1", "https://news-front.info/x", "https://pravda-en.com/x",
                    "https://fr.news-pravda.com/x", "https://pravda-sv.com/x", "https://pravda.ru/x",
                    "https://de.rt.com/x", "https://t.me/s/x", "tass.ru"):
            self.assertTrue(blocklist.blocked_host(url), url)

    def test_allowed(self):
        for url in ("https://www.pravda.com.ua/eng/news/1", "https://interfax.com.ua/news/1", "https://www.reuters.com/x",
                    "https://kyivindependent.com/x", "https://meduza.io/en", "https://art.com/x", "https://notass.com/x",
                    "https://plenta.ru.example.org/x", GN, "", None):
            self.assertFalse(blocklist.blocked_host(url), url)


class Outlets(unittest.TestCase):
    def test_blocked(self):
        for name in ("TASS", "tass", "RT", "RT en Español", "Russia Today", "RIA Novosti", "РИА Новости", "Sputnik Globe",
                     "Izvestia", "Lenta.ru", "Gazeta.ru", "Komsomolskaya Pravda", "Argumenty i Fakty", "Ukraina.ru",
                     "Kommersant", "Коммерсантъ", "Interfax", "News Front", "Pravda EN", "tass.com", "lenta.ru",
                     "fr.news-pravda.com"):
            self.assertTrue(blocklist.blocked_outlet(name), name)

    def test_allowed(self):
        for name in ("Reuters", "Art Daily", "Ukrainska Pravda", "Interfax-Ukraine", "Gazeta Wyborcza", "Kyiv Post",
                     "The Moscow Times", "Meduza", "NTV", "n-tv", "Sputnik Music", "RTÉ", "reuters.com", "", None):
            self.assertFalse(blocklist.blocked_outlet(name), name)


class PoolFilters(unittest.TestCase):
    def test_tass_via_google_news(self):
        """The link is news.google.com; only the source names TASS."""
        p = news_sources.Pool().add([
            {"title": "Kremlin says", "link": GN, "source": "TASS", "via": "google"},
            {"title": "Drones over Poland", "link": GN + "1", "source": "Reuters", "via": "google"},
        ])
        self.assertEqual([a["source"] for a in p.items], ["Reuters"])
        self.assertEqual(p.blocked, 1)

    def test_gdelt_domain_and_feeds_and_app(self):
        p = news_sources.Pool().add([
            {"title": "A", "link": "https://lenta.ru/news/1", "source": "lenta.ru", "via": "gdelt"},
            {"title": "B", "link": "https://pravda-fi.com/x", "source": "pravda-fi.com", "via": "gdelt"},
            {"title": "C", "link": "https://www.kommersant.ru/doc/1", "source": "Коммерсантъ", "via": "feed"},
            {"title": "D", "link": "https://news-front.su/x", "source": "News Front", "via": "app"},
            {"title": "E", "link": "https://www.svt.se/x", "source": "SVT", "via": "app"},
        ])
        self.assertEqual([a["title"] for a in p.items], ["E"])

    def test_old_entry_point_still_works(self):
        self.assertTrue(news_sources.blocked_source("https://tass.ru/x"))
        self.assertTrue(news_sources.blocked_source(GN, "Interfax"))


class ForcesAndStrikes(unittest.TestCase):
    def test_strikes_headlines(self):
        from unittest import mock
        from datetime import datetime
        import strikes
        rows = [{"title": "Air force: 100 drones", "link": GN, "source": "RIA Novosti", "published": datetime(2026, 11, 5, 6)},
                {"title": "Air force: 90 drones", "link": GN + "2", "source": "Kyiv Independent",
                 "published": datetime(2026, 11, 5, 6)}]
        with mock.patch("news_sources.google_news", return_value=rows):
            got = [a["source"] for v in strikes.headlines(1).values() for a in v]
        self.assertEqual(sorted(set(got)), ["Kyiv Independent"])

    def test_forces_db_check_uses_blocklist(self):
        import forces_db_check
        self.assertFalse(hasattr(forces_db_check, "BANNED"))
        self.assertTrue(blocklist.blocked_host("https://www.interfax.ru/x"))


class NotNews(unittest.TestCase):
    def test_social(self):
        for s in ({"outlet": "YouTube", "url": "https://www.youtube.com/watch?v=1"}, {"url": "https://x.com/a/status/1"},
                  {"outlet": "Facebook"}, {"source": "Telegram"}, {"url": "https://bsky.app/profile/x"}):
            self.assertFalse(blocklist.is_news(s), s)

    def test_news(self):
        for s in ({"outlet": "Reuters", "url": "https://www.reuters.com/x"}, {"outlet": "Expressen"},
                  {"outlet": "Kyiv Independent", "url": "https://kyivindependent.com/x"}):
            self.assertTrue(blocklist.is_news(s), s)


if __name__ == "__main__":
    unittest.main()
