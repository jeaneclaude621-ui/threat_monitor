"""
Runs once a day at 05:00 CET. Consolidates the day's hourly monitoring,
self-checks yesterday's assessments against what actually happened,
does a broad research sweep for new stories, recomputes the two threat
indices (general, and a 30-day forecast), refreshes the watchlist, generates one proposed methodology
change, and builds the PPTX.

Usage:
    python src/daily_report.py                    # run the daily report
    python src/daily_report.py --resolve accept    # accept pending proposal
    python src/daily_report.py --resolve deny      # deny pending proposal
"""
import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    load_state, save_state, ask_claude_json,
    load_hourly_log, archive_and_clear_log, resolve_proposal, OUTPUT_DIR,
)
from pptx_builder import build_deck
from mailer import send_daily_email
from reply_checker import check_replies
from podcast import build_podcast
from executive_sv import build_executive_safe
from app_data import enrich_events, SWEEP_EVENT_FIELDS, SWEEP_EVENT_JSON
from app_sync import pull_assessments, push_report, backup_app
import common
import operator_weight

SYSTEM = """You are a senior OSINT analyst producing a daily intelligence
synthesis on Russia's posture toward NATO/EU/Ukraine. You cross-reference
mainstream, wire-service and official sources. You NEVER treat Russian
state media (Sputnik, RT, TASS) or unattributed/bot-suspected social
accounts as part of the credibility-weighted evidence base - log them
only under disinformation tracking. Respond with STRICT JSON only."""


# --------------------------------------------------------------------------
# 1. Self-check: did yesterday's assessments hold up?
# --------------------------------------------------------------------------
def run_self_check(state, yesterday_report):
    if not yesterday_report:
        return {"summary": "No prior report to self-check (first run).", "log_entry": None}

    claims = [{"id": e.get("id"), "title": e["title"], "detail": e["detail"], "score": e["score"]}
              for e in yesterday_report.get("events", [])]
    prompt = f"""Yesterday's report scored these claims/events:
{json.dumps(claims, indent=2)}

For each, search for what has been reported SINCE, and classify:
CONFIRMED (subsequent reporting supports it), CONTRADICTED (subsequent
reporting undermines or reverses it), or UNRESOLVED (not enough new
information either way).

Respond as strict JSON:
{{
  "results": [{{"id": "the claim's id, copied", "title": "...", "outcome": "CONFIRMED|CONTRADICTED|UNRESOLVED", "note": "short reason"}}],
  "confirmed_count": 0,
  "contradicted_count": 0,
  "unresolved_count": 0,
  "accuracy_pct": 0,
  "summary_sentence": "one sentence summarizing the self-check for a status slide"
}}

Do NOT write any analysis, commentary or per-claim reasoning before the
JSON - put short reasons in each "note" field. Your entire reply must be
the JSON object."""
    try:
        # Six claims x web search + reasoning + JSON does not fit in ~2k
        # tokens; the response was getting truncated before the JSON.
        result = ask_claude_json(prompt, system=SYSTEM, max_tokens=6000)
    except Exception as e:
        return {"summary": f"Self-check failed to run ({e}).", "log_entry": None}

    log_entry = {
        "date": date.today().isoformat(),
        "accuracy_pct": result.get("accuracy_pct"),
        "confirmed": result.get("confirmed_count"),
        "contradicted": result.get("contradicted_count"),
        "unresolved": result.get("unresolved_count"),
    }
    state["self_eval_log"].append(log_entry)
    state["self_eval_log"] = state["self_eval_log"][-90:]
    # Per-event outcomes, for the app and the operator's track record.
    ids = {e.get("id") for e in yesterday_report.get("events", [])}
    results = [{"event_id": r.get("id"), "outcome": r.get("outcome"), "note": r.get("note", "")}
               for r in result.get("results", [])
               if r.get("id") in ids and r.get("outcome") in ("CONFIRMED", "CONTRADICTED", "UNRESOLVED")]
    return {"summary": result.get("summary_sentence", "Self-check complete."), "log_entry": log_entry,
            "results": results}


# --------------------------------------------------------------------------
# Threat indices: shared by the daily sweep and src/recalibrate.py, so a
# recalibrated history is scored by exactly the rules used going forward.
# --------------------------------------------------------------------------
def index_instructions(m, history_desc, prior):
    anchors_desc = "\n".join(f"- {k}: {v}" for k, v in sorted(m.get("index_anchors", {}).items(), key=lambda kv: int(kv[0])))
    return f"""2. Two NATO/EU-Russia threat indices (1-10), both scored against these
   anchors - each band names the observable condition that must be met:
{anchors_desc}

   {m.get("index_scoring_note", "")}

   Recent index values (general / 30-day): {history_desc}
   Yesterday's general value: {prior}

   GENERAL INDEX - where the relationship stands today. Before choosing
   it, do this explicitly:
   a) list what escalated in the last 24h;
   b) list what de-escalated, stabilised, or failed to materialise -
      talks held, restraint shown, a threatened action not taken, a
      feared attribution not confirmed. If you find nothing, say so,
      but look for it with the same effort as for escalation;
   c) choose the anchor band today's evidence actually meets, BEFORE
      you look at yesterday's number. A band's condition must be met,
      not merely approached: if band 8 requires fatalities on NATO/EU
      territory and there were none, the band is not 8, however severe
      the fighting inside Ukraine was.
   d) give "threat_index" as that band plus or minus at most 0.5, to
      place today within the band. A value further from the band than
      that will be rejected. The index is derived from the band; it is
      not a separate judgment anchored on yesterday.
   The index may go down as well as up. Do not carry yesterday's value
   forward out of caution: an unchanged value must be defended by
   today's evidence just as a changed one must. Prior values are given
   for trend context only and carry no evidential weight.

   30-DAY INDEX - a forecast: the anchor band you expect to best
   describe the relationship over the next 30 days. Base it on dated,
   known drivers inside that window (deadlines, votes, summits,
   exercises, expiring measures, announced deployments) and on the
   direction of current trends - list them in "forecast_drivers", each
   marked up or down. It may be above today's general index (a known
   flashpoint is approaching) or below it (pressure is expected to ease).
   Equal is fine when the drivers balance out, but argue it from them -
   do not default to today's value. Give "index_band_30d" and
   "threat_index_30d" as that band plus or minus at most 0.5, same rule
   as above.
"""


INDEX_JSON_FIELDS = """  "threat_index": 0.0,
  "threat_index_justification": "...",
  "index_band": 0,
  "escalation_factors": ["..."],
  "deescalation_factors": ["..."],
  "index_delta_reason": "why it moved from yesterday's value, or why it did not",
  "threat_index_30d": 0.0,
  "index_band_30d": 0,
  "threat_index_30d_justification": "...",
  "forecast_drivers": [{"when": "date or window", "driver": "...", "direction": "up|down"}],"""


def enforce_bands(result):
    """The band is the evidence-based judgment; the index is derived from
    it. Left free, the model anchors on yesterday's number and the index
    only ever ratchets upward - so hold each index to the band it chose."""
    for idx_key, band_key in (("threat_index", "index_band"), ("threat_index_30d", "index_band_30d")):
        idx, band = result.get(idx_key), result.get(band_key)
        if band and idx is not None and abs(idx - band) > 0.5:
            corrected = round(band + max(-0.5, min(0.5, idx - band)), 1)
            print(f"  ! {idx_key} {idx} inconsistent with its own anchor band {band} - corrected to {corrected}")
            result[idx_key] = corrected
    return result


# --------------------------------------------------------------------------
# 2. Broad sweep: fresh event log + both threat indices for today
# --------------------------------------------------------------------------
def run_broad_sweep(state, hourly_entries):
    tiers_desc = "\n".join(f"- {t['name']} ({t['range'][0]}-{t['range'][1]}): {', '.join(t['examples'])}" for t in state["methodology"]["tiers"])
    m = state["methodology"]
    history = [h for h in state["threat_index_history"] if h["date"] != date.today().isoformat()][-7:]
    history_desc = ", ".join(f"{h['date']} = {h['value']} / {h.get('value_30d', '-')}" for h in history) or "(no history yet)"
    prior = history[-1]["value"] if history else None
    accepted_notes = "\n".join(f"- {c}" for c in state["accepted_changes"]) or "(none yet)"
    hourly_summary = "\n".join(f"- [{e['classification']}] {e['thread_label']}: {e['summary']}" for e in hourly_entries) or "(no hourly entries logged)"
    operator_desc = operator_weight.prompt_block()
    threads_desc = "\n".join(f"- {t['id']}: {t['label']}" for t in state["watchlist"])
    named = m.get("named_sources", [])
    named_desc = "\n".join(f"- {n['name']} (site:{n['domain']}, tier {n['tier']}, {n['lang']}): {n['use']}"
                           for n in named) or "(none)"

    prompt = f"""Search mainstream media for the last 24 hours of reporting on
Russia's hybrid activity, threats, and posture toward NATO/EU/Ukraine.

Credibility tiers to use when scoring each item (1-10):
{tiers_desc}

Named sources - besides the general search, run targeted searches on
each of these (e.g. "site:cornucopia.se Ukraina") and use what is new
from the last 24h. Swedish-language items: read them in Swedish, write
the English fields in English as usual, and name the outlet exactly as
given here. Each keeps its listed tier; a tier 4 source adds analysis
and context but never confirms a claim on its own:
{named_desc}

Additional accepted methodology refinements to apply:
{accepted_notes}

Today's hourly monitoring already logged these thread updates - factor
them in, don't just repeat them:
{hourly_summary}

The intelligence operator's own assessments of earlier articles
(+2 very credible ... -2 not credible; weight decays with age). Give them
HIGH weight but they are NOT decisive: they inform how much you trust an
outlet or a claim, they never on their own confirm or refute one. Score
each event on the evidence as usual - the operator's effect on event
scores is applied separately in code. For the general index, state in
"operator_effect_on_index" how many points (signed) operator input moved
it and why in "operator_effect_reason_sv" (Swedish, one sentence, naming
the assessment ids in brackets); 0 if it did not.
{operator_desc}

Produce:
1. Up to 6 of the most important events from the last 24h, each scored
   for credibility per the tiers above, with the corroborating outlets named.
   {SWEEP_EVENT_FIELDS}
   Watchlist threads (for "thread_id"):
{threads_desc}
{index_instructions(m, history_desc, prior)}
3. A one-sentence "top development" headline.
4. Up to 4 "deception watch" items - recurring Kremlin narrative/denial
   patterns observed in the last 24h (not scored, tracked separately).
5. Up to 3 "key signals" - short phrases for a sidebar.

Respond as strict JSON:
{{
  "events": [{SWEEP_EVENT_JSON}],
{INDEX_JSON_FIELDS}
  "operator_effect_on_index": 0.0,
  "operator_effect_reason_sv": "...",
  "top_development": "...",
  "deception_items": [{{"heading": "...", "body": "..."}}],
  "key_signals": ["..."]
}}"""
    # The escalation/de-escalation/delta fields pushed this past 5000, the
    # 30-day forecast another 1500, the app fields (Swedish text, topics,
    # countries, article links) roughly 3000, and the per-article Swedish
    # summaries with known/unknown lists about 4000 more.
    result = ask_claude_json(prompt, system=SYSTEM, max_tokens=22000)

    enforce_bands(result)
    enrich_events(result.get("events", []), date.today().isoformat(), common.LAST_SEARCH_RESULTS,
                  {t["id"] for t in state["watchlist"]})
    trace = operator_weight.apply_to_events(result.get("events", []))
    result["operator_influence"] = operator_weight.cap_index_effect(result, trace)
    idx = result.get("threat_index")
    if prior is not None and idx is not None and abs(idx - prior) >= 1.5:
        print(f"  ! Threat index moved {prior} -> {idx} in one day - check the justification")
    if not result.get("deescalation_factors"):
        print("  ! No de-escalation factors identified - index may be drifting upward unchecked")
    return result


# --------------------------------------------------------------------------
# 3. Narrative stability slide data (from today's hourly log)
# --------------------------------------------------------------------------
def build_narrative_stability(state, hourly_entries):
    by_thread = {}
    for e in hourly_entries:
        by_thread.setdefault(e["thread_id"], []).append(e)

    rows = []
    for thread in state["watchlist"]:
        entries = by_thread.get(thread["id"], [])
        if any(e["classification"] == "CORRECTION" for e in entries):
            status, summary = "corrected", next(e["summary"] for e in entries if e["classification"] == "CORRECTION")
        elif any(e["classification"] == "NARRATIVE_SHIFT" for e in entries):
            status, summary = "shifted", next(e["summary"] for e in entries if e["classification"] == "NARRATIVE_SHIFT")
        elif any(e["classification"] == "NEW_DEVELOPMENT" for e in entries):
            status, summary = "new", next(e["summary"] for e in entries if e["classification"] == "NEW_DEVELOPMENT")
        else:
            status, summary = "stable", "No meaningful change across today's hourly checks."
        rows.append({"thread": thread["label"].split(":")[0], "summary": summary, "status": status})
    return rows


# --------------------------------------------------------------------------
# 4. Refresh the watchlist (keep it at configured size)
# --------------------------------------------------------------------------
def refresh_watchlist(state, sweep_result):
    size = state["methodology"]["watchlist_size"]
    prompt = f"""Current watchlist threads:
{json.dumps([t['label'] for t in state['watchlist']], indent=2)}

Today's top events:
{json.dumps(sweep_result.get('events', []), indent=2)}

Decide if any current thread is now stale/resolved and should be dropped,
and whether any new thread from today's events deserves to be added.
Keep the total at exactly {size} threads. Respond as strict JSON:
{{"watchlist": [{{"id": "short-kebab-id", "label": "..."}}]}}"""
    try:
        # Six ids plus labels describing today's events does not fit in 800.
        result = ask_claude_json(prompt, system=SYSTEM, max_tokens=2000, use_search=False)
        new_list = result.get("watchlist", [])
        if len(new_list) == size:
            existing_by_id = {t["id"]: t for t in state["watchlist"]}
            state["watchlist"] = [
                existing_by_id.get(t["id"], {"id": t["id"], "label": t["label"], "last_snapshot": "New thread, no prior snapshot.", "last_checked": None})
                for t in new_list
            ]
    except Exception as e:
        print(f"  ! watchlist refresh failed, keeping existing list ({e})")


# --------------------------------------------------------------------------
# 5. Proposal generation (only if none pending)
# --------------------------------------------------------------------------
def generate_proposal(state):
    if state.get("pending_proposal"):
        return state["pending_proposal"], True  # still pending from before

    prompt = f"""Review this monitoring system's recent track record:

Self-evaluation log (last 10 entries): {json.dumps(state['self_eval_log'][-10:], indent=2)}
Outlet transparency scores: {json.dumps(state['outlet_scores'], indent=2)}
Author scores: {json.dumps(state['author_scores'], indent=2)}
Current methodology notes already accepted: {json.dumps(state['accepted_changes'], indent=2)}

Propose exactly ONE specific, scoped improvement to how sources are
weighted or verified, to make the system more reliable and credible.
It must be simple enough to accept or deny in one sentence. Do not
propose vague things like "be more careful" - propose a concrete rule.

Respond as strict JSON:
{{"title": "...", "rationale": "...", "change_detail": "..."}}"""
    proposal = ask_claude_json(prompt, system=SYSTEM, max_tokens=1500, use_search=False)
    proposal["date_proposed"] = date.today().isoformat()
    proposal["status"] = "pending"
    state["pending_proposal"] = proposal
    return proposal, False


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def load_outcomes() -> dict:
    """event id -> self-check outcome, from every saved report."""
    outcomes = {}
    for f in sorted(OUTPUT_DIR.glob("*_report_data.json")):
        try:
            for r in json.load(open(f, encoding="utf-8")).get("self_check_results", []):
                outcomes[r["event_id"]] = r["outcome"]
        except (OSError, ValueError, KeyError):
            continue
    return outcomes


def load_yesterday_report():
    path = OUTPUT_DIR / f"{(date.today() - timedelta(days=1)).isoformat()}_report_data.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def top_authors_summary(state):
    if not state["author_scores"]:
        return "Building history - check back after a few days of monitoring."
    ranked = sorted(
        state["author_scores"].items(),
        key=lambda kv: kv[1]["corrections"] - kv[1]["contradictions"] + kv[1]["confirmed_calls"],
        reverse=True,
    )[:3]
    parts = []
    for name, rec in ranked:
        parts.append(f"{name}: {rec['corrections']} self-corrections, {rec['contradictions']} uncorrected contradictions")
    return " | ".join(parts)


def run_daily_report():
    state = load_state()
    today = date.today()
    print(f"[{datetime.now().isoformat(timespec='minutes')}] Daily report starting for {today.isoformat()}")

    # Pick up any "accept"/"deny" reply to yesterday's email before we
    # decide whether to generate a fresh proposal below.
    check_replies(state)
    # The operator's swipes from the web app, before they weigh in below.
    pull_assessments()

    yesterday_report = load_yesterday_report()
    self_check = run_self_check(state, yesterday_report)

    hourly_entries = load_hourly_log(today) + load_hourly_log(today - timedelta(days=1))
    sweep = run_broad_sweep(state, hourly_entries)
    narrative_rows = build_narrative_stability(state, hourly_entries)
    refresh_watchlist(state, sweep)

    earlier = [h for h in state["threat_index_history"] if h["date"] != today.isoformat()]
    prior_value = earlier[-1]["value"] if earlier else sweep["threat_index"]
    trend_label = "Trending up" if sweep["threat_index"] > prior_value else ("Trending down" if sweep["threat_index"] < prior_value else "Stable")
    # A second run on the same day (a manual rerun) replaces that day's
    # entry instead of adding a duplicate date to the trend chart.
    state["threat_index_history"] = [h for h in state["threat_index_history"] if h["date"] != today.isoformat()]
    state["threat_index_history"].append({"date": today.isoformat(), "value": sweep["threat_index"],
                                          "value_30d": sweep.get("threat_index_30d")})
    state["threat_index_history"] = state["threat_index_history"][-180:]

    proposal, was_already_pending = generate_proposal(state)

    report_data = {
        "date": today.isoformat(),
        "threat_index": sweep["threat_index"],
        "trend_label": trend_label,
        "threat_reading": sweep.get("threat_index_justification", ""),
        "threat_index_30d": sweep.get("threat_index_30d"),
        "threat_reading_30d": sweep.get("threat_index_30d_justification", ""),
        "forecast_drivers": sweep.get("forecast_drivers", []),
        "self_check_summary": self_check["summary"],
        "self_check_results": self_check.get("results", []),
        "top_development": sweep.get("top_development", ""),
        "events": sweep.get("events", []),
        "threat_index_history": state["threat_index_history"],
        "key_signals": sweep.get("key_signals", []),
        "narrative_stability": narrative_rows,
        "tiers": [{"name": t["name"], "range": f"{t['range'][0]}-{t['range'][1]}", "examples": ", ".join(t["examples"])} for t in state["methodology"]["tiers"]],
        "top_authors_summary": top_authors_summary(state),
        "deception_items": sweep.get("deception_items", []),
        "operator_influence": sweep.get("operator_influence"),
        "operator_track_record": operator_weight.track_record(
            {**load_outcomes(), **{r["event_id"]: r["outcome"] for r in self_check.get("results", [])}}),
        "proposal": proposal,
        "prior_proposal_still_pending": was_already_pending,
    }

    OUTPUT_DIR.mkdir(exist_ok=True)
    with open(OUTPUT_DIR / f"{today.isoformat()}_report_data.json", "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2, ensure_ascii=False)

    pptx_path = OUTPUT_DIR / f"{today.isoformat()}_hybrid_threat_monitor.pptx"
    build_deck(report_data, str(pptx_path))
    print(f"Report built: {pptx_path}")

    executive = build_executive_safe(report_data)
    if executive:
        report_data["executive_sv"] = executive
        with open(OUTPUT_DIR / f"{today.isoformat()}_report_data.json", "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
    _, audio_path = build_podcast(report_data)
    send_daily_email(report_data, str(pptx_path), str(audio_path) if audio_path else None, executive)
    push_report(report_data)
    backup_app()

    archive_and_clear_log(today - timedelta(days=1))
    save_state(state)
    print("Daily report done.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolve", choices=["accept", "deny"], help="Resolve the pending methodology proposal instead of running the report.")
    args = parser.parse_args()

    if args.resolve:
        resolve_proposal(load_state(), args.resolve)
    else:
        run_daily_report()
