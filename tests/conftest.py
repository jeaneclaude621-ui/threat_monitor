"""Tests never reach a real model: the reserve providers outside Gemini
(src/model_providers.py) read their keys from the environment, so these are
cleared for every test."""
import pytest


@pytest.fixture(autouse=True)
def _no_reserve_keys(monkeypatch):
    for k in ("MISTRAL_API_KEY", "GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(k, raising=False)
