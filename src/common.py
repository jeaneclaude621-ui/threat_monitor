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

# Waits between attempts when the API is unreachable or overloaded, ~15
# minutes in all.
NETWORK_RETRY_DELAYS = [30, 60, 120, 240, 300, 300]

# The articles last handed to the model, as {ref, url, title, outlet}
# (news_sources.Pool.prompt_block). The model cites articles by ref; only
# those found here get a link, so a link in the app is one that was really
# fetched, never one the model made up.
LAST_SEARCH_RESULTS = []


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
    """Called by the 05:00 report after it has consolidated the day's
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
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Set it as an environment variable "
            "before running (see README.md)."
        )
    return genai.Client(api_key=api_key)


def ask_model(prompt: str, system: str = None, max_tokens: int = 2000) -> str:
    """Send a prompt to Gemini and return the text of the response. The
    model does not search (the free tier has no search grounding): the
    articles it should read go in the prompt (news_sources.py)."""
    from google.genai import types
    config = types.GenerateContentConfig(
        system_instruction=system,
        # Gemini's thinking tokens count against the output limit, so give
        # them their own budget on top of the answer's.
        max_output_tokens=max_tokens + THINKING_BUDGET,
        thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET),
    )
    response = _generate_with_retry(get_client(), prompt, config)

    candidate = (response.candidates or [None])[0]
    finish = getattr(candidate, "finish_reason", None)
    if finish is not None and getattr(finish, "name", str(finish)) == "MAX_TOKENS":
        print(f"  ! Gemini response hit max_tokens={max_tokens} - output is truncated")

    return (response.text or "").strip()


def _generate_with_retry(client, prompt, config):
    """client.models.generate_content, retried with long waits when the
    network is down or the API is overloaded (5xx). A 429 is retried only
    when Google says when to (retryDelay: the per-minute limit); without
    one the quota is spent or zero, and waiting would only burn Actions
    minutes (24 Oct: search grounding has no free quota)."""
    from google.genai import errors
    import httpx
    for delay in NETWORK_RETRY_DELAYS + [None]:
        try:
            return client.models.generate_content(model=MODEL, contents=prompt, config=config)
        except (errors.ServerError, errors.ClientError, httpx.TransportError) as e:
            code = getattr(e, "code", None)
            if isinstance(e, errors.ClientError) and (code != 429 or "retryDelay" not in str(e)):
                raise
            if delay is None:
                raise
            print(f"  ! Gemini API unavailable ({e}); retrying in {delay}s")
            time.sleep(delay)


def ask_model_json(prompt: str, system: str = None, max_tokens: int = 2000) -> dict:
    """ask_model + extract_json, with one recovery attempt. The model
    sometimes spends the whole token budget on narrative analysis and
    gets cut off before the JSON. Rather than discard that work, hand the
    partial response back and ask for just the JSON object."""
    raw = ask_model(prompt, system=system, max_tokens=max_tokens)
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
        raw2 = ask_model(recovery_prompt, system=system, max_tokens=max_tokens)
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
