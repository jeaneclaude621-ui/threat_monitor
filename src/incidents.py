"""
The incident log (Version 3.48): physical, subversive incidents in Europe
outside Russia and Belarus - sabotage and arson, cables and infrastructure,
drones and airspace, spies caught, threats and violence, GPS jamming and
physical influence actions (graffiti, staged stunts). Not statements,
disinformation, decisions or responses: what happened on the ground.

Each morning, after the report, the day's article pool is narrowed to the
incident-like articles (INCIDENT_WORDS) and one call on the light model
lists the incidents in them, each tied to the articles it rests on. Places
are looked up in the heat map's place list (webapp/public/forces/places.json);
an unknown place falls back to the country and is marked approximate.
The same kind of incident in the same country and place within MERGE_DAYS
is one incident, its sources joined.

History: config/incidents_history.json - dated cases 2022-2026 (Wikipedia's
compilation and the CSIS brief, with their own sources) and the CSIS and
IISS totals. The state: data/incidents.json. The app: PUT /api/ingest/incidents.

    python3 src/incidents.py run        # today's pool again (feeds + Google News), no report needed
    python3 src/incidents.py backfill   # the saved reports' events and also_reported, in batches
    python3 src/incidents.py stats      # what the log holds: kinds, places, sources, attribution
    python3 src/incidents.py push       # send the log to the app again
"""
import json
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, OUTPUT_DIR

ROOT = Path(__file__).resolve().parent.parent
PATH = DATA_DIR / "incidents.json"
HISTORY = ROOT / "config" / "incidents_history.json"
PLACES = ROOT / "webapp" / "public" / "forces" / "places.json"

CATS = {
    "sabotage": "Sabotage och brand",
    "kabel": "Kablar och infrastruktur",
    "dronare": "Drönare och luftrum",
    "spionage": "Spionage och gripanden",
    "hot": "Hot och våld",
    "gps": "GPS-störning",
    "paverkan": "Fysisk påverkan",
}
ATTRIBUTION = ("bekräftad", "misstänkt", "oklar")
EXCLUDED = {"RU", "BY"}
EUROPE = set("NO SE FI DK EE LV LT PL DE SK RO MD UA GB FR BE NL IS BG HU CZ AT IT ES TR GE AM AZ GR PT IE CH "
             "HR RS SI BA ME MK AL LU CY MT XK LI MC SM AD FO GL".split())
MERGE_DAYS = 3
MAX_ARTICLES = 140          # incident-like articles offered in one call
MAX_AGE_DAYS = 10           # an incident older than this is history, not the day's news
KEEP_DAYS = 800

# Words that make an article worth showing to the extraction call: English,
# Swedish, German, Polish, French, Nordic and Baltic forms. Wide on purpose:
# the model decides; this only keeps the prompt to the likely ones.
INCIDENT_WORDS = re.compile(
    r"sabotag|arson|set (?:on )?fire|fire (?:at|broke)|blaze|explosi|blast|bomb(?:ing| threat| hoax)|incendiar|"
    r"molotov|derail|rail(?:way)? (?:line|track|cable)|signal(?:ling)? cable|undersea|subsea|cable (?:cut|damag|sever|break)|"
    r"pipeline (?:damag|leak|explo)|anchor|drone(?:s)? (?:sighting|spotted|over|near|incursion)|drone incursion|unidentified drone|"
    r"airspace|violat|intercept|scramble|shot down|crash(?:ed)? (?:in|on)|gps (?:jamm|interfer|spoof)|jamming|spoofing|"
    r"spy|espionage|spying|arrest(?:ed)? .*(?:russia|gru|fsb|sabot|spy)|charged with|indicted|detained|"
    r"assassinat|murder plot|plot to (?:kill|attack)|poison|graffiti|vandal|coffins|stunt|"
    r"sabotage|mordbrand|anlagd brand|brand i|sprängning|explosion|bombhot|spårsabotage|kabel|ledning|drönar|luftrum|"
    r"kränk|störning|spion|gripen|gripits|åtal|mordförsök|klotter|"
    r"brandanschlag|anschlag|sabotage|drohne|spionage|festgenommen|"
    r"podpalen|dywersj|sabotaż|dron|szpieg|zatrzyman|"
    r"incendie|sabotage|drone|espion|"
    r"sabotasje|tuhopoltto|sabotointi|drooni|vakoilu|"
    r"padeg|diversij|sabotaž|droon|spioon",
    re.I)

SYSTEM = ("You keep a factual log of physical, subversive incidents in Europe for a Swedish monitor. "
          "You report only what the cited articles state. Strict JSON only.")


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
def load() -> dict:
    if PATH.exists():
        return json.loads(PATH.read_text(encoding="utf-8"))
    return {"incidents": [], "updated": None, "runs": []}


def save(state: dict):
    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    state["incidents"] = sorted((i for i in state["incidents"] if i["date"] >= cutoff or i.get("origin") == "historik"),
                                key=lambda i: (i["date"], i["id"]))
    state["updated"] = datetime.now().isoformat(timespec="minutes")
    state["runs"] = state.get("runs", [])[-60:]
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def history() -> dict:
    return json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else {"incidents": []}


# --------------------------------------------------------------------------
# Places
# --------------------------------------------------------------------------
_places = None


def places() -> dict:
    """{country: [(names_lower, name, lat, lon, capital)]} from the heat map's place list."""
    global _places
    if _places is None:
        _places = {}
        rows = json.loads(PLACES.read_text(encoding="utf-8"))["places"] if PLACES.exists() else []
        for names, iso, lat, lon, pop, cap in rows:
            _places.setdefault(iso, []).append(([n.lower() for n in names], names[0], lat, lon, bool(cap)))
    return _places


def _fold(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower().strip()


def locate(place, country: str):
    """(name, lat, lon, precision): the place in the country's list, else
    the country's capital marked as only the country ('land'), else None."""
    rows = places().get(country, [])
    if place:
        want = _fold(re.sub(r"\s*\(.*?\)", "", str(place)))
        for names, name, lat, lon, cap in rows:
            if want in (_fold(n) for n in names):
                return name, lat, lon, "ort"
        # "near Kaliningrad"-style or a district: the first known name inside it
        for names, name, lat, lon, cap in rows:
            if any(len(n) >= 4 and re.search(rf"\b{re.escape(_fold(n))}\b", want) for n in names):
                return name, lat, lon, "ort"
    cap = next(((name, lat, lon) for names, name, lat, lon, c in rows if c), None)
    if cap:
        return None, cap[1], cap[2], "land"
    return None


# --------------------------------------------------------------------------
# Merging
# --------------------------------------------------------------------------
def _days(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def same(a: dict, b: dict) -> bool:
    if a["cat"] != b["cat"] or a["country"] != b["country"] or _days(a["date"], b["date"]) > MERGE_DAYS:
        return False
    pa, pb = (a.get("place") or "").lower(), (b.get("place") or "").lower()
    return pa == pb or not pa or not pb


STRENGTH = {"bekräftad": 2, "misstänkt": 1, "oklar": 0}


def merge(state: dict, new: list) -> tuple:
    """Adds `new` to the log; an incident already there gains the new
    sources (and a place or a stronger attribution it lacked). Returns
    (added, merged)."""
    added = merged = 0
    for n in new:
        old = next((o for o in state["incidents"] if same(o, n)), None)
        if not old:
            state["incidents"].append(n)
            added += 1
            continue
        merged += 1
        urls = {s.get("url") for s in old["sources"]}
        old["sources"] += [s for s in n["sources"] if s.get("url") not in urls][: max(0, 8 - len(old["sources"]))]
        if not old.get("place") and n.get("place"):
            old.update({k: n[k] for k in ("place", "lat", "lon", "precision")})
        if STRENGTH.get(n["attribution"], 0) > STRENGTH.get(old["attribution"], 0):
            old["attribution"] = n["attribution"]
        old["date"] = min(old["date"], n["date"])
    return added, merged


def _id(i: dict) -> str:
    import hashlib
    key = f"{i['date']}|{i['cat']}|{i['country']}|{i.get('place') or ''}|{i['title_sv']}"
    return "i" + hashlib.sha1(key.encode()).hexdigest()[:10]


def clean(raw: dict, refs: dict, origin: str, today: str) -> dict:
    """One incident from the model, checked, or None: a known kind, a
    European country other than Russia and Belarus, a date not in the
    future, and at least one of the articles it was given."""
    if not isinstance(raw, dict):
        return None
    cat = raw.get("cat")
    country = str(raw.get("country") or "").upper().strip()
    if cat not in CATS or country in EXCLUDED or country not in EUROPE:
        return None
    d = str(raw.get("date") or today)[:10]
    try:
        if date.fromisoformat(d) > date.fromisoformat(today):
            d = today
    except ValueError:
        d = today
    sources = []
    for r in raw.get("refs") or []:
        a = refs.get(str(r).strip())
        # pool articles carry "link"; saved report articles carry "url"
        url = a and (a.get("url") or a.get("link"))
        if url and url not in {s["url"] for s in sources}:
            sources.append({"outlet": a.get("source") or a.get("outlet") or "", "title": a.get("title") or "",
                            "url": url})
    if not sources:
        return None
    title = str(raw.get("title_sv") or "").strip()[:140]
    if not title:
        return None
    loc = locate(raw.get("place"), country)
    if not loc:
        return None
    name, lat, lon, precision = loc
    attr = raw.get("attribution") if raw.get("attribution") in ATTRIBUTION else "oklar"
    out = {"date": d, "cat": cat, "country": country, "place": name or None,
           "place_named": (str(raw.get("place")).strip()[:80] or None) if raw.get("place") else None,
           "lat": round(lat, 3), "lon": round(lon, 3), "precision": precision,
           "title_sv": title, "summary_sv": str(raw.get("summary_sv") or "").strip()[:400],
           "attribution": attr, "sources": sources[:8], "origin": origin}
    out["id"] = _id(out)
    return out


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------
def prompt_for(lines: str, today: str) -> str:
    cats = "\n".join(f'   - "{k}": {v}' for k, v in CATS.items())
    return f"""Today is {today}. Below are news articles, each with a ref ([A1] ...).

List every PHYSICAL, SUBVERSIVE INCIDENT they report that took place in a European country other than
Russia and Belarus: something that was done or attempted on the ground, at sea or in the air - not a
statement, accusation, warning, policy, decision, sanction, expulsion, border closure, military aid,
exercise, report or analysis, and not online disinformation. A foiled attack or an arrest of saboteurs
or spies is an incident. Strikes inside Ukraine count only when they hit a European embassy, a foreign
civilian ship or cross into another country; ordinary war damage inside Ukraine is left out.

Kinds ("cat"):
{cats}

For each incident:
- "date": the day it happened (YYYY-MM-DD), as the articles give it; if they do not, the article's date;
- "cat": one of the kinds above;
- "country": ISO 3166-1 alpha-2 of where it happened (the sea area's nearest coastal state for cables);
- "place": the town, base, port or airport, in English, or null when the articles name none;
- "title_sv": a short Swedish headline, max ~10 words;
- "summary_sv": one or two Swedish sentences of what happened, max ~35 words;
- "attribution": "bekräftad" when a government, prosecutor or court attributes it to Russia or its
  services; "misstänkt" when officials or the articles say Russia is suspected; "oklar" otherwise;
- "refs": the refs of the articles it rests on, copied exactly (e.g. ["A3", "A17"]).
One incident once, however many articles report it. If there are none, answer {{"incidents": []}}.

Articles:
{lines}

Respond as strict JSON: {{"incidents": [{{"date": "...", "cat": "...", "country": "..", "place": "...",
"title_sv": "...", "summary_sv": "...", "attribution": "...", "refs": ["A1"]}}]}}"""


def article_lines(items: list) -> tuple:
    """("[A1] Outlet · date · title - summary" lines, {ref: article})."""
    refs, lines = {}, []
    for i, a in enumerate(items, start=1):
        ref = f"A{i}"
        refs[ref] = a
        when = a["published"].strftime("%Y-%m-%d") if isinstance(a.get("published"), datetime) else (a.get("published") or "undated")
        summary = re.sub(r"\s+", " ", a.get("summary") or "")[:260]
        lines.append(f"[{ref}] {a.get('source') or a.get('outlet') or '?'} · {when} · {a.get('title')}" + (f" - {summary}" if summary else ""))
    return "\n".join(lines), refs


def incident_like(items: list) -> list:
    out = [a for a in items if INCIDENT_WORDS.search(f"{a.get('title', '')} {a.get('summary', '')}")]
    out.sort(key=lambda a: a.get("published") if isinstance(a.get("published"), datetime) else datetime.min, reverse=True)
    return out[:MAX_ARTICLES]


def extract(items: list, today: str, origin: str = "svep", model: str = None) -> tuple:
    """(incidents, info) from articles, on the light model."""
    import common
    lines, refs = article_lines(items)
    model = model or common.lite_model() or common.MODEL
    result = common.ask_model_json(prompt_for(lines, today), system=SYSTEM, max_tokens=8000, model=model)
    raw = result.get("incidents") if isinstance(result, dict) else None
    raw = raw if isinstance(raw, list) else []
    out = [c for c in (clean(r, refs, origin, today) for r in raw) if c]
    return out, {"articles": len(items), "proposed": len(raw), "kept": len(out), "model": model}


def run(report: dict = None, pool=None) -> dict:
    """The morning step: the pool's incident-like articles, one call, merged into the log, pushed."""
    today = date.today().isoformat()
    if pool is None:
        import news_sources
        pool = news_sources.Pool()
        for q in ("Russia sabotage Europe", "drone sighting airport base Europe", "undersea cable damaged Baltic",
                  "arson Russia suspected", "spy arrested Russia Europe", "GPS jamming Baltic"):
            pool.add(news_sources.google_news(q, days=2))
    items = incident_like(pool.items)
    state = load()
    seed_history(state)
    info = {"date": today, "articles": len(items)}
    if items:
        new, more = extract(items, today)
        new = [n for n in new if _days(n["date"], today) <= MAX_AGE_DAYS]
        info.update(more)
        info["added"], info["merged"] = merge(state, new)
    state.setdefault("runs", []).append(info)
    save(state)
    print(f"  Incidents: {info.get('articles', 0)} incident-like articles, {info.get('proposed', 0)} proposed, "
          f"{info.get('kept', 0)} kept, {info.get('added', 0)} new, {info.get('merged', 0)} merged into earlier ones")
    push(state)
    return info


def run_safe(report: dict = None, pool=None):
    try:
        run(report, pool)
    except Exception as e:
        print(f"  ! Incidents failed ({type(e).__name__}: {str(e)[:200]})")


def seed_history(state: dict) -> int:
    """The dated historical cases from config/incidents_history.json, once each."""
    have = {i["id"] for i in state["incidents"]}
    n = 0
    for h in history().get("incidents", []):
        inc = {**h, "origin": "historik", "precision": "ort" if h.get("place") else "land",
               "date_precision": h.get("precision", "dag")}
        inc["id"] = _id(inc)
        if inc["id"] not in have:
            state["incidents"].append(inc)
            n += 1
    return n


def backfill(batch: int = 45) -> dict:
    """The saved reports' events and also_reported, as articles, in batches
    of `batch`: each gets its report's date. No feeds are read again."""
    import common
    state = load()
    seed_history(state)
    items = []
    for f in sorted(OUTPUT_DIR.glob("*_report_data.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        d = r.get("date")
        for e in r.get("events", []):
            arts = [a for a in e.get("articles") or [] if a.get("url")]
            if not arts:
                continue
            items.append({"title": e.get("title") or e.get("title_sv"), "summary": e.get("detail") or e.get("summary_sv") or "",
                          "source": ", ".join(dict.fromkeys(a.get("outlet") or "" for a in arts[:3])), "published": d,
                          "link": arts[0]["url"], "all": arts, "_date": d})
        for x in r.get("also_reported") or []:
            refs = [a for a in x.get("refs") or [] if a.get("url")]
            if refs:
                items.append({"title": x.get("title_sv"), "summary": "", "source": refs[0].get("outlet") or "",
                              "published": d, "link": refs[0]["url"], "all": refs, "_date": d})
    items = [a for a in items if INCIDENT_WORDS.search(f"{a['title']} {a['summary']}")]
    total = {"items": len(items), "proposed": 0, "kept": 0, "added": 0, "merged": 0, "batches": 0}
    model = common.lite_model() or common.MODEL
    for k in range(0, len(items), batch):
        chunk = items[k:k + batch]
        today = max(a["_date"] for a in chunk)
        lines, refs = article_lines(chunk)
        try:
            result = common.ask_model_json(prompt_for(lines, today), system=SYSTEM, max_tokens=8000, model=model)
        except Exception as e:
            print(f"  ! Backfill batch {k // batch + 1}: {type(e).__name__}: {str(e)[:120]}")
            continue
        raw = result.get("incidents") if isinstance(result, dict) else []
        raw = raw if isinstance(raw, list) else []
        new = []
        for r in raw:
            c = clean(r, refs, "efterhand", today)
            if not c:
                continue
            # every article of the event becomes a source, not only the first
            for ref in r.get("refs") or []:
                for a in (refs.get(str(ref)) or {}).get("all", [])[1:]:
                    if a.get("url") not in {s["url"] for s in c["sources"]}:
                        c["sources"].append({"outlet": a.get("outlet") or "", "title": a.get("title") or "", "url": a["url"]})
            c["sources"] = c["sources"][:8]
            new.append(c)
        a, m = merge(state, new)
        total["proposed"] += len(raw)
        total["kept"] += len(new)
        total["added"] += a
        total["merged"] += m
        total["batches"] += 1
        print(f"  Backfill batch {k // batch + 1}: {len(chunk)} items, {len(raw)} proposed, {len(new)} kept, {a} new")
    state.setdefault("runs", []).append({"date": date.today().isoformat(), "backfill": True, **total})
    save(state)
    print(f"  Backfill: {total}")
    push(state)
    return total


# --------------------------------------------------------------------------
# The app
# --------------------------------------------------------------------------
def payload(state: dict) -> dict:
    h = history()
    return {"generated_at": datetime.now().isoformat(timespec="minutes"), "date": date.today().isoformat(),
            "cats": CATS, "incidents": state["incidents"],
            "history": {k: h.get(k) for k in ("csis", "iiss", "sources")}}


def push(state: dict) -> bool:
    from app_sync import push_incidents
    return push_incidents(payload(state))


def stats(state: dict = None) -> dict:
    state = state or load()
    inc = [i for i in state["incidents"] if i.get("origin") != "historik"]
    out = {
        "incidents": len(inc), "history": len(state["incidents"]) - len(inc),
        "by_cat": Counter(i["cat"] for i in inc).most_common(),
        "by_country": Counter(i["country"] for i in inc).most_common(12),
        "by_attribution": Counter(i["attribution"] for i in inc).most_common(),
        "with_place": sum(1 for i in inc if i.get("precision") == "ort"),
        "place_named_not_found": sum(1 for i in inc if i.get("place_named") and i.get("precision") != "ort"),
        "multi_source": sum(1 for i in inc if len(i["sources"]) > 1),
        "ukraine": sum(1 for i in inc if i["country"] == "UA"),
        "runs": state.get("runs", [])[-10:],
    }
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    if cmd == "run":
        run()
    elif cmd == "backfill":
        backfill()
    elif cmd == "push":
        st = load()
        seed_history(st)
        save(st)
        push(st)
    else:
        print(json.dumps(stats(), ensure_ascii=False, indent=1))
