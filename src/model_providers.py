"""
Reserve models outside Gemini (Version 3.37), after Gemini's own three
(main, light, third) are spent or overloaded: Mistral, when MISTRAL_API_KEY
is set, then GitHub Models, with the workflow's own token. Both speak the
OpenAI chat-completions format. A model is named "mistral:<id>" or
"github:<id>" wherever common.ask_model takes a model name.

GitHub Models' free use caps the size of one request (GITHUB_MAX_INPUT_TOKENS,
estimated from the prompt's length): a prompt over it is not sent, and the
chain goes on, so the morning sweep never goes there - the smaller work
(thread checks, translations, the index rescore) does.

    python3 src/model_providers.py check   # one tiny call each, printing the limits the providers report
"""
import json
import os
import sys
import time

MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"
GITHUB_URL = "https://models.github.ai/inference/chat/completions"
MISTRAL_MODEL = os.environ.get("MISTRAL_MODEL") or "mistral-large-latest"
GITHUB_MODEL = os.environ.get("GITHUB_MODEL") or "openai/gpt-4.1-mini"
GITHUB_MAX_INPUT_TOKENS = int(os.environ.get("GITHUB_MAX_INPUT_TOKENS") or 7000)
CHARS_PER_TOKEN = 3.5          # a rough estimate for mixed English and Swedish
TIMEOUT = 300
RETRIES = 2                    # on 5xx, and on 429 with a short Retry-After


class ProviderUnavailable(Exception):
    """Not configured, over its limits, too large a prompt, or down."""


def _key(provider: str):
    if provider == "mistral":
        return os.environ.get("MISTRAL_API_KEY")
    if provider == "github":
        return os.environ.get("GITHUB_MODELS_TOKEN") or os.environ.get("GITHUB_TOKEN")
    return None


def configured() -> list:
    """The reserve model names this run can use, in order of the chain."""
    out = []
    if _key("mistral"):
        out.append(f"mistral:{MISTRAL_MODEL}")
    if _key("github"):
        out.append(f"github:{GITHUB_MODEL}")
    return out


def is_external(name: str) -> bool:
    return bool(name) and (name.startswith("mistral:") or name.startswith("github:"))


def estimate_tokens(*texts) -> int:
    return int(sum(len(t or "") for t in texts) / CHARS_PER_TOKEN)


def ask(name: str, prompt: str, system: str = None, max_tokens: int = 2000, want_json: bool = False):
    """(text, headers) from a reserve model named "<provider>:<model id>"."""
    import httpx
    provider, _, model = name.partition(":")
    key = _key(provider)
    if not key:
        raise ProviderUnavailable(f"{provider}: no key")
    if provider == "github":
        need = estimate_tokens(prompt, system)
        if need > GITHUB_MAX_INPUT_TOKENS:
            raise ProviderUnavailable(f"github: prompt about {need} tokens, over the free limit of {GITHUB_MAX_INPUT_TOKENS}")
        max_tokens = min(max_tokens, 4000)
    url = MISTRAL_URL if provider == "mistral" else GITHUB_URL
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"}
    if provider == "github":
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.2}
    if want_json:
        body["response_format"] = {"type": "json_object"}
    for attempt in range(RETRIES + 1):
        try:
            r = httpx.post(url, headers=headers, json=body, timeout=TIMEOUT)
        except httpx.TransportError as e:
            if attempt == RETRIES:
                raise ProviderUnavailable(f"{provider}: {type(e).__name__}: {e}") from e
            time.sleep(10 * (attempt + 1))
            continue
        if r.status_code == 200:
            data = r.json()
            choice = (data.get("choices") or [{}])[0]
            if choice.get("finish_reason") == "length":
                print(f"  ! {name} hit max_tokens={max_tokens} - output is truncated")
            return (choice.get("message") or {}).get("content") or "", dict(r.headers)
        wait = r.headers.get("retry-after")
        short = wait is not None and wait.isdigit() and int(wait) <= 60
        if attempt < RETRIES and (r.status_code >= 500 or (r.status_code == 429 and short)):
            time.sleep(int(wait) if short else 15 * (attempt + 1))
            continue
        raise ProviderUnavailable(f"{provider} {r.status_code}: {r.text[:200]}")
    raise ProviderUnavailable(f"{provider}: no answer")


def check():
    """One tiny call to each configured reserve model; prints the answer and
    the rate-limit headers, saving nothing."""
    names = configured()
    if not names:
        print("  No reserve model configured (MISTRAL_API_KEY, GITHUB_MODELS_TOKEN / GITHUB_TOKEN)")
    for name in names:
        t = time.time()
        try:
            text, headers = ask(name, 'Svara med JSON {"ok": true, "sprak": "svenska"} och inget annat.',
                                max_tokens=50, want_json=True)
            limits = {k: v for k, v in headers.items() if "ratelimit" in k.lower() or k.lower() == "retry-after"}
            print(f"  {name}: {time.time() - t:.1f}s  {text.strip()[:80]}")
            print(f"    limits: {json.dumps(limits) if limits else '(none reported)'}")
        except Exception as e:
            print(f"  {name}: ! {str(e)[:300]}")


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        check()
