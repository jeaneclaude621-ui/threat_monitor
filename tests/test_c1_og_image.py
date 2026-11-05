"""src/og_image.py: the day's shareable 1200x630 image."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import og_image  # noqa: E402

try:
    from PIL import Image
except ImportError:      # Pillow is optional for the rest of the suite
    Image = None

REPORT = {"date": "2026-11-05", "threat_index": 6.43, "top_development": "Läget i Östersjön",
          "events": [{"title_sv": "Kö vid Narva", "score": 3},
                     {"title_sv": "Drönare över dansk flygbas", "score": 7.2},
                     {"title": "no Swedish title", "score": 9}]}


class Text(unittest.TestCase):
    def test_top_event_is_highest_score_with_title_sv(self):
        self.assertEqual(og_image.top_event(REPORT), "Drönare över dansk flygbas")
        self.assertEqual(og_image.top_event({"top_development": "X", "events": []}), "X")
        self.assertEqual(og_image.top_event({}), "")

    def test_formats(self):
        self.assertEqual(og_image.format_index(6.43), "6,4")
        self.assertEqual(og_image.format_index(None), "–")
        self.assertEqual(og_image.swedish_date("2026-11-05"), "5 november 2026")


@unittest.skipIf(Image is None, "Pillow not installed")
class Render(unittest.TestCase):
    def test_writes_dated_and_latest(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = og_image.write(REPORT, Path(tmp))
            self.assertEqual([p.name for p in paths], ["2026-11-05.png", "latest.png"])
            with Image.open(paths[1]) as img:
                self.assertEqual(img.size, (1200, 630))
                self.assertEqual(img.format, "PNG")
                self.assertEqual(img.getpixel((600, 200))[:3], (0x15, 0x20, 0x3B))
                self.assertEqual(img.getpixel((600, 4))[:3], (0xC8, 0x74, 0x1A))

    def test_long_title_and_no_events(self):
        long = dict(REPORT, events=[{"title_sv": "ord " * 80, "score": 5}])
        self.assertEqual(og_image.render(long).size, (1200, 630))
        self.assertEqual(og_image.render({"date": "2026-11-05"}).size, (1200, 630))


if __name__ == "__main__":
    unittest.main()
