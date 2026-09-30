"""
Shared utilities for the Russia-NATO/EU Hybrid Threat Monitor.

Handles: persistent JSON state, daily hourly-log files, and the wrapper
around the Anthropic API (with the web_search tool turned on) that every
module uses to do its research.
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

MODEL = "claude-sonnet-4-6"

# Waits between attempts when the network is down. launchd can start a job
# during a brief maintenance wake before Wi-Fi/DNS is back (27 Sep: the
# report died on its first API call), so give the network ~15 minutes.
NETWORK_RETRY_DELAYS = [30, 60, 120, 240, 300, 300]

# Every page the last web-search call actually retrieved, as {url, title}.
# The sweep asks the model for article links; only links found here are
# kept, so a link in the app is one that was really fetched, never one the
# model made up.
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
# Claude API wrapper
# --------------------------------------------------------------------------
def get_client():
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Set it as an environment variable "
            "before running (see README.md)."
        )
    return anthropic.Anthropic(api_key=api_key)


def ask_claude(prompt: str, system: str = None, max_tokens: int = 2000, use_search: bool = True) -> str:
    """Send a prompt to Claude, optionally with web_search enabled, and
    return the concatenated text of the response."""
    client = get_client()
    kwargs = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system
    if use_search:
        kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]

    # Web search can involve multiple tool round-trips; the SDK's
    # .messages.create already returns the final assistant turn for
    # single-turn tool use, but if the model stops on a tool call we loop.
    response = _create_with_retry(client, kwargs)
    while response.stop_reason == "tool_use":
        # The API executes web_search server-side for this tool type, so a
        # plain create() call already resolves it in practice; this loop is
        # a safety net for future multi-turn tool behavior.
        response = _create_with_retry(client, kwargs)
        break

    if use_search:
        LAST_SEARCH_RESULTS[:] = _search_results(response)

    if response.stop_reason == "max_tokens":
        print(f"  ! Claude response hit max_tokens={max_tokens} - output is truncated")

    parts = [b.text for b in response.content if getattr(b, "type", "") == "text"]
    return "\n".join(parts).strip()


def _search_results(response) -> list:
    """URLs and titles from web_search result blocks and text citations."""
    seen, out = set(), []

    def add(url, title):
        if url and url not in seen:
            seen.add(url)
            out.append({"url": url, "title": title or None})

    for block in response.content:
        kind = getattr(block, "type", "")
        if kind == "web_search_tool_result" and isinstance(getattr(block, "content", None), list):
            for r in block.content:
                add(getattr(r, "url", None), getattr(r, "title", None))
        elif kind == "text":
            for c in getattr(block, "citations", None) or []:
                add(getattr(c, "url", None), getattr(c, "title", None))
    return out


def _create_with_retry(client, kwargs):
    """client.messages.create, retried with long waits on connection
    errors. The SDK's own retries (a few seconds apart) cover API hiccups
    but not a Mac whose network is still coming up after sleep."""
    import anthropic
    for delay in NETWORK_RETRY_DELAYS + [None]:
        try:
            # The SDK refuses non-streaming calls whose max_tokens implies
            # more than 10 minutes (~21k tokens); stream those instead.
            if kwargs.get("max_tokens", 0) > 16000:
                with client.messages.stream(**kwargs) as stream:
                    return stream.get_final_message()
            return client.messages.create(**kwargs)
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            if delay is None:
                raise
            print(f"  ! Claude API unreachable ({e}); retrying in {delay}s")
            time.sleep(delay)


def ask_claude_json(prompt: str, system: str = None, max_tokens: int = 2000, use_search: bool = True) -> dict:
    """ask_claude + extract_json, with one recovery attempt. When web
    search is on, the model sometimes spends the whole token budget on
    searches and narrative analysis and gets cut off before the JSON.
    Rather than discard that work, hand the partial response back (no
    search this time) and ask for just the JSON object."""
    raw = ask_claude(prompt, system=system, max_tokens=max_tokens, use_search=use_search)
    try:
        return extract_json(raw)
    except ValueError as first_err:
        print(f"  ! JSON parse failed ({first_err}); retrying with the partial response as input")
        recovery_prompt = f"""{prompt}

Your previous answer was cut off or was not valid JSON. Here it is:

<previous_answer>
{raw}
</previous_answer>

Using ONLY the information in that previous answer (do not search again),
respond with the strict JSON object requested above and nothing else."""
        raw2 = ask_claude(recovery_prompt, system=system, max_tokens=max_tokens, use_search=False)
        return extract_json(raw2)


def extract_json(text: str) -> dict:
    """Claude is asked to respond in strict JSON, but may wrap it in
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
