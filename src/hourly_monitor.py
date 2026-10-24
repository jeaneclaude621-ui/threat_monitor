"""
Runs every hour, 24x/day. For each watchlist thread, checks current
reporting against the last known snapshot and classifies what changed:
NEW_DEVELOPMENT, NO_CHANGE, CORRECTION, or NARRATIVE_SHIFT.

Usage:  python src/hourly_monitor.py
"""
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_state, save_state, ask_model_json, append_hourly_entry
from reply_checker import check_replies
from app_sync import push_updates
import feed_prefilter
import news_sources

SYSTEM = """You are an OSINT monitoring analyst. You track a specific news
thread and report ONLY what changed since the last check. Be precise and
skeptical. Never treat Russian state media (Sputnik, RT, TASS) or
unattributed social accounts as confirming evidence - note them only if
relevant to a disinformation pattern. Respond with STRICT JSON only, no
prose outside the JSON object."""

PROMPT_TEMPLATE = """Thread being tracked: {label}

Last known status: {last_snapshot}

The latest reporting found on this thread since it was last checked
({since}), newest first. Base your answer ONLY on these articles - you
cannot search, and your own knowledge may be outdated. Many will be
unrelated or repeat what is already known; ignore those.

{articles}

Compare that reporting to the last known status above and classify the change:

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
  "title_sv": "what changed as a short Swedish headline, max ~10 words",
  "summary_sv": "the summary in natural Swedish, max ~40 words",
  "new_snapshot": "updated 1-2 sentence status to replace the last known status with - 60 words maximum"
}}

Output the JSON object and nothing else: no preamble, no commentary
after it. Respect the length limits above - this
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
    app = news_sources.app_sources()
    app_articles = [s for s in app if s.get("kind") == "article"]
    # Shadow mode: records which threads the RSS prefilter would skip, but
    # every thread is still checked below. Run before the loop, which moves
    # each thread's last_checked. Its articles feed the threads' reading.
    prefilter, feed_articles = feed_prefilter.check(state["watchlist"], now,
                                                    feeds=news_sources.all_feeds(app))
    outcomes = {}

    def check_thread(thread):
        pool = news_sources.for_thread(thread, feed_articles, app_articles)
        prompt = PROMPT_TEMPLATE.format(label=thread["label"], last_snapshot=thread["last_snapshot"],
                                        since=thread.get("last_checked") or "never",
                                        articles=pool.prompt_block(60, record=False))
        # A multi-outlet delta does not fit in ~800 tokens; responses were
        # being truncated before the JSON closed. The Swedish title and
        # summary for the web app add ~300 tokens.
        return ask_model_json(prompt, system=SYSTEM, max_tokens=3000)

    def safe_check(thread):
        try:
            return check_thread(thread)
        except Exception as e:
            print(f"  ! {thread['id']}: failed ({e})")
            return None

    # A Gemini call takes one to three minutes and Actions bills the
    # wall clock, so three threads at a time; the results are applied to
    # the state one by one below.
    with ThreadPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(safe_check, state["watchlist"]))

    app_updates = []
    for thread, result in zip(state["watchlist"], results):
        if result is None:
            continue

        classification = result.get("classification", "NO_CHANGE")
        outcomes[thread["id"]] = classification
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
        if classification != "NO_CHANGE":
            app_updates.append({**entry, "title_sv": result.get("title_sv"),
                                "summary_sv": result.get("summary_sv"), "when": now})

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
    feed_prefilter.record_shadow(prefilter, outcomes, now)
    # The web app's "Löpande i dag" feed.
    push_updates(app_updates)
    print("Hourly monitor done.\n")


if __name__ == "__main__":
    run_once()
