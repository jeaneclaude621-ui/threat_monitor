"""src/precision.py: the weekly sample and the summary of labelled samples
(review 1-traffsakerhet, #10)."""
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import precision  # noqa: E402

TODAY = date(2026, 11, 5)


def _report(day, n, generated_by=None):
    r = {"date": day.isoformat(), "events": [
        {"id": f"{day.isoformat()}-e{i}", "title_sv": f"Händelse {i}", "score": 5,
         "topics": ["Drönare"] if i % 2 else [],
         "articles": [{"outlet": "Reuters", "url": "https://www.reuters.com/x", "tier": 1 + i % 3}]}
        for i in range(1, n + 1)]}
    if generated_by:
        r["generated_by"] = generated_by
    return r


class Sample(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.reports, self.data = base / "reports", base / "data"
        self.reports.mkdir()
        for back in range(9):          # 9 days of reports, 3 events each
            d = TODAY - timedelta(days=back)
            gb = {"models": ["gemini-x"]} if back % 2 else None
            (self.reports / f"{d.isoformat()}_report_data.json").write_text(json.dumps(_report(d, 3, gb)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_sample_window_and_fields(self):
        s = precision.make_sample(TODAY, reports_dir=self.reports)
        self.assertEqual(s["events_in_window"], 21)          # 7 days x 3
        self.assertEqual(len(s["items"]), 10)
        oldest = (TODAY - timedelta(days=6)).isoformat()
        for it in s["items"]:
            self.assertGreaterEqual(it["report_date"], oldest)
            self.assertIsNone(it["stamp"])
            self.assertIn(it["model"], ("gemini-x", "okänd"))
        self.assertEqual(s["allowed_stamps"], list(precision.STAMPS))

    def test_same_day_same_sample(self):
        a = precision.make_sample(TODAY, reports_dir=self.reports)
        b = precision.make_sample(TODAY, reports_dir=self.reports)
        self.assertEqual(a["items"], b["items"])

    def test_one_sample_a_week_never_overwritten(self):
        p = precision.write_sample(TODAY - timedelta(days=2), data_dir=self.data, reports_dir=self.reports)
        self.assertTrue(p.exists())
        self.assertIsNone(precision.write_sample(TODAY, data_dir=self.data, reports_dir=self.reports))
        self.assertIsNotNone(precision.write_sample(TODAY + timedelta(days=5), data_dir=self.data,
                                                    reports_dir=self.reports))
        p.write_text(json.dumps({"items": [{"stamp": "fel"}]}))
        self.assertIsNone(precision.write_sample(TODAY - timedelta(days=2), force=True,
                                                 data_dir=self.data, reports_dir=self.reports))
        self.assertEqual(json.loads(p.read_text())["items"][0]["stamp"], "fel")


class Model(unittest.TestCase):
    def test_report_model(self):
        self.assertEqual(precision.report_model({}), "okänd")
        self.assertEqual(precision.report_model({"generated_by": {"models": []}}), "okänd")
        self.assertEqual(precision.report_model({"generated_by": {"models": ["b", "a", "a"]}}), "a + b")
        self.assertEqual(precision.report_model({"generated_by": {"models": {"sweep": "m1"}}}), "m1")
        self.assertEqual(precision.report_model({"generated_by": {"model": "m1", "fallback_used": True}}),
                         "m1 (reserv)")


class Summary(unittest.TestCase):
    def test_counts(self):
        items = [
            {"report_date": "2026-11-01", "event_id": "e1", "model": "m1", "tier": 1, "topics": ["Drönare"],
             "stamp": "stämmer"},
            {"report_date": "2026-11-01", "event_id": "e2", "model": "m1", "tier": 3,
             "topics": ["Drönare", "Sabotage"], "stamp": "delvis"},
            {"report_date": "2026-11-02", "event_id": "e1", "model": "okänd", "tier": None, "topics": [],
             "stamp": "Källa saknas"},
            {"report_date": "2026-11-02", "event_id": "e2", "model": "m1", "tier": 1, "topics": [],
             "stamp": None},
            {"report_date": "2026-11-02", "event_id": "e3", "model": "m1", "tier": 1, "topics": [],
             "stamp": "kanske"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "precision_sample_2026-11-03.json").write_text(json.dumps({"items": items}))
            (data / "precision_sample_2026-11-10.json").write_text(json.dumps({"items": [
                dict(items[0], stamp="stämmer"),            # drawn again: counted once
                {"report_date": "2026-11-08", "event_id": "e1", "model": "m2", "tier": 2,
                 "topics": ["Sabotage"], "stamp": "fel"}]}))
            s = precision.write_summary(data)
            self.assertTrue((data / "precision.json").exists())
        self.assertEqual(s["total"]["labelled"], 4)
        self.assertEqual(s["unlabelled"], 2)
        self.assertEqual(s["total"]["precision"], 0.25)
        self.assertEqual(s["total"]["precision_incl_partial"], 0.5)
        self.assertEqual(s["by_model"]["m1"]["labelled"], 2)
        self.assertEqual(s["by_model"]["okänd"]["källa saknas"], 1)
        self.assertEqual(s["by_tier"]["nivå 1"]["precision"], 1.0)
        self.assertEqual(s["by_tier"]["okänd"]["labelled"], 1)
        self.assertEqual(s["by_topic"]["Drönare"]["labelled"], 2)
        self.assertEqual(s["by_topic"]["Sabotage"]["fel"], 1)
        self.assertEqual(s["by_topic"]["inget ämne"]["labelled"], 1)

    def test_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = precision.summarize(Path(tmp))
        self.assertIsNone(s["total"]["precision"])


if __name__ == "__main__":
    unittest.main()
