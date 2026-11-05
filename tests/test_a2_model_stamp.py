"""A2 #4 and #18: common.ask_model records which model answered and
whether the reserve was used; the JSON recovery stays on that model. No
network: the Gemini client is replaced."""
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import common  # noqa: E402


def fake_genai():
    """A stand-in google.genai.types, so ask_model can build its config."""
    t = types.SimpleNamespace(GenerateContentConfig=lambda **k: k, ThinkingConfig=lambda **k: k)
    google = sys.modules.get("google") or types.ModuleType("google")
    genai = types.ModuleType("google.genai")
    genai.types = t
    return {"google": google, "google.genai": genai, "google.genai.types": t}


def response(text):
    return types.SimpleNamespace(text=text, candidates=[types.SimpleNamespace(finish_reason=None)])


class Stamp(unittest.TestCase):
    def setUp(self):
        common.MODEL_CALLS.clear()
        self.mods = mock.patch.dict(sys.modules, fake_genai())
        self.mods.start()
        self.client = mock.patch.object(common, "get_client", lambda: None)
        self.client.start()
        self.lite = mock.patch.object(common, "lite_model", lambda: "lite-x")
        self.lite.start()

    def tearDown(self):
        self.mods.stop()
        self.client.stop()
        self.lite.stop()
        common.MODEL_CALLS.clear()

    def run_with(self, answers):
        """answers: model -> list of texts (or exceptions), consumed in order."""
        seen = []

        def gen(client, prompt, config, model):
            seen.append(model)
            a = answers[model].pop(0)
            if isinstance(a, Exception):
                raise a
            return response(a)
        return mock.patch.object(common, "_generate_with_retry", gen), seen

    def test_main_model_answers(self):
        p, _ = self.run_with({common.MODEL: ["ok"]})
        with p:
            mark = common.calls_mark()
            self.assertEqual(common.ask_model("x"), "ok")
        g = common.generated_by(mark)
        self.assertEqual((g["models"], g["fallback_used"], g["calls"]), ([common.MODEL], False, 1))
        self.assertIn("code_sha", g)

    def test_fallback_is_recorded(self):
        p, seen = self.run_with({common.MODEL: [common.ModelUnavailable("429 PerDay")], "lite-x": ["ok"]})
        with p:
            common.ask_model("x")
        self.assertEqual(seen, [common.MODEL, "lite-x"])
        g = common.generated_by()
        self.assertEqual((g["models"], g["fallback_used"]), (["lite-x"], True))
        self.assertTrue(common.main_model_failed())

    def test_no_fallback_raises_a_runtime_error(self):
        p, seen = self.run_with({common.MODEL: [common.ModelUnavailable("503")]})
        with p, self.assertRaises(common.NoModelAvailable):
            common.ask_model("x", model=common.MODEL, fallback=False)
        self.assertTrue(issubclass(common.NoModelAvailable, RuntimeError))
        self.assertEqual(seen, [common.MODEL])

    def test_json_recovery_stays_on_the_model_that_answered(self):
        # The first answer comes from the reserve; the recovery must not go
        # back to the main model (which might answer by then).
        p, seen = self.run_with({common.MODEL: [common.ModelUnavailable("503"), "{\"a\": 2}"],
                                 "lite-x": ["not json", "{\"a\": 1}"]})
        with p:
            self.assertEqual(common.ask_model_json("x"), {"a": 1})
        self.assertEqual(seen, [common.MODEL, "lite-x", "lite-x"])
        self.assertEqual(common.generated_by()["models"], ["lite-x"])

    def test_generated_by_since_mark(self):
        p, _ = self.run_with({common.MODEL: [common.ModelUnavailable("503"), "b"], "lite-x": ["a"]})
        with p:
            common.ask_model("x")
            mark = common.calls_mark()
            common.ask_model("y")
        self.assertFalse(common.generated_by(mark)["fallback_used"])
        self.assertTrue(common.generated_by()["fallback_used"])


if __name__ == "__main__":
    unittest.main()
