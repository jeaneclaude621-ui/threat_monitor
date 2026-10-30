"""
Runs at 12:00, 16:00 and 21:00 Stockholm (the 04:00 daily report covers
the night). Checks every watchlist thread's current reporting
against its last known snapshot and classifies what changed:
NEW_DEVELOPMENT, NO_CHANGE, CORRECTION, or NARRATIVE_SHIFT.

All threads go to Gemini in one call: the free tier allows 20 calls a
day per model, and one call per thread used them up (Oct 2026).

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

SYSTEM = """You are an OSINT monitoring analyst. You track several news
threads and report ONLY what changed on each since its last check. Be
precise and skeptical. Never treat Russian state media (Sputnik, RT, TASS)
or unattributed social accounts as confirming evidence - note them only
if relevant to a disinformation pattern. Respond with STRICT JSON only,
no prose outside the JSON object."""

THREAD_TEMPLATE = """=== Thread "{id}": {label}

Last known status: {last_snapshot}

The latest reporting found on this thread since it was last checked
({since}), newest first:

{articles}"""

PROMPT_TEMPLATE = """You are tracking {count} threads. Each comes with its last known
status and the reporting found on it since its last check. Base your
answers ONLY on these articles - you cannot search, and your own knowledge
may be outdated. Many will be unrelated or repeat what is already known;
ignore those. Judge each thread on its own articles only.

{threads}

=== End of threads

For each thread, compare its reporting to its last known status and
classify the change:

- "NEW_DEVELOPMENT": something materially new happened
- "NO_CHANGE": no meaningful update since last check
- "CORRECTION": an outlet corrected, retracted, or walked back a claim
  it previously reported on this thread
- "NARRATIVE_SHIFT": the framing/emphasis changed without a formal
  correction being issued

Respond as strict JSON with one entry per thread, keyed by the thread
ids in quotes above ({ids}):
{{
  "threads": {{
    "<thread id>": {{
      "classification": "...",
      "outlets": ["outlet names involved - the 5 most significant, no more"],
      "correcting_outlet": "outlet name if classification is CORRECTION, else null",
      "byline": "journalist name if attributable, else null",
      "summary": "1-2 sentence summary of what changed - 60 words maximum",
      "title_sv": "what changed as a short Swedish headline, max ~10 words",
      "summary_sv": "the summary in natural Swedish, max ~40 words",
      "new_snapshot": "updated 1-2 sentence status to replace the last known status with - 60 words maximum"
    }}
  }}
}}

Output the JSON object and nothing else: no preamble, no commentary
after it. Respect the length limits above - this
is a scannable delta, not a full report."""

# Output tokens per thread: a multi-outlet delta does not fit in ~800
# tokens, and the Swedish title and summary for the web app add ~300.
TOKENS_PER_THREAD = 3000

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

    # Gathering a thread's articles queries Google News and GDELT, so
    # three threads at a time.
    def gather(thread):
        try:
            articles = news_sources.for_thread(thread, feed_articles, app_articles).prompt_block(60, record=False)
        except Exception as e:
            print(f"  ! {thread['id']}: could not gather articles ({e})")
            articles = "(no articles found)"
        return THREAD_TEMPLATE.format(id=thread["id"], label=thread["label"],
                                      last_snapshot=thread["last_snapshot"],
                                      since=thread.get("last_checked") or "never",
                                      articles=articles)

    with ThreadPoolExecutor(max_workers=3) as ex:
        blocks = list(ex.map(gather, state["watchlist"]))

    ids = [t["id"] for t in state["watchlist"]]
    prompt = PROMPT_TEMPLATE.format(count=len(ids), threads="\n\n".join(blocks),
                                    ids=", ".join(ids))
    try:
        answers = ask_model_json(prompt, system=SYSTEM,
                                 max_tokens=TOKENS_PER_THREAD * len(ids)).get("threads")
    except Exception as e:
        print(f"  ! thread check failed ({e})")
        answers = None
    if answers is not None and not isinstance(answers, dict):
        print("  ! thread check failed (no \"threads\" object in Gemini's answer)")
        answers = None
    results = []
    for thread in state["watchlist"]:
        result = (answers or {}).get(thread["id"])
        if answers is not None and not isinstance(result, dict):
            print(f"  ! {thread['id']}: missing from Gemini's answer")
        results.append(result if isinstance(result, dict) else None)

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
