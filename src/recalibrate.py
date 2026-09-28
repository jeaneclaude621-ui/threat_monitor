"""
Rescores the threat-index history against the current methodology.

Each past report is scored again - general index and 30-day forecast -
from the evidence that report itself recorded (events, top development,
key signals, deception items), with web search off and the model told
it is that date. The old index and its justification are withheld, so
the new value cannot anchor on them, and nothing later than the report
date is available to leak in as hindsight. Each day is also scored
without the other recalibrated values: fed the previous day's result, the
model copied it forward (four identical days in a row, then drifting a
band upward), which is the anchoring this recalibration exists to remove.

The sent reports are left untouched. Results go to
data/recalibration.json (old and new side by side) and replace the
values in state["threat_index_history"], so tomorrow's trend chart and
day-on-day comparison use the recalibrated series.

Usage:
    python src/recalibrate.py            # rescore every report and save
    python src/recalibrate.py --dry-run  # rescore and print, save nothing
    python src/recalibrate.py --from F   # reuse scores saved in F, no API calls
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_state, save_state, ask_claude_json, OUTPUT_DIR, DATA_DIR
from daily_report import SYSTEM, index_instructions, INDEX_JSON_FIELDS, enforce_bands

RESULTS_PATH = DATA_DIR / "recalibration.json"
EVIDENCE_KEYS = ("top_development", "events", "key_signals", "deception_items")


def rescore(report, methodology):
    day = report["date"]
    evidence = {k: report.get(k) for k in EVIDENCE_KEYS}
    prompt = f"""Today is {day}. Below is the evidence base recorded in the daily
report for {day}. Score it as an analyst would have on that morning:
use ONLY this evidence, and nothing you may know about events after
{day}.

<evidence>
{json.dumps(evidence, indent=1, ensure_ascii=False)}
</evidence>

Produce:
{index_instructions(methodology, "(withheld - score this day on its own evidence)", "withheld")}
Respond as strict JSON with exactly these fields:
{{
{INDEX_JSON_FIELDS.rstrip(',')}
}}"""
    return enforce_bands(ask_claude_json(prompt, system=SYSTEM, max_tokens=4000, use_search=False))


def main(dry_run, from_file=None):
    methodology = load_state()["methodology"]
    # Scores from an earlier run (a list of rescore results, each with its
    # "date") - lets the save step be rerun without paying for the calls again.
    saved = {r["date"]: r for r in json.load(open(from_file, encoding="utf-8"))} if from_file else {}
    reports = sorted(OUTPUT_DIR.glob("*_report_data.json"))
    results = []
    for path in reports:
        report = json.load(open(path, encoding="utf-8"))
        r = saved.get(report["date"]) or rescore(report, methodology)
        entry = {
            "date": report["date"],
            "value": r["threat_index"],
            "value_30d": r["threat_index_30d"],
            "original_value": report.get("threat_index"),
            "band": r.get("index_band"),
            "band_30d": r.get("index_band_30d"),
            "justification": r.get("threat_index_justification", ""),
            "justification_30d": r.get("threat_index_30d_justification", ""),
            "forecast_drivers": r.get("forecast_drivers", []),
        }
        results.append(entry)
        print(f"{entry['date']}  was {entry['original_value']:>4}  ->  general {entry['value']:>4}   30-day {entry['value_30d']:>4}")

    if dry_run:
        return
    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    # Reload just before saving: the hourly job writes state too, and this
    # run takes minutes. Dates missing from the history (a report whose
    # entry was lost) are filled in from the reports.
    state = load_state()
    by_date = {h["date"]: h for h in state["threat_index_history"]}
    for e in results:
        by_date[e["date"]] = {"date": e["date"], "value": e["value"], "value_30d": e["value_30d"], "recalibrated": True}
    state["threat_index_history"] = [by_date[d] for d in sorted(by_date)][-180:]
    save_state(state)
    print(f"Saved {len(results)} recalibrated days to state and {RESULTS_PATH.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--from", dest="from_file")
    args = parser.parse_args()
    main(args.dry_run, args.from_file)
