"""
Shared utilities for the Russia-NATO/EU Hybrid Threat Monitor.

Handles: persistent JSON state, daily hourly-log files, and the wrapper
around the Gemini API that every module uses for its analysis.
"""
import json
import os
import re
import time
from datetime import datetime, date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
LOG_DIR = DATA_DIR / "logs"
STATE_PATH = DATA_DIR / "state.json"
CONFIG_PATH = ROOT / "config" / "methodology.json"
OUTPUT_DIR = ROOT / "reports"

DATA_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# A model on the Gemini API's free tier.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.8-flash"
THINKING_BUDGET = 2048

# Waits between attempts when the API is unreachable, ~15 minutes in all.
NETWORK_RETRY_DELAYS = [30, 60, 120, 240, 300, 300]
# An overloaded model (5xx) is tried this many more times, then the call
# moves to the other model (ask_model's fallback). Every attempt seems to
# count against the free tier's 20 a day: on 3 Nov six retries a call
# spent the main model's quota by 17:00 and the Nato brief failed.
OVERLOAD_RETRIES = 2
# A call that has not answered by then is dropped and retried as above: on
# 26 Oct one hung until the job's 60-minute limit. The daily sweep, the
# longest call, takes a few minutes.
REQUEST_TIMEOUT_MS = 10 * 60 * 1000

# The articles last handed to the model, as {ref, url, title, outlet}
# (news_sources.Pool.prompt_block). The model cites articles by ref; only
# those found here get a link, so a link in the app is one that was really
# fetched, never one the model made up.
LAST_SEARCH_RESULTS = []

# Every model call this process made, in order, as {model, requested,
# fallback}: which model actually answered, and whether that was another
# model than the one asked for (the main model unavailable). Read through
# calls_mark() and generated_by(), which stamp each output with the models
# that wrote it.
MODEL_CALLS = []


# --------------------------------------------------------------------------
# State persistence
# --------------------------------------------------------------------------
def _default_state():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        methodology = json.load(f)
    return {
        "methodology": methodology,
        "watchlist": methodology["default_watchlist"],
        "outlet_scores": {},
        "author_scores": {},
        "threat_index_history": [],
        "self_eval_log": [],
        "pending_proposal": None,
        "accepted_changes": [],
        "last_report_date": None,
    }


def load_state():
    if STATE_PATH.exists():
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    state = _default_state()
    save_state(state)
    return state


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------
# Hourly log files (one JSON file per calendar day, list of hourly entries)
# --------------------------------------------------------------------------
def resolve_proposal(state, decision):
    """Accept or deny the pending methodology proposal and persist it.
    Called from the CLI (--resolve), and from reply_checker when the
    recipient answers the report email."""
    proposal = state.get("pending_proposal")
    if not proposal:
        print("No pending proposal to resolve.")
        return None
    if decision == "accept":
        state["accepted_changes"].append(proposal["change_detail"])
        print(f"Accepted: {proposal['title']}")
    else:
        print(f"Denied: {proposal['title']}")
    state["pending_proposal"] = None
    save_state(state)
    return proposal


def _log_path_for(d: date) -> Path:
    return LOG_DIR / f"{d.isoformat()}_hourly.json"


def append_hourly_entry(entry: dict, when: datetime = None):
    when = when or datetime.now()
    path = _log_path_for(when.date())
    entries = []
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            entries = json.load(f)
    entry["timestamp"] = when.isoformat(timespec="minutes")
    entries.append(entry)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)


def load_hourly_log(d: date) -> list:
    path = _log_path_for(d)
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def archive_and_clear_log(d: date):
    """Called by the 04:00 report after it has consolidated the day's
    hourly log, so raw hourly granularity doesn't accumulate forever."""
    path = _log_path_for(d)
    if path.exists():
        archived = LOG_DIR / "archived_summaries.json"
        summaries = []
        if archived.exists():
            with open(archived, "r", encoding="utf-8") as f:
                summaries = json.load(f)
        with open(path, "r", encoding="utf-8") as f:
            entries = json.load(f)
        summaries.append({
            "date": d.isoformat(),
            "entry_count": len(entries),
            "corrections": sum(1 for e in entries if e.get("classification") == "CORRECTION"),
            "narrative_shifts": sum(1 for e in entries if e.get("classification") == "NARRATIVE_SHIFT"),
        })
        # keep only last 90 days of daily summaries
        summaries = summaries[-90:]
        with open(archived, "w", encoding="utf-8") as f:
            json.dump(summaries, f, indent=2, ensure_ascii=False)
        path.unlink()


# --------------------------------------------------------------------------
# Gemini API wrapper
# --------------------------------------------------------------------------
def get_client():
    from google import genai
    from google.genai import types
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Set it as an environment variable "
            "before running (see README.md)."
        )
    return genai.Client(api_key=api_key,
                        http_options=types.HttpOptions(timeout=REQUEST_TIMEOUT_MS))


_lite = []


def lite_model() -> str:
    """The light model for simple work (translation, extraction): LITE_MODEL
    or FORCES_SURVEY_MODEL, else the newest flash-lite the key can use, else
    None. On the free tier each model has its own daily quota, so work sent
    here never takes calls from the reports."""
    if _lite:
        return _lite[0]
    name = os.environ.get("LITE_MODEL") or os.environ.get("FORCES_SURVEY_MODEL")
    if not name:
        try:
            client = get_client()   # kept: the list pages lazily, and a dropped client is closed
            names = [m.name.removeprefix("models/") for m in client.models.list()]
        except Exception:
            names = []
        lite = [n for n in names if "flash-lite" in n and not re.search(r"preview|exp|tts|image|audio|live", n)]

        def version(n):
            m = re.search(r"gemini-(\d+)(?:\.(\d+))?", n)
            return (int(m[1]), int(m[2] or 0), -len(n)) if m else (0, 0, 0)
        name = max(lite, key=version) if lite else None
    _lite.append(name)
    return name


_third = []


def _gemini_version(n: str):
    m = re.search(r"gemini-(\d+)(?:\.(\d+))?", n)
    return (int(m[1]), int(m[2] or 0)) if m else (0, 0)


def third_model() -> str:
    """A third model for when both the main and the light one are spent or
    overloaded (Version 3.25): THIRD_MODEL, else the newest plain flash model
    the key can use that is neither of the other two (2.5 or newer, so it
    takes the thinking budget), else None. On the free tier it has a daily
    quota of its own."""
    if _third:
        return _third[0]
    name = os.environ.get("THIRD_MODEL")
    if not name:
        try:
            client = get_client()
            names = [m.name.removeprefix("models/") for m in client.models.list()]
        except Exception:
            names = []
        taken = {MODEL, lite_model()}
        flash = [n for n in names if "flash" in n and "lite" not in n and n not in taken
                 and not re.search(r"preview|exp|tts|image|audio|live|8b", n)
                 and _gemini_version(n) >= (2, 5)]
        name = max(flash, key=lambda n: (_gemini_version(n), -len(n))) if flash else None
    _third.append(name)
    return name


class ModelUnavailable(Exception):
    """The model is overloaded past OVERLOAD_RETRIES, or its quota is spent:
    worth trying the other model, unlike a bad request."""


class NoModelAvailable(RuntimeError):
    """ask_model found neither the model nor its fallback available (or no
    fallback was allowed). A RuntimeError, as before, for callers that
    catch that."""


_sha = []


def code_sha() -> str:
    """The commit the code runs from: GITHUB_SHA in Actions, else git."""
    if not _sha:
        sha = os.environ.get("GITHUB_SHA") or ""
        if not sha:
            try:
                import subprocess
                sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                                     text=True, timeout=10).stdout.strip()
            except Exception:
                sha = ""
        _sha.append(sha[:12] or None)
    return _sha[0]


def calls_mark() -> int:
    """A position in MODEL_CALLS: generated_by(since=mark) covers the calls after it."""
    return len(MODEL_CALLS)


def generated_by(since: int = 0) -> dict:
    """Which models wrote an output: {models, fallback_used, code_sha,
    calls} over the calls since `since` (calls_mark()). fallback_used is
    true when any of them ran on another model than the one asked for -
    the app then shows that a reserve model wrote it."""
    calls = MODEL_CALLS[since:]
    models = []
    for c in calls:
        if c["model"] not in models:
            models.append(c["model"])
    return {"models": models, "fallback_used": any(c["fallback"] for c in calls),
            "code_sha": code_sha(), "calls": len(calls)}


def main_model_failed(since: int = 0) -> bool:
    """True when a call since `since` asked for the main model and got another."""
    return any(c["fallback"] and c["requested"] == MODEL for c in MODEL_CALLS[since:])


def _ask_external(name, prompt, system, max_tokens, want_json, requested):
    """A call on a reserve model outside Gemini (model_providers), recorded
    like the others. Raises model_providers.ProviderUnavailable."""
    import model_providers
    text, _ = model_providers.ask(name, prompt, system=system, max_tokens=max_tokens, want_json=want_json)
    MODEL_CALLS.append({"model": name, "requested": requested, "fallback": name != requested})
    return text.strip()


def _external_chain(prompt, system, max_tokens, want_json, requested, why):
    """After Gemini's own models (Version 3.37): Mistral, then GitHub Models,
    as configured. Raises NoModelAvailable when none answers."""
    import model_providers
    tried = [why]
    for ext in model_providers.configured():
        print(f"  ! Gemini unavailable; this call runs on {ext} (reserve outside Gemini)")
        try:
            return _ask_external(ext, prompt, system, max_tokens, want_json, requested)
        except model_providers.ProviderUnavailable as e:
            print(f"  ! {ext} unavailable ({str(e)[:160]})")
            tried.append(f"{ext}: {str(e)[:160]}")
    raise NoModelAvailable("; ".join(tried))


def ask_model(prompt: str, system: str = None, max_tokens: int = 2000, model: str = None,
              fallback: str = None, want_json: bool = False) -> str:
    """Send a prompt to Gemini and return the text of the response. The
    model does not search (the free tier has no search grounding): the
    articles it should read go in the prompt (news_sources.py).

    On the main model (model=None) a spent quota or a model that stays
    overloaded moves the call to the light model, which has its own quota,
    so a report is written rather than lost. `fallback` names another model
    for that (MODEL lets a light-model call fall back to the main one)."""
    import model_providers
    if model_providers.is_external(model):
        try:
            return _ask_external(model, prompt, system, max_tokens, want_json, model)
        except model_providers.ProviderUnavailable as e:
            raise NoModelAvailable(str(e)) from e
    from google.genai import types
    config = types.GenerateContentConfig(
        system_instruction=system,
        # Gemini's thinking tokens count against the output limit, so give
        # them their own budget on top of the answer's.
        max_output_tokens=max_tokens + THINKING_BUDGET,
        thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET),
    )
    name = model or MODEL
    if fallback is None and name == MODEL:
        fallback = lite_model()
    used = name
    try:
        response = _generate_with_retry(get_client(), prompt, config, name)
    except ModelUnavailable as e:
        if not fallback or fallback == name:
            raise NoModelAvailable(str(e)) from e
        print(f"  ! {name} unavailable ({str(e)[:160]}); this call runs on {fallback} (reserve model)")
        try:
            response = _generate_with_retry(get_client(), prompt, config, fallback)
            used = fallback
        except ModelUnavailable as e2:
            # Both spent or overloaded: the third model, with a quota of its own.
            third = third_model()
            if not third or third in (name, fallback):
                return _external_chain(prompt, system, max_tokens, want_json, name,
                                       f"{name}: {str(e)[:200]}; {fallback}: {str(e2)[:200]}")
            print(f"  ! {fallback} unavailable too ({str(e2)[:120]}); this call runs on {third} (third model)")
            try:
                response = _generate_with_retry(get_client(), prompt, config, third)
            except Exception as e3:
                return _external_chain(prompt, system, max_tokens, want_json, name,
                                       f"{name}: {str(e)[:200]}; {fallback}: {str(e2)[:200]}; {third}: {str(e3)[:200]}")
            used = third
    MODEL_CALLS.append({"model": used, "requested": name, "fallback": used != name})

    candidate = (response.candidates or [None])[0]
    finish = getattr(candidate, "finish_reason", None)
    if finish is not None and getattr(finish, "name", str(finish)) == "MAX_TOKENS":
        print(f"  ! Gemini response hit max_tokens={max_tokens} - output is truncated")

    return (response.text or "").strip()


def _generate_with_retry(client, prompt, config, model):
    """client.models.generate_content, retried with long waits when the
    network is down, and OVERLOAD_RETRIES times when the model is
    overloaded (5xx); then ModelUnavailable. A 429 is retried only when
    Google says when to (retryDelay: the per-minute limit); without one the
    quota is spent or zero, and waiting would only burn Actions minutes
    (24 Oct: search grounding has no free quota). The spent daily quota (a
    PerDay quotaId) comes with a retryDelay of hours: not retried either.
    Both raise ModelUnavailable."""
    from google.genai import errors
    import httpx
    overloaded = 0
    for delay in NETWORK_RETRY_DELAYS + [None]:
        try:
            return client.models.generate_content(model=model, contents=prompt, config=config)
        except (errors.ServerError, errors.ClientError, httpx.TransportError) as e:
            code = getattr(e, "code", None)
            if isinstance(e, errors.ClientError):
                if code != 429:
                    raise
                if "retryDelay" not in str(e) or "PerDay" in str(e):
                    raise ModelUnavailable(str(e)) from e
            if isinstance(e, errors.ServerError):
                overloaded += 1
                if overloaded > OVERLOAD_RETRIES:
                    raise ModelUnavailable(str(e)) from e
            if delay is None:
                raise
            print(f"  ! Gemini API unavailable ({e}); retrying in {delay}s")
            time.sleep(delay)


def ask_model_json(prompt: str, system: str = None, max_tokens: int = 2000, model: str = None,
                   fallback: str = None) -> dict:
    """ask_model + extract_json, with one recovery attempt. The model
    sometimes spends the whole token budget on narrative analysis and
    gets cut off before the JSON. Rather than discard that work, hand the
    partial response back and ask for just the JSON object - on the model
    that wrote it, never another one: one answer is written by one model
    (a recovery on another model would mix two models' work and hide which
    one wrote the result)."""
    raw = ask_model(prompt, system=system, max_tokens=max_tokens, model=model, fallback=fallback, want_json=True)
    answered = MODEL_CALLS[-1]["model"] if MODEL_CALLS else (model or MODEL)
    try:
        return extract_json(raw)
    except ValueError as first_err:
        print(f"  ! JSON parse failed ({first_err}); retrying with the partial response as input")
        recovery_prompt = f"""{prompt}

Your previous answer was cut off or was not valid JSON. Here it is:

<previous_answer>
{raw}
</previous_answer>

Using ONLY the information in that previous answer, respond with the strict JSON object requested above and nothing else."""
        raw2 = ask_model(recovery_prompt, system=system, max_tokens=max_tokens, model=answered, fallback=False, want_json=True)
        return extract_json(raw2)


def extract_json(text: str) -> dict:
    """The model is asked to respond in strict JSON, but may wrap it in
    prose, code fences, or trailing commentary. This finds the first
    '{' or '[' and matches it to its REAL closing bracket by depth-
    counting (string-aware), rather than a greedy regex that grabs
    everything up to the LAST closing bracket in the whole response -
    which breaks the moment the model adds any text after the JSON."""
    text = re.sub(r"```json|```", "", text).strip()

    start = None
    for i, ch in enumerate(text):
        if ch in "{[":
            start = i
            open_ch = ch
            close_ch = "}" if ch == "{" else "]"
            break
    if start is None:
        _dump_debug(text)
        raise ValueError(f"No JSON found in model output (see data/logs/last_json_error.txt):\n{text[:300]}")

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError as e:
                    _dump_debug(text)
                    raise ValueError(
                        f"Found a JSON-like block but it didn't parse ({e}). "
                        f"Full response saved to data/logs/last_json_error.txt"
                    ) from e

    # Loop finished without depth returning to 0 - the JSON was cut off,
    # almost always because max_tokens was too low for this response.
    _dump_debug(text)
    raise ValueError(
        "JSON block never closed - the response was likely truncated by "
        "max_tokens. Full response saved to data/logs/last_json_error.txt"
    )


def _dump_debug(text: str):
    try:
        with open(LOG_DIR / "last_json_error.txt", "w", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


def masked(addresses) -> str:
    """Email addresses as "j***@***" for logs: the run logs of this
    public repo are public, so a full address never goes in one."""
    if isinstance(addresses, str):
        addresses = [a for a in addresses.split(",") if a.strip()]
    out = []
    for a in addresses:
        local, _, domain = a.strip().partition("@")
        out.append(f"{local[:1]}***@***" if domain else "***")
    return ", ".join(out)
