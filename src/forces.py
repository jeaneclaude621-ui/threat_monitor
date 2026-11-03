"""
The forces map: Russia's (and Belarus's) known bases, the units and
equipment there, and their latest reported status. Updated every night
after the 04:00 report, shown in the app's Styrkor tab.

    python3 src/forces.py               # the nightly update (one Gemini call)
    python3 src/forces.py --dry-run    # print the material, no call
    python3 src/forces.py catalogue OUT.json   # the base list only, no call
    python3 src/forces.py survey --batches 18  # a Wikipedia survey round (forces_survey.py)
    python3 src/forces.py export-db           # the app's static catalogues from config/forces_db

The base list: every base Wikidata has in Russia and Belarus with a
position (air, naval and military bases), merged with the hand-kept detail
in config/forces_curated.json - units, equipment, reported attacks - which
wins where both have a base within 15 km. Wikidata is read again once a
week; if it does not answer, the last list stands. On top of both comes
the foundation database config/forces_db/ (bases, units, weapon systems,
from open sources, see its README): it wins where it describes the same
base (within 15 km and the same branch, or the same name), the base keeps
the app's id (Wikidata Q-id or c<n>) and gains `db_id`; bases only the
database knows get its slug as id.

The night's update reads the last day's reporting on Russian bases and
forces (its own Google News searches, plus the morning report's articles
and events) and records, per base:
- attacks in the last day: what happened, with the sources;
- follow-ups on earlier attacks (damage confirmed, new images, ...);
- changes to the units and equipment: added, moved (from one base to
  another), gone, or otherwise changed.
The original holdings (the hand-kept list) are kept beside the current
ones, so the app shows what changed against the starting point.

Code keeps the model in bounds: a base is named by its id from the list,
every entry must cite an article it was given, and a moved unit must leave
one listed base for another. Sources: no Russian state media (as in the
rest of the monitor's analysis), and never the trends feed.

State: data/forces.json. App: PUT /api/ingest/forces.
"""
import argparse
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, OUTPUT_DIR

ROOT = Path(__file__).resolve().parent.parent
CURATED = ROOT / "config" / "forces_curated.json"
DB_DIR = ROOT / "config" / "forces_db"
PUBLIC_FORCES = ROOT / "webapp" / "public" / "forces"
STATE_PATH = DATA_DIR / "forces.json"
UA = "threat-monitor/1 (https://github.com/jeaneclaude621-ui/threat_monitor)"

CATALOGUE_DAYS = 7          # read Wikidata again after this many days
ATTACKED_DAYS = 30          # "anfallen" on the map for this long after an attack
CONTEXT_DAYS = 14           # recent entries shown to the model, so it does not repeat them
NIGHTS_KEPT = 60
MAX_ARTICLES = 150
EVENT_KINDS = {"anfallen", "uppföljning"}
CHANGE_KINDS = {"tillfört", "flyttat", "borta", "ändrat"}
CATEGORIES = {"förband", "materiel"}

# Wikidata classes: air base, naval base, military base and two narrower
# kinds; their branch on the map.
# (Q1324633 naval base and Q21193688 missile base; until Nov 2026 two wrong
# ids stood here, a mansion and a television channel.)
TYPES = {"Q695850": "flyg", "Q1324633": "marin", "Q245016": "armé", "Q18691599": "flyg", "Q21193688": "robot"}
QUERY = """SELECT ?item ?itemLabel ?ruLabel ?type ?country ?coord WHERE {
  VALUES ?type { %s }
  VALUES ?country { wd:Q159 wd:Q184 }
  ?item wdt:P31 ?type ; wdt:P17 ?country ; wdt:P625 ?coord .
  OPTIONAL { ?item rdfs:label ?ruLabel FILTER(lang(?ruLabel)="ru") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "sv,en,ru". }
}""" % " ".join(f"wd:{t}" for t in TYPES)

# The night's searches (Google News, English: the outlets the rest of the
# monitor reads). The hand-kept bases are searched by name as well.
QUERIES = [
    "Russian airbase drone attack", "Russian air base strike", "Ukraine strikes Russian airfield",
    "Russian military airfield explosion", "Russian naval base attack", "Black Sea Fleet strike",
    "Baltic Fleet", "Northern Fleet", "Russian ammunition depot strike", "Russian air defense S-400 destroyed",
    "Russian aircraft destroyed satellite images", "Russian troops redeployed", "Russian forces moved border",
    "Russia Finland border troops", "Leningrad Military District", "Moscow Military District",
    "Kaliningrad military deployment", "Russian troops Belarus", "Iskander deployment",
    "Russia new division formed", "Russian brigade relocated",
]
# Russian state media stay out, as everywhere in the analysis.
STATE_MEDIA = re.compile(r"\b(tass|rt\b|russia today|ria\b|ria novosti|sputnik|izvestia|zvezda|rossiyskaya|"
                         r"rg\.ru|kommersant|interfax|pravda\.ru|tvzvezda)", re.I)
TOPIC = re.compile(r"(air ?base|airfield|aerodrome|naval base|base\b|fleet|brigade|division|regiment|"
                   r"troops|forces|deploy|redeploy|iskander|s-[34]00|tu-\d|su-\d|depot|strike|drone)", re.I)


# --------------------------------------------------------------------------
# The base list
# --------------------------------------------------------------------------
def wikidata() -> list:
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": QUERY})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    rows = json.loads(urllib.request.urlopen(req, timeout=90).read())["results"]["bindings"]
    out, seen = [], set()
    for r in rows:
        qid = r["item"]["value"].rsplit("/", 1)[1]
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", r["coord"]["value"])
        if qid in seen or not m:
            continue
        seen.add(qid)
        out.append({"id": qid, "name": r["itemLabel"]["value"], "name_ru": r.get("ruLabel", {}).get("value"),
                    "lon": round(float(m[1]), 3), "lat": round(float(m[2]), 3),
                    "branch": TYPES[r["type"]["value"].rsplit("/", 1)[1]],
                    "country": "BY" if r["country"]["value"].endswith("Q184") else "RU",
                    "units": [], "equipment": [], "events": [], "source": f"https://www.wikidata.org/wiki/{qid}"})
    return out


def km(a, b) -> float:
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    d = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b["lon"] - a["lon"]) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(d))


def load_db() -> dict:
    """The foundation database: {"bases": [...], "units": {id: unit}, "systems": {id: system}}.
    Empty when the files are missing."""
    out = {"bases": [], "units": {}, "systems": {}}
    for name in ("bases", "units", "systems"):
        path = DB_DIR / f"{name}.json"
        if path.exists():
            rows = json.load(open(path, encoding="utf-8"))[name]
            out[name] = rows if name == "bases" else {r["id"]: r for r in rows}
    return out


def _fold(t) -> str:
    return re.sub(r"[^a-z0-9а-яё]", "", str(t or "").lower())


def _display(db_base: dict, db: dict) -> tuple:
    """The base's units and equipment as display strings (the hand-kept
    names first, then the database's), at most 60 of each."""
    units = list(db_base.get("curated_units") or [])
    equipment = list(db_base.get("curated_equipment") or [])
    for uid in db_base.get("units") or []:
        u = db["units"].get(uid)
        if u and u["name_sv"] not in units:
            units.append(u["name_sv"])
    for sid in db_base.get("equipment") or []:
        x = db["systems"].get(sid)
        if x and not any(_fold(x["name"]).startswith(_fold(e)) or _fold(e).startswith(_fold(x["name"].split(" ")[0])) for e in equipment):
            equipment.append(x["name"])
    return [u[:200] for u in units[:60]], [e[:200] for e in equipment[:60]]


def apply_db(bases: list, db: dict = None) -> list:
    """Lay the foundation database over the list (Wikidata + hand-kept)."""
    db = db if db is not None else load_db()
    taken = set()
    for d in db["bases"]:
        hit = None
        if d.get("curated_index") is not None:
            hit = next((b for b in bases if b.get("curated_index") == d["curated_index"]), None)
        if hit is None:
            near = [b for b in bases if b["id"] not in taken and b.get("curated_index") is None]
            same = [b for b in near if (b["branch"] == d["branch"] and km(b, d) < 15) or _fold(b["name"]) == _fold(d["name"]) or km(b, d) < 2]
            hit = min(same, key=lambda b: km(b, d), default=None)
        units, equipment = _display(d, db)
        extra = {"db_id": d["id"], "name_ru": d.get("name_ru"), "lat": d["lat"], "lon": d["lon"], "branch": d["branch"],
                 "country": d["country"], "military_district": d.get("military_district"),
                 "description_sv": d.get("description_sv"), "status_sv": (d.get("status") or {}).get("status_sv"),
                 "status_as_of": (d.get("status") or {}).get("as_of"), "image": d.get("image"), "sources": d.get("sources") or [],
                 "units": units, "equipment": equipment, "unit_ids": list(d.get("units") or []),
                 "system_ids": list(d.get("equipment") or []), "events": list(d.get("events") or [])}
        if hit is not None:
            if hit.get("curated"):
                extra["name"] = hit["name"]
            else:
                extra["name"] = d["name"]
            hit.update(extra)
            hit["curated"] = True
            taken.add(hit["id"])
        else:
            bases.append({"id": d["id"], "name": d["name"], "curated": True, "source": None, **extra})
            taken.add(d["id"])
    return sorted(bases, key=lambda b: (not b.get("curated"), b["name"]))


def catalogue(bases: list = None) -> list:
    """Wikidata's bases (or `bases`, an earlier copy) merged with the
    hand-kept list and the foundation database."""
    bases = bases if bases is not None else wikidata()
    curated = json.load(open(CURATED, encoding="utf-8"))["bases"]
    for i, c in enumerate(curated):
        # Only a Wikidata base: two hand-kept ones can lie within 15 km
        # (Sevastopol and Belbek).
        near = min((b for b in bases if not b.get("curated")), key=lambda b: km(b, c), default=None)
        close = near is not None and km(near, c) < 15
        entry = {**c, "id": near["id"] if close else f"c{i + 1}", "curated": True, "curated_index": i,
                 "country": "BY" if "Belarus" in c["name"] else "RU",
                 "source": near["source"] if close else None}
        if close:
            bases.remove(near)
        bases.append(entry)
    return apply_db(bases)


def listed_bases(state: dict) -> list:
    """The base list: Wikidata's (read again once a week and kept in the
    state, so the merge always starts from the same list and the ids hold)
    merged with the hand-kept one."""
    last = state.get("catalogue_date")
    if not state.get("wikidata") or not last or date.fromisoformat(last) <= date.today() - timedelta(days=CATALOGUE_DAYS):
        try:
            state["wikidata"] = wikidata()
            state["catalogue_date"] = date.today().isoformat()
        except Exception as e:
            if not state.get("wikidata"):
                raise
            print(f"  ! Forces: Wikidata did not answer ({type(e).__name__}: {str(e)[:100]}); the last base list stands")
    return catalogue([dict(b) for b in state["wikidata"]])


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
DB_FIELDS = ("db_id", "military_district", "description_sv", "status_sv", "status_as_of", "image", "sources", "unit_ids", "system_ids")


def merge(state: dict, listed: list) -> dict:
    """Bring the base list into the state. The hand-kept units and
    equipment are each base's original holdings; what the nights have
    found (current holdings, changes, events) stays."""
    old = {b["id"]: b for b in state.get("bases", [])}
    out = []
    for b in listed:
        prev = old.pop(b["id"], None)
        base = {k: b.get(k) for k in ("id", "name", "name_ru", "lat", "lon", "branch", "country", "source")}
        base["curated"] = bool(b.get("curated"))
        for k in DB_FIELDS:
            if b.get(k) is not None:
                base[k] = b[k]
        base["original"] = {"units": list(b.get("units") or []), "equipment": list(b.get("equipment") or [])}
        if prev:
            base.update({k: list(prev.get(k, [])) for k in ("units", "equipment", "changes")})
            if prev.get("survey"):
                base["survey"] = prev["survey"]
            # An edit to the hand-kept list reaches the current holdings too:
            # what was added there is added, what was taken out is taken out.
            was = prev.get("original") or {"units": [], "equipment": []}
            for k in ("units", "equipment"):
                added = [x for x in base["original"][k] if x not in was.get(k, [])]
                dropped = {x for x in was.get(k, []) if x not in base["original"][k]}
                base[k] = [x for x in base[k] if x not in dropped] + [x for x in added if x not in base[k]]
            # Hand-kept events (the list's history) plus what the nights added.
            night = [e for e in prev.get("events", []) if e.get("night")]
            base["events"] = [e for e in b.get("events") or []] + night
        else:
            base.update({"units": list(b.get("units") or []), "equipment": list(b.get("equipment") or []),
                         "changes": [], "events": list(b.get("events") or [])})
        out.append(base)
    # A base that left the list but has something the nights found stays.
    out += [b for b in old.values() if b.get("changes") or any(e.get("night") for e in b.get("events", []))]
    state["bases"] = out
    return state


def status(base: dict, today: date) -> dict:
    """Attacked within ATTACKED_DAYS, else active when anything is known
    to be there, else unknown."""
    attacks = sorted((e["date"] for e in base["events"] if e["kind"] == "anfallen"), reverse=True)
    dates = sorted([e["date"] for e in base["events"]] + [c["date"] for c in base["changes"]], reverse=True)
    recent = attacks and attacks[0] >= (today - timedelta(days=ATTACKED_DAYS)).isoformat()
    survey = base.get("survey") or {}
    known = base["curated"] or base["units"] or base["equipment"] or survey.get("units") or survey.get("equipment")
    return {"status": "anfallen" if recent else "aktiv" if known else "okänd",
            "last_attack": attacks[0] if attacks else None, "updated": dates[0] if dates else None}


def load() -> dict:
    if STATE_PATH.exists():
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"bases": [], "nights": [], "wikidata": [], "catalogue_date": None}


# --------------------------------------------------------------------------
# The night's material
# --------------------------------------------------------------------------
def articles(state: dict, report: dict = None, pool=None) -> list:
    """The last day's reporting on Russian bases and forces."""
    import news_sources
    p = news_sources.Pool()
    for q in QUERIES:
        p.add(news_sources.google_news(q))
    for b in state["bases"]:
        if b["curated"]:
            p.add(news_sources.google_news(f'"{b["name"]}" Russia'))
    if pool is not None:
        p.add(a for a in pool.items if TOPIC.search(f"{a.get('title', '')} {a.get('summary', '')}"))
    p.since(datetime.now() - timedelta(hours=28))
    items = [a for a in p.items if not STATE_MEDIA.search(f"{a.get('source', '')} {a.get('link', '')}")]
    items.sort(key=lambda a: a.get("published") or datetime.max, reverse=True)
    return items[:MAX_ARTICLES]


def material(state: dict, items: list, report: dict = None) -> tuple:
    """(prompt text, {ref: source})."""
    refs, lines = {}, ["Articles from the last day:"]
    for a in items:
        ref = f"A{len(refs) + 1}"
        refs[ref] = {"url": a.get("link"), "outlet": a.get("source"), "title": a.get("title")}
        when = a["published"].strftime("%Y-%m-%d %H:%M") if a.get("published") else "undated"
        summary = (a.get("summary") or "")[:300]
        lines.append(f"[{ref}] {a.get('source') or '?'} · {when} · {a.get('title')}" + (f" - {summary}" if summary else ""))
    if report:
        lines.append(f"\nToday's monitor report ({report.get('date')}), events:")
        for e in report.get("events", []):
            art = next((a for a in e.get("articles") or [] if isinstance(a, dict) and a.get("url")), {})
            if not art:
                continue
            ref = f"E{len(refs) + 1}"
            refs[ref] = {"url": art["url"], "outlet": art.get("outlet"), "title": e.get("title")}
            lines.append(f"[{ref}] {e.get('title')} - {(e.get('summary_sv') or e.get('detail') or '')[:300]}")
    return "\n".join(lines), refs


def base_lines(state: dict, today: date) -> str:
    since = (today - timedelta(days=CONTEXT_DAYS)).isoformat()
    out = []
    for b in state["bases"]:
        line = f"{b['id']} | {b['name']}" + (f" ({b['name_ru']})" if b.get("name_ru") else "") + f" | {b['branch']} | {b['country']}"
        sv = b.get("survey") or {}
        # Capped, so the prompt stays a reasonable size with several hundred described bases.
        units = (b["units"] + [u for u in sv.get("units", []) if u not in b["units"]])[:6]
        equipment = (b["equipment"] + [e for e in sv.get("equipment", []) if e not in b["equipment"]])[:8]
        if units or equipment:
            line += f" | units: {', '.join(units) or '-'} | equipment: {', '.join(equipment) or '-'}"
        recent = [e for e in b["events"] if e["date"] >= since] + [c for c in b["changes"] if c["date"] >= since]
        if recent:
            line += " | already recorded: " + "; ".join(f"{e['date']} {e['kind']}: {e['text_sv'][:120]}" for e in recent)
        out.append(line)
    return "\n".join(out)


def prompt_for(state: dict, text: str, today: date) -> str:
    return f"""You keep the record of Russia's (and Belarus's) military bases and
the forces at them, for a Swedish monitor. Each night you read the last
day's reporting and record what is new.

The bases (id | name | branch | country | what is known to be there |
entries already recorded in the last {CONTEXT_DAYS} days):
{base_lines(state, today)}

{text}

Already recorded at places not in the list (do not repeat these under "other"):
{chr(10).join(f"- {n['date']} {o['place']}: {o['text_sv'][:140]}" for n in state.get('nights', [])[-CONTEXT_DAYS:] for o in n.get('other', [])) or '(none)'}

Record, from the articles only:
1. "attacks": a base attacked in the last day (drones, missiles, sabotage,
   fire from an attack). Name the base by its id from the list. "text_sv":
   what happened, 1-2 sentences in plain Swedish, as reported and never
   stronger than the source ("uppges", "enligt ukrainska uppgifter" where
   that is what the source says). "date": the day it happened.
2. "follow_ups": new information about an attack already recorded above
   (damage confirmed, satellite images, casualties, the attack denied).
   Not a repeat of what is already recorded.
3. "changes": units or equipment added to a base, moved from one base to
   another, gone from a base, or otherwise changed (renamed, enlarged,
   reformed). "category" "förband" (a unit) or "materiel" (aircraft,
   systems). "what": the unit or equipment, as named in the list when it
   is there (e.g. "Su-34", "22:a gardes tunga bombflygdivisionen").
   "kind" tillfört, flyttat (give "to_base" as an id), borta or ändrat.
4. "other": an attack on or a change at a Russian military site that is
   not in the list: "place" and "text_sv".

Every entry needs "refs" to the articles it rests on. Only what the
articles report happening - not plans, threats or speculation. If nothing
is new, return empty lists. Leave out what is already recorded.

"summary_sv": 1-3 sentences in Swedish on the night's findings, or that
nothing new was reported.

Respond as strict JSON:
{{"attacks": [{{"base": "Q123", "date": "{today.isoformat()}", "text_sv": "...", "refs": ["A1"]}}],
  "follow_ups": [{{"base": "Q123", "text_sv": "...", "refs": ["A2"]}}],
  "changes": [{{"base": "Q123", "category": "materiel", "what": "Su-34", "kind": "flyttat", "to_base": "Q456",
               "text_sv": "...", "refs": ["A3"]}}],
  "other": [{{"place": "...", "text_sv": "...", "refs": ["A4"]}}],
  "summary_sv": "..."}}"""


# --------------------------------------------------------------------------
# Applying the answer
# --------------------------------------------------------------------------
def _sources(entry: dict, refs: dict) -> list:
    import news_sources
    out = []
    for r in entry.get("refs") or []:
        if r in refs and refs[r].get("url"):
            s = refs[r]
            out.append({"url": news_sources.decode_google_link(s["url"]), "outlet": (s.get("outlet") or "")[:100],
                        "title": (s.get("title") or "")[:300]})
    return out[:4]


def _text(v, n=600) -> str:
    return v.strip()[:n] if isinstance(v, str) and v.strip() else ""


def apply(state: dict, result: dict, refs: dict, today: date) -> dict:
    """The night's findings into the bases, in bounds. Returns the night."""
    by_id = {b["id"]: b for b in state["bases"]}
    day = today.isoformat()
    night = {"date": day, "summary_sv": _text(result.get("summary_sv"), 1000) or None,
             "attacks": [], "follow_ups": [], "changes": [], "other": []}

    def ok(entry, *keys):
        return isinstance(entry, dict) and all(_text(entry.get(k)) for k in keys)

    for a in result.get("attacks") or []:
        b = by_id.get(a.get("base")) if ok(a, "text_sv") else None
        src = _sources(a, refs) if b else []
        if not src:
            continue
        when = a.get("date") if isinstance(a.get("date"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", a["date"]) else day
        when = min(max(when, (today - timedelta(days=2)).isoformat()), day)
        if any(e["kind"] == "anfallen" and e["date"] == when and e.get("night") for e in b["events"]):
            continue
        e = {"date": when, "kind": "anfallen", "text_sv": _text(a["text_sv"]), "sources": src, "night": day}
        b["events"].append(e)
        night["attacks"].append({"base": b["id"], **e})

    for f in result.get("follow_ups") or []:
        b = by_id.get(f.get("base")) if ok(f, "text_sv") else None
        src = _sources(f, refs) if b else []
        if not src:
            continue
        e = {"date": day, "kind": "uppföljning", "text_sv": _text(f["text_sv"]), "sources": src, "night": day}
        b["events"].append(e)
        night["follow_ups"].append({"base": b["id"], **e})

    for c in result.get("changes") or []:
        b = by_id.get(c.get("base")) if ok(c, "text_sv", "what") else None
        kind, cat = c.get("kind"), c.get("category")
        to = by_id.get(c.get("to_base")) if kind == "flyttat" else None
        if not b or kind not in CHANGE_KINDS or cat not in CATEGORIES or (kind == "flyttat" and (not to or to is b)):
            continue
        src = _sources(c, refs)
        if not src:
            continue
        what = _text(c["what"], 120)
        field = "units" if cat == "förband" else "equipment"
        entry = {"date": day, "kind": kind, "category": cat, "what": what, "text_sv": _text(c["text_sv"]),
                 "sources": src, "night": day}
        if kind == "tillfört" and what not in b[field]:
            b[field].append(what)
        elif kind in ("flyttat", "borta"):
            b[field] = [x for x in b[field] if x.lower() != what.lower()]
        if to:
            entry["to_base"] = to["id"]
            if what not in to[field]:
                to[field].append(what)
            to["changes"].append({**entry, "kind": "tillfört", "from_base": b["id"]})
        b["changes"].append(entry)
        night["changes"].append({"base": b["id"], **entry})

    for o in result.get("other") or []:
        src = _sources(o, refs) if ok(o, "text_sv", "place") else []
        if src:
            night["other"].append({"place": _text(o["place"], 200), "text_sv": _text(o["text_sv"]), "sources": src})
    return night


def payload(state: dict) -> dict:
    """What the app shows: the bases with their status, and the nights."""
    today = date.today()
    bases = []
    for b in state["bases"]:
        out = {k: v for k, v in b.items()}
        out.update(status(b, today))
        bases.append(out)
    return {"date": state.get("date"), "generated_at": state.get("generated_at"),
            "note": "Baspositioner från Wikidata (CC0) och grunddatabasen. Förband, materiel och anfall från öppna källor, inte verifierat.",
            "bases": bases, "nights": state.get("nights", [])[-30:]}


def run(report: dict = None, pool=None, dry_run: bool = False):
    today = date.today()
    if report is None:
        path = OUTPUT_DIR / f"{today.isoformat()}_report_data.json"
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                report = json.load(f)
    state = load()
    merge(state, listed_bases(state))
    items = articles(state, report, pool)
    text, refs = material(state, items, report)
    print(f"  Forces: {len(state['bases'])} bases, {len(items)} articles")
    if dry_run:
        print(prompt_for(state, text, today))
        return
    from common import ask_model_json
    system = ("You keep a factual record of Russian military bases and forces "
              "from open reporting, for a Swedish monitor. Strict JSON only.")
    try:
        result = ask_model_json(prompt_for(state, text, today), max_tokens=6000, system=system)
    except Exception as e:
        # The main model's daily quota (20 calls, shared with the reports) is
        # spent: the lighter survey model has its own, so the night still runs.
        if "RESOURCE_EXHAUSTED" not in str(e) and "429" not in str(e):
            survey(state)
            raise
        import forces_survey
        model = forces_survey.survey_model()
        if not model:
            survey(state)
            raise
        print(f"  ! Forces: main model quota spent; the night runs on {model}")
        result = ask_model_json(prompt_for(state, text, today), max_tokens=6000, system=system, model=model)
    night = apply(state, result, refs, today)
    state["nights"] = [n for n in state.get("nights", []) if n["date"] != night["date"]] + [night]
    state["nights"] = state["nights"][-NIGHTS_KEPT:]
    state["date"] = today.isoformat()
    state["generated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    print(f"  Forces: {len(night['attacks'])} attacks, {len(night['follow_ups'])} follow-ups, "
          f"{len(night['changes'])} changes, {len(night['other'])} elsewhere")
    survey(state)
    from app_sync import push_forces
    push_forces(payload(state))


def survey(state: dict, batches: int = None):
    """The rolling Wikipedia survey (forces_survey.py), saved with the state.
    A failure there costs only the survey."""
    import forces_survey
    try:
        forces_survey.run(state, batches or forces_survey.NIGHTLY_BATCHES)
    except Exception as e:
        print(f"  ! Survey failed ({type(e).__name__}: {e})")
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def survey_only(batches: int):
    """A survey round without the night's update (no call on the main model)."""
    state = load()
    merge(state, listed_bases(state))
    survey(state, batches)
    from app_sync import push_forces
    push_forces(payload(state))


def export_db():
    """The app's static catalogues (/forces/systems.json, /forces/units.json),
    read once by the Styrkor tab: compact copies of config/forces_db."""
    db = load_db()
    PUBLIC_FORCES.mkdir(parents=True, exist_ok=True)
    note = "Grunddata från öppna källor (se config/forces_db/README.md). Inte verifierat."
    for name in ("systems", "units"):
        rows = sorted(db[name].values(), key=lambda r: r["id"])
        data = {"note": note, name: rows}
        (PUBLIC_FORCES / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(db['systems'])} systems, {len(db['units'])} units -> {PUBLIC_FORCES}")


def run_safe(report: dict = None, pool=None):
    """For daily_report.py: never let this stop the report run."""
    try:
        run(report, pool)
    except Exception as e:
        print(f"  ! Forces update failed ({type(e).__name__}: {e})")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "catalogue":
        data = catalogue()
        Path(sys.argv[2]).write_text(json.dumps({"bases": data}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{len(data)} bases, {sum(1 for b in data if b.get('curated'))} with detail")
    elif len(sys.argv) == 2 and sys.argv[1] == "export-db":
        export_db()
    elif len(sys.argv) >= 2 and sys.argv[1] == "survey":
        ap = argparse.ArgumentParser()
        ap.add_argument("cmd")
        ap.add_argument("--batches", type=int, default=18)
        survey_only(ap.parse_args().batches)
    else:
        ap = argparse.ArgumentParser()
        ap.add_argument("--dry-run", action="store_true")
        run(dry_run=ap.parse_args().dry_run)
