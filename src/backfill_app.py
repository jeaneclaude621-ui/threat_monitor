"""
Brings reports written before the web app up to webapp/CONTRACT.md:
event ids, Swedish title and summary, topics, countries, and articles
from the sources line (no links - those were never recorded). Also folds
in <date>_executive_sv.json where it exists. One Claude call per report,
no web search.

    python3 src/backfill_app.py            # every report missing the fields
    python3 src/backfill_app.py 2026-09-24 # one report

Rewrites reports/<date>_report_data.json in place; skips reports whose
events already have title_sv.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ask_claude_json, OUTPUT_DIR
from app_data import TOPICS, enrich_events

SYSTEM = "Du är en svensk underrättelseanalytiker. Du svarar med enbart giltig JSON."

PROMPT = """Här är händelserna i en rapport som JSON:

{events}

Ge för varje händelse, i samma ordning:
- "title_sv": rubriken på naturlig svenska, högst ~10 ord;
- "summary_sv": en eller två meningar på svenska, högst ~35 ord;
- "topics": ett eller flera av {topics};
- "countries": ISO 3166-1 alpha-2-koder för länderna där det hände
  eller som det direkt berör;
- "articles": källorna i "sources" som en lista
  [{{"outlet": "...", "tier": 1-4}}] - bara själva mediets eller
  myndighetens namn (t.ex. "Reuters", "Kyiv Independent", "KAPO"),
  aldrig kommentarer, bedömningar eller "citing ..."; ett medium som
  citerar ett annat räknas som det medium som publicerade. Nivån ur
  texten ("Tier 2" = 2), annars null.

Svara med JSON: {{"events": [{{"title_sv": "...", "summary_sv": "...", "topics": ["..."], "countries": ["..."], "articles": [{{"outlet": "...", "tier": 1}}]}}]}}"""


def backfill(path: Path, force: bool = False) -> bool:
    data = json.load(open(path, encoding="utf-8"))
    events = data.get("events", [])
    if not events or (not force and all(e.get("title_sv") for e in events)):
        return False
    slim = [{"title": e.get("title"), "detail": e.get("detail"), "sources": e.get("sources")} for e in events]
    result = ask_claude_json(PROMPT.format(events=json.dumps(slim, ensure_ascii=False, indent=1),
                                           topics=", ".join(TOPICS)),
                             system=SYSTEM, max_tokens=4000, use_search=False)
    extra = result.get("events", [])
    if len(extra) != len(events):
        print(f"  ! {path.name}: got {len(extra)} events back for {len(events)}, skipped")
        return False
    for ev, add in zip(events, extra):
        for key in ("title_sv", "summary_sv", "topics", "countries"):
            ev[key] = add.get(key)
        ev["articles"] = [{"outlet": a.get("outlet"), "title": None, "url": None, "tier": a.get("tier")}
                          for a in add.get("articles") or [] if isinstance(a, dict)] or None
    enrich_events(events, data["date"], None)

    exec_path = OUTPUT_DIR / f"{data['date']}_executive_sv.json"
    if exec_path.exists() and "executive_sv" not in data:
        data["executive_sv"] = json.load(open(exec_path, encoding="utf-8"))

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Backfilled {path.name}: {len(events)} events")
    return True


if __name__ == "__main__":
    if len(sys.argv) > 1:
        backfill(OUTPUT_DIR / f"{sys.argv[1]}_report_data.json", force=True)
    else:
        for f in sorted(OUTPUT_DIR.glob("*_report_data.json")):
            backfill(f)
