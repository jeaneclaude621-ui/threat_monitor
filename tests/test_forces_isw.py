"""Offline tests for src/forces_isw.py: the prefilter on a saved ISW excerpt,
and the checks on the model's answer. No network, no model.

    python3 -m unittest discover -s tests
"""
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import forces_isw  # noqa: E402

SAMPLE = (ROOT / "tests" / "fixtures" / "isw_sample.html").read_text(encoding="utf-8")
URL = "https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-october-16-2026"
TODAY = date(2026, 10, 17)


class Prefilter(unittest.TestCase):
    def setUp(self):
        self.index = forces_isw.unit_index()

    def test_names_known_units(self):
        hits = forces_isw.prefilter(forces_isw.paragraphs(SAMPLE), self.index)
        ids = {i for _, found in hits for i in found}
        for uid in ("110-gardes-motoriserade-skyttebrigaden", "114-gardes-motoriserade-skyttebrigaden",
                    "51-gardes-armen", "61-gardes-marininfanteribrigaden", "8-gardes-armen"):
            self.assertIn(uid, ids)

    def test_paragraphs_without_units_are_dropped(self):
        hits = forces_isw.prefilter(forces_isw.paragraphs(SAMPLE), self.index)
        self.assertTrue(all(not p.startswith("Russian forces continued offensive operations") for p, _ in hits))

    def test_scripts_are_not_text(self):
        self.assertFalse(any("var x" in p for p in forces_isw.paragraphs(SAMPLE)))

    def test_no_units_no_call(self):
        calls = []
        page = "<p>" + "Russian forces continued offensive operations near Pokrovsk on October 16. " * 3 + "</p>" * 12
        n = forces_isw.run({}, today=TODAY, get=lambda url: page, ask=lambda p: calls.append(p) or [])
        self.assertEqual((n, calls), (0, []))

    def test_one_call_a_day(self):
        calls = []
        state = {}
        ask = lambda p: calls.append(p) or []  # noqa: E731
        forces_isw.run(state, today=TODAY, get=lambda url: SAMPLE * 3, ask=ask)
        forces_isw.run(state, today=TODAY, get=lambda url: SAMPLE * 3, ask=ask)
        self.assertEqual(len(calls), 1)

    def test_ordinals(self):
        self.assertEqual([forces_isw._ordinal(n) for n in (1, 2, 3, 11, 12, 13, 21, 112)],
                         ["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "112th"])


class Validate(unittest.TestCase):
    units = {"8-gardes-armen": {}, "51-gardes-armen": {}}

    def entry(self, **kw):
        e = {"unit_id": "8-gardes-armen", "place": "Kostjantynivka",
             "activity_sv": "anfaller mot Kostjantynivka från söder enligt ISW", "date": "2026-10-16", "url": URL}
        e.update(kw)
        return e

    def test_good_entry_kept(self):
        self.assertEqual(len(forces_isw.validate([self.entry()], self.units, TODAY)), 1)

    def test_unknown_unit_dropped(self):
        self.assertEqual(forces_isw.validate([self.entry(unit_id="999-armen")], self.units, TODAY), [])

    def test_old_or_future_date_dropped(self):
        self.assertEqual(forces_isw.validate([self.entry(date="2026-10-01")], self.units, TODAY), [])
        self.assertEqual(forces_isw.validate([self.entry(date="2026-10-30")], self.units, TODAY), [])
        self.assertEqual(forces_isw.validate([self.entry(date="okänt")], self.units, TODAY), [])

    def test_non_isw_url_dropped(self):
        self.assertEqual(forces_isw.validate([self.entry(url="https://tass.com/x")], self.units, TODAY), [])

    def test_wrapped_answer_and_junk(self):
        self.assertEqual(len(forces_isw.validate({"units": [self.entry(), "junk", None]}, self.units, TODAY)), 1)
        self.assertEqual(forces_isw.validate("not json", self.units, TODAY), [])

    def test_apply_keeps_five_newest(self):
        state = {}
        for d in range(10, 17):
            forces_isw.apply(state, [{"unit_id": "8-gardes-armen", "place": "", "activity_sv": f"dag {d}",
                                      "date": f"2026-10-{d}", "url": URL}])
        u = state["units"]["8-gardes-armen"]
        self.assertEqual(len(u["status_source"]), 5)
        self.assertEqual((u["status_sv"], u["status_as_of"]), ("dag 16", "2026-10-16"))


if __name__ == "__main__":
    unittest.main()
