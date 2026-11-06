"""A2: a run that exits 0 but whose warnings show 401, 429, 503 or
"failed" is reported "partial", not "ok"."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "schedule"))
import run_job  # noqa: E402


class Status(unittest.TestCase):
    def test_ok_failed_partial(self):
        self.assertEqual(run_job.run_status(0, []), "ok")
        self.assertEqual(run_job.run_status(0, ["! No de-escalation factors identified"]), "ok")
        self.assertEqual(run_job.run_status(1, []), "failed")
        self.assertEqual(run_job.run_status(1, ["! 429"]), "failed")
        for w in ("! PUT /api/ingest/reports: HTTP 401 b'invalid_jwt'",
                  "! gemini-3.8-flash unavailable (429 RESOURCE_EXHAUSTED); this call runs on lite",
                  "! Courses of action failed (boom)",
                  "! thread check FAILED"):
            self.assertEqual(run_job.run_status(0, [w]), "partial", w)

    def test_numbers_must_stand_alone(self):
        self.assertEqual(run_job.run_status(0, ["! 14010 items", "! id 5031"]), "ok")
        # A retry that went on is not a failure.
        self.assertEqual(run_job.run_status(0, ["! Gemini API unavailable (503 UNAVAILABLE); retrying in 30s",
                                                "! JSON parse failed (x); retrying with the partial response"]), "ok")

    def test_reasons_once_each(self):
        ws = ["! HTTP 401", "! HTTP 401 again", "! 503 high demand", "! x failed"]
        self.assertEqual(run_job.partial_reasons(ws), ["401", "503", "failed"])

    def test_partial_falls_back_to_ok_when_refused(self):
        sent = []

        def push(run):
            sent.append(run)
            if run["status"] == "partial":
                raise RuntimeError("PUT /api/ingest/runs/x: HTTP 400 status must be running, ok or failed")
        run_job.report_finished({"status": "partial", "partial": True}, push=push)
        self.assertEqual([r["status"] for r in sent], ["partial", "ok"])
        self.assertTrue(sent[1]["partial"])

    def test_other_errors_are_not_retried(self):
        sent = []

        def push(run):
            sent.append(run)
            raise RuntimeError("HTTP 500")
        run_job.report_finished({"status": "partial"}, push=push)
        self.assertEqual(len(sent), 1)


if __name__ == "__main__":
    unittest.main()
