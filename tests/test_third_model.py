"""Version 3.25: a third Gemini model when the main and the light one are
both spent or overloaded."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import common  # noqa: E402


class FakeResponse:
    def __init__(self, text):
        self.text = text
        self.candidates = []


class ThirdModel(unittest.TestCase):
    def setUp(self):
        common._lite[:] = ["lite-x"]
        common._third[:] = ["third-x"]
        common.MODEL_CALLS.clear()

    def tearDown(self):
        common._lite.clear()
        common._third.clear()

    def test_chain_reaches_the_third_model(self):
        def gen(client, prompt, config, model):
            if model in (common.MODEL, "lite-x"):
                raise common.ModelUnavailable("503 UNAVAILABLE")
            return FakeResponse("svar")
        with mock.patch.object(common, "_generate_with_retry", side_effect=gen), \
             mock.patch.object(common, "get_client", return_value=None):
            self.assertEqual(common.ask_model("p"), "svar")
        self.assertEqual(common.MODEL_CALLS[-1], {"model": "third-x", "requested": common.MODEL, "fallback": True})

    def test_all_three_down_raises(self):
        def gen(client, prompt, config, model):
            raise common.ModelUnavailable("503 UNAVAILABLE")
        with mock.patch.object(common, "_generate_with_retry", side_effect=gen), \
             mock.patch.object(common, "get_client", return_value=None):
            with self.assertRaises(common.NoModelAvailable):
                common.ask_model("p")

    def test_no_fallback_means_one_model(self):
        calls = []

        def gen(client, prompt, config, model):
            calls.append(model)
            raise common.ModelUnavailable("503")
        with mock.patch.object(common, "_generate_with_retry", side_effect=gen), \
             mock.patch.object(common, "get_client", return_value=None):
            with self.assertRaises(common.NoModelAvailable):
                common.ask_model("p", fallback=False)
        self.assertEqual(calls, [common.MODEL])

    def test_picks_newest_plain_flash(self):
        common._third.clear()
        names = ["models/gemini-2.0-flash", "models/gemini-3.5-flash", "models/gemini-3.5-flash-lite",
                 "models/gemini-3.9-flash-preview", common.MODEL and f"models/{common.MODEL}"]

        class M:
            def __init__(self, n):
                self.name = n

        class C:
            class models:
                @staticmethod
                def list():
                    return [M(n) for n in names]
        with mock.patch.object(common, "get_client", return_value=C()), mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("THIRD_MODEL", None)
            self.assertEqual(common.third_model(), "gemini-3.5-flash")


if __name__ == "__main__":
    unittest.main()
