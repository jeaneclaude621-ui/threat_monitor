"""drop_repeated_articles leaves no known_sv sentence resting only on
articles it took out (lansering A3, 5)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import daily_report  # noqa: E402

OLD = "https://www.reuters.com/world/old-1"
NEW = "https://www.svt.se/nyheter/new-1"


def recent():
    return [("2026-11-04", {"events": [{"articles": [{"url": OLD}]}]})]


class RepeatedKnown(unittest.TestCase):
    def test_sentence_on_removed_article_is_dropped(self):
        ev = {"articles": [{"id": "old", "url": OLD}, {"id": "new", "url": NEW}],
              "known_sv": [{"text": "Bara gammal.", "refs": ["old"]},
                           {"text": "Båda.", "refs": ["old", "new"]},
                           {"text": "Bara ny.", "refs": ["new"]}]}
        daily_report.drop_repeated_articles([ev], recent())
        self.assertEqual([a["id"] for a in ev["articles"]], ["new"])
        self.assertEqual(ev["known_sv"], [{"text": "Båda.", "refs": ["new"]},
                                          {"text": "Bara ny.", "refs": ["new"]}])

    def test_untouched_when_nothing_removed(self):
        known = [{"text": "Gammal.", "refs": ["old"]}]
        ev = {"articles": [{"id": "old", "url": OLD}], "known_sv": list(known)}
        daily_report.drop_repeated_articles([ev], recent())   # would leave none: kept
        self.assertEqual(ev["known_sv"], known)

    def test_plain_strings_kept(self):
        ev = {"articles": [{"id": "old", "url": OLD}, {"id": "new", "url": NEW}], "known_sv": ["Fritext."]}
        daily_report.drop_repeated_articles([ev], recent())
        self.assertEqual(ev["known_sv"], ["Fritext."])


if __name__ == "__main__":
    unittest.main()
