"""The reserve model sometimes answers refs as objects, not ids: they are
ignored, never an error (found in a test run on 5 Nov 2026)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import courses  # noqa: E402


class CoursesRefs(unittest.TestCase):
    def test_object_refs_are_ignored(self):
        cur = [{"id": c, "signs": [{"id": "t1"}], "arrows": [], "marks": [], "likelihood": "måttlig"} for c in courses.ORDER]
        status = sorted(courses.STATUSES)[0]
        answer = {"courses": [{"id": courses.ORDER[0], "signs": [{"id": "t1", "status": status, "refs": [{"x": 1}, "E1"]}]}]}
        out = courses.apply(cur, answer, {"E1": ("event", "e1", "2026-11-05")}, "2026-11-05")
        self.assertEqual(out[0]["signs"][0]["refs"], [{"kind": "event", "id": "e1", "date": "2026-11-05"}])


if __name__ == "__main__":
    unittest.main()
