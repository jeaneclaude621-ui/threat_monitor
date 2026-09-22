"""
Runs every hour, 24x/day. For each watchlist thread, checks current
reporting against the last known snapshot and classifies what changed:
NEW_DEVELOPMENT, NO_CHANGE, CORRECTION, or NARRATIVE_SHIFT.

Usage:  python src/hourly_monitor.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_state, save_state, ask_claude_json, append_hourly_entry
from reply_checker import check_replies

SYSTEM = """You are an OSINT monitoring analyst. You track a specific news
thread and report ONLY what changed since the last check. Be precise and
skeptical. Never treat Russian state media (Sputnik, RT, TASS) or
unattributed social accounts as confirming evidence - note them only if
relevant to a disinformation pattern. Respond with STRICT JSON only, no
prose outside the JSON object."""

PROMPT_TEMPLATE = """Thread being tracked: {label}

Last known status: {last_snapshot}

Search for the latest reporting on this thread (last few hours).
Compare it to the last known status above and classify the change:

- "NEW_DEVELOPMENT": something materially new happened
- "NO_CHANGE": no meaningful update since last check
- "CORRECTION": an outlet corrected, retracted, or walked back a claim
  it previously reported on this thread
- "NARRATIVE_SHIFT": the framing/emphasis changed without a formal
  correction being issued

Respond as strict JSON:
{{
  "classification": "...",
  "outlets": ["outlet names involved - the 5 most significant, no more"],
  "correcting_outlet": "outlet name if classification is CORRECTION, else null",
  "byline": "journalist name if attributable, else null",
  "summary": "1-2 sentence summary of what changed - 60 words maximum",
  "new_snapshot": "updated 1-2 sentence status to replace the last known status with - 60 words maximum"
}}

Output the JSON object and nothing else: no preamble, no notes on your
searches, no commentary after it. Respect the length limits above - this
is a scannable hourly delta, not a full report."""


def update_outlet_score(state, outlet, positive_transparency=None, contradiction=False):
    scores = state["outlet_scores"].setdefault(
        outlet, {"corrections_issued": 0, "silent_or_missed": 0, "contradictions_uncorrected": 0}
    )
    if positive_transparency:
        scores["corrections_issued"] += 1
    if contradiction:
        scores["contradictions_uncorrected"] += 1


def update_author_score(state, byline, event_type):
    if not byline:
        return
    rec = state["author_scores"].setdefault(
        byline, {"corrections": 0, "contradictions": 0, "confirmed_calls": 0, "evidence_log": []}
    )
    if event_type == "CORRECTION":
        rec["corrections"] += 1
    rec["evidence_log"].append({"date": datetime.now().isoformat(timespec="minutes"), "event": event_type})
    rec["evidence_log"] = rec["evidence_log"][-25:]  # keep recent evidence only


def run_once():
    state = load_state()
    now = datetime.now()
    print(f"[{now.isoformat(timespec='minutes')}] Hourly monitor starting "
          f"({len(state['watchlist'])} threads)")
    check_replies(state)

    for thread in state["watchlist"]:
        prompt = PROMPT_TEMPLATE.format(label=thread["label"], last_snapshot=thread["last_snapshot"])
        try:
            # Web search + a multi-outlet delta does not fit in ~800 tokens;
            # responses were being truncated before the JSON closed.
            result = ask_claude_json(prompt, system=SYSTEM, max_tokens=2500)
        except Exception as e:
            print(f"  ! {thread['id']}: failed ({e})")
            continue

        classification = result.get("classification", "NO_CHANGE")
        print(f"  - {thread['id']}: {classification}")

        entry = {
            "thread_id": thread["id"],
            "thread_label": thread["label"],
            "classification": classification,
            "outlets": result.get("outlets", []),
            "correcting_outlet": result.get("correcting_outlet"),
            "byline": result.get("byline"),
            "summary": result.get("summary", ""),
        }
        append_hourly_entry(entry, when=now)

        if classification == "CORRECTION" and result.get("correcting_outlet"):
            update_outlet_score(state, result["correcting_outlet"], positive_transparency=True)
            update_author_score(state, result.get("byline"), "CORRECTION")
        elif classification == "NARRATIVE_SHIFT":
            for outlet in result.get("outlets", []):
                update_outlet_score(state, outlet, contradiction=True)

        if result.get("new_snapshot"):
            thread["last_snapshot"] = result["new_snapshot"]
        thread["last_checked"] = now.isoformat(timespec="minutes")

    save_state(state)
    print("Hourly monitor done.\n")


if __name__ == "__main__":
    run_once()
