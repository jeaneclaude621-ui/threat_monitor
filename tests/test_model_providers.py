"""Version 3.37: Mistral and GitHub Models after Gemini's three models."""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import common
import model_providers as P


def test_nothing_configured_without_keys():
    assert P.configured() == []


def test_order_mistral_then_github(monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "x")
    monkeypatch.setenv("GITHUB_MODELS_TOKEN", "y")
    assert [n.split(":")[0] for n in P.configured()] == ["mistral", "github"]


def test_github_refuses_a_prompt_over_its_limit(monkeypatch):
    monkeypatch.setenv("GITHUB_MODELS_TOKEN", "y")
    try:
        P.ask("github:openai/gpt-4.1-mini", "x" * 100_000)
        assert False, "should refuse"
    except P.ProviderUnavailable as e:
        assert "over the free limit" in str(e)


def test_chain_goes_on_to_the_next_reserve(monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "x")
    monkeypatch.setenv("GITHUB_MODELS_TOKEN", "y")
    calls = []

    def fake(name, prompt, **kw):
        calls.append(name)
        if name.startswith("mistral:"):
            raise P.ProviderUnavailable("mistral 429")
        return '{"ok": true}', {}
    with mock.patch.object(P, "ask", side_effect=fake):
        text = common._external_chain("p", None, 100, True, common.MODEL, "gemini spent")
    assert text == '{"ok": true}' and [c.split(":")[0] for c in calls] == ["mistral", "github"]
    assert common.MODEL_CALLS[-1]["model"].startswith("github:") and common.MODEL_CALLS[-1]["fallback"]


def test_chain_without_reserves_raises():
    try:
        common._external_chain("p", None, 100, False, common.MODEL, "gemini spent")
        assert False
    except common.NoModelAvailable as e:
        assert "gemini spent" in str(e)
