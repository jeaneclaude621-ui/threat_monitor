"""
Russia's courses of action, updated once a day after the 04:00 report:
the most likely, a possible and the most dangerous way for Russia to move
its positions forward, split Europe and make buffer zones by force,
threat or proxies.

The structure is fixed and the content moves: three courses with fixed
roles (troligast, mojligt, farligast), each with at most five sentences, a
likelihood (låg, måttlig, hög), signs to watch and a schematic map. The
model rewrites a course only when the material calls for it, and marks
each sign observerat, delvis or inte observerat, citing what it rests on.
Code keeps it in bounds:
- a course's likelihood moves at most one step a day;
- the signs are the fixed list; the model only sets their status;
- the map takes only the tiles, arrow kinds and symbols of the app's map;
- a sign is "first seen" on the first day it is observed or partly so.

Material: today's report (events with score, topics, countries), the
thread checks of the last day, and the latest Swedish authorities and
NATO brief. Never the Russian side of the trends feed: data/trends.json
is not read here. Starting point: config/courses_seed.json.

One Gemini call a day. Run by daily_report.py after the report is out;
a failure here stops nothing else.

    python3 src/courses.py              # update from today's report
    python3 src/courses.py --dry-run    # print the material, no call
"""
import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, OUTPUT_DIR, ask_model_json, load_hourly_log

COURSES_PATH = DATA_DIR / "courses.json"
SEED_PATH = Path(__file__).resolve().parent.parent / "config" / "courses_seed.json"
AUTHORITIES_PATH = DATA_DIR / "authorities.json"

LEVELS = ["låg", "måttlig", "hög"]
STATUSES = ["inte observerat", "delvis", "observerat"]
ORDER = ["troligast", "mojligt", "farligast"]
# The app's schematic map (webapp/public/app.js, COA_TILES and friends).
TILES = {"NO", "SE", "FI", "RU", "DK", "BALT", "EE", "LV", "DE", "KG", "LT", "BY", "PL", "MD", "UA", "RO", "BLACK"}
ARROWS = {"military", "hybrid", "political"}
SYMBOLS = {"military", "naval", "drone", "sabotage", "info", "proxy", "nuclear", "cable"}
HISTORY_DAYS = 90


def load() -> dict:
    if COURSES_PATH.exists():
        with open(COURSES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    with open(SEED_PATH, "r", encoding="utf-8") as f:
        seed = json.load(f)
    return {"date": None, "courses": seed["courses"], "history": []}


def material(report: dict, hourly: list) -> tuple:
    """(prompt text, {ref: (kind, id, date)}) - events E1.., thread
    updates U1.., authorities and NATO items M1.."""
    refs, lines = {}, []
    lines.append(f"Today's report ({report['date']}), threat index {report.get('threat_index')}/10. "
                 f"Top development: {report.get('top_development', '')}")
    lines.append("\nEvents:")
    for e in report.get("events", []):
        ref = f"E{len(refs) + 1}"
        refs[ref] = ("event", e.get("id"), report["date"])
        lines.append(f"[{ref}] score {e.get('score')} · {', '.join(e.get('topics') or [])} · "
                     f"{', '.join(e.get('countries') or [])} · {e.get('title')} - {(e.get('summary_sv') or e.get('detail') or '')[:300]}")
    lines.append("\nThread checks of the last day:")
    for u in hourly[-30:]:
        if u.get("classification") == "NO_CHANGE":
            continue
        ref = f"U{len(refs) + 1}"
        refs[ref] = ("update", u.get("thread_id"), report["date"])
        lines.append(f"[{ref}] {u.get('thread_label', '')[:80]}: {u.get('summary', '')[:250]}")
    if AUTHORITIES_PATH.exists():
        with open(AUTHORITIES_PATH, "r", encoding="utf-8") as f:
            brief = json.load(f)
        lines.append(f"\nSwedish authorities ({brief.get('generated_at', '')[:16]}): {brief.get('overall_sv', '')}")
        nato = brief.get("nato") or {}
        for it in brief.get("items", []) + nato.get("items", []):
            ref = f"M{len(refs) + 1}"
            refs[ref] = ("brief", it.get("agency"), it.get("date"))
            lines.append(f"[{ref}] {it.get('agency')} ({it.get('date')}): {it.get('text_sv')}")
        if nato.get("overall_sv"):
            lines.append(f"NATO's line: {nato['overall_sv']}")
    return "\n".join(lines), refs


def prompt_for(current: list, text: str) -> str:
    courses = json.dumps([{k: c[k] for k in ("id", "label", "title", "text", "likelihood", "signs", "arrows", "marks")}
                          for c in current], ensure_ascii=False, indent=1)
    return f"""You keep a standing assessment of Russia's courses of action against
Europe: how Russia could move its positions forward, split European unity,
and make buffer zones by force, threat or proxies. Three courses with
fixed roles: "troligast" (most likely), "mojligt" (possible) and
"farligast" (most dangerous: low likelihood, high consequence).

Yesterday's assessment:
{courses}

Today's material, each item with a ref:
{text}

Update the assessment from today's material:
- For each course, keep yesterday's title and text unless today's material
  calls for a change. Text: at most 5 sentences in natural Swedish, plain
  and concrete, naming places. A course keeps its role.
- "likelihood": låg, måttlig or hög. Change it only on evidence in today's
  material; say why in "likelihood_reason_sv" (one sentence).
- For each sign (by its id, text unchanged): "status" inte observerat,
  delvis or observerat in today's material, with "refs" to the items it
  rests on. Observed means the material reports it happening, not that it
  could.
- "arrows" [from, to, kind] and "marks" [tile, symbol] for the map, only
  with tiles {sorted(TILES)}, kinds {sorted(ARROWS)} and symbols
  {sorted(SYMBOLS)} (BALT is the Baltic Sea, KG Kaliningrad, BLACK the
  Black Sea).
- "changed_sv": one Swedish sentence on what changed since yesterday, or
  that nothing did.

Base everything on the material. Write claims as reported, never stronger
than the source.

Respond as strict JSON:
{{"courses": [{{"id": "troligast", "title": "...", "text": ["..."], "likelihood": "...",
   "likelihood_reason_sv": "...", "signs": [{{"id": "t1", "status": "...", "refs": ["E1"]}}],
   "arrows": [["RU", "PL", "political"]], "marks": [["DE", "sabotage"]]}}],
  "changed_sv": "..."}}"""


def apply(current: list, result: dict, refs: dict, today: str) -> list:
    """Today's courses from yesterday's and the model's answer, in bounds."""
    answers = {c.get("id"): c for c in result.get("courses") or [] if isinstance(c, dict)}
    out = []
    for old in sorted(current, key=lambda c: ORDER.index(c["id"])):
        new = answers.get(old["id"], {})
        c = dict(old)
        if isinstance(new.get("title"), str) and new["title"].strip():
            c["title"] = new["title"].strip()[:200]
        text = [t.strip() for t in new.get("text") or [] if isinstance(t, str) and t.strip()]
        if text:
            c["text"] = text[:5]
        # One step a day at most, as the index is held.
        was = LEVELS.index(old.get("likelihood", "måttlig"))
        want = LEVELS.index(new["likelihood"]) if new.get("likelihood") in LEVELS else was
        c["likelihood"] = LEVELS[max(was - 1, min(was + 1, want))]
        c["likelihood_reason_sv"] = new.get("likelihood_reason_sv") if isinstance(new.get("likelihood_reason_sv"), str) else None
        c["previous_likelihood"] = old.get("likelihood")
        statuses = {s.get("id"): s for s in new.get("signs") or [] if isinstance(s, dict)}
        signs = []
        for s in old["signs"]:
            got = statuses.get(s["id"], {})
            status = got.get("status") if got.get("status") in STATUSES else "inte observerat"
            cited = [refs[r] for r in got.get("refs") or [] if r in refs]
            signs.append({**s, "status": status,
                          "refs": [{"kind": k, "id": i, "date": d} for k, i, d in cited][:5],
                          "first_seen": s.get("first_seen") or (today if status != "inte observerat" else None)})
        c["signs"] = signs
        arrows = [a for a in new.get("arrows") or [] if isinstance(a, list) and len(a) == 3
                  and a[0] in TILES and a[1] in TILES and a[0] != a[1] and a[2] in ARROWS]
        marks = [m for m in new.get("marks") or [] if isinstance(m, list) and len(m) == 2
                 and m[0] in TILES and m[1] in SYMBOLS]
        c["arrows"] = arrows[:8] or old["arrows"]
        c["marks"] = marks[:8] or old["marks"]
        out.append(c)
    return out


def run(report: dict = None, hourly: list = None, dry_run: bool = False):
    today = date.today().isoformat()
    if report is None:
        path = OUTPUT_DIR / f"{today}_report_data.json"
        if not path.exists():
            print(f"  ! Courses of action: no report for {today}")
            return
        with open(path, "r", encoding="utf-8") as f:
            report = json.load(f)
    if hourly is None:
        hourly = load_hourly_log(date.today())
    state = load()
    text, refs = material(report, hourly)
    if dry_run:
        print(text)
        return
    result = ask_model_json(prompt_for(state["courses"], text), max_tokens=6000,
                            system="You are a Swedish security analyst keeping a standing assessment of "
                                   "Russia's courses of action. Strict JSON only.")
    courses = apply(state["courses"], result, refs, today)
    history = [h for h in state.get("history", []) if h["date"] != today]
    history.append({"date": today, "likelihood": {c["id"]: c["likelihood"] for c in courses}})
    state = {"date": today, "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
             "changed_sv": result.get("changed_sv") if isinstance(result.get("changed_sv"), str) else None,
             "courses": courses, "history": history[-HISTORY_DAYS:]}
    with open(COURSES_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    print("  Courses of action: " + ", ".join(
        f"{c['id']} {c['previous_likelihood']}→{c['likelihood']}, "
        f"{sum(s['status'] != 'inte observerat' for s in c['signs'])}/{len(c['signs'])} signs" for c in courses))
    from app_sync import push_courses
    push_courses({**state, "history": state["history"][-30:]})


def run_safe(report: dict, hourly: list):
    """For daily_report.py: never let this stop the report run."""
    try:
        run(report, hourly)
    except Exception as e:
        print(f"  ! Courses of action failed ({e})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    run(dry_run=ap.parse_args().dry_run)
