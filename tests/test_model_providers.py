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


def _cf_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_AI", "1")
    monkeypatch.setenv("HOTMONITOR_URL", "https://app.example")
    monkeypatch.setenv("CF_ACCESS_CLIENT_ID", "id")
    monkeypatch.setenv("CF_ACCESS_CLIENT_SECRET", "s")


def test_cloudflare_comes_first(monkeypatch):
    """Version 3.38: Workers AI through the app's Worker before Mistral."""
    _cf_env(monkeypatch)
    monkeypatch.setenv("MISTRAL_API_KEY", "x")
    assert [n.split(":")[0] for n in P.configured()] == ["cloudflare", "mistral"]
    assert P.is_external(P.configured()[0])


def test_cloudflare_refuses_a_large_prompt(monkeypatch):
    _cf_env(monkeypatch)
    try:
        P.ask("cloudflare:llama-3.3-70b", "x" * 200_000)
        assert False, "should refuse"
    except P.ProviderUnavailable as e:
        assert "cloudflare" in str(e)


def test_cloudflare_answer_and_over_allowance(monkeypatch):
    _cf_env(monkeypatch)
    import httpx
    ok = httpx.Response(200, json={"text": '{"ok": true}', "neurons": 12, "neurons_today": 40, "cap": 9000, "model": "m"},
                        request=httpx.Request("POST", "https://app.example/api/ai/chat"))
    with mock.patch("httpx.post", return_value=ok) as post:
        text, info = P.ask("cloudflare:llama-3.3-70b", "hej", want_json=True)
    assert text == '{"ok": true}' and info["neurons_today"] == 40
    assert post.call_args.args[0] == "https://app.example/api/ai/chat"
    assert post.call_args.kwargs["json"]["json"] is True
    full = httpx.Response(429, json={"error": "daily Workers AI allowance would be passed"},
                          request=httpx.Request("POST", "https://app.example/api/ai/chat"))
    with mock.patch("httpx.post", return_value=full):
        try:
            P.ask("cloudflare:llama-3.3-70b", "hej")
            assert False, "should refuse"
        except P.ProviderUnavailable as e:
            assert "429" in str(e)
