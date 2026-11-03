"""
The forces map's nightly ISW reading: where the database's units fight now.

ISW's "Russian Offensive Campaign Assessment" names Russian units and where
they operate. Each night this module reads the newest assessment (the copy
on criticalthreats.org; understandingwar.org sits behind a bot challenge),
keeps in Python only the paragraphs that name a unit in the foundation
database, and asks the light model once to turn them into short Swedish
status lines. No paragraph names a unit: no call. At most one call a day.

The result lives in the forces state (data/forces.json) as
state["units"][unit_id] = {"status_sv", "status_as_of", "status_source": [the
last five entries]}, and goes to the app with the payload.

    python3 src/forces.py isw --dry-run    # the paragraphs and the prompt, no call
"""
import html
import json
import re
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNITS_PATH = ROOT / "config" / "forces_db" / "units.json"
UA = "threat-monitor/1 (https://github.com/jeaneclaude621-ui/threat_monitor)"
SOURCES = [
    "https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-{month}-{day}-{year}",
    "https://www.understandingwar.org/research/russia-ukraine/russian-offensive-campaign-assessment-{month}-{day}-{year}/",
]
ISW_URL = re.compile(r"^https://(www\.)?(criticalthreats\.org|understandingwar\.org)/")
LOOKBACK_DAYS = 3        # the newest assessment of the last few days
MAX_AGE_DAYS = 3         # a status line older than this is refused
MAX_PARAGRAPHS = 40
MAX_CHARS = 24_000       # what goes to the model
HISTORY = 5              # entries kept per unit

# Swedish unit kind (from name_sv) -> how ISW writes it.
KINDS = {
    "motoriserade skytteregementet": r"Motori[sz]ed Rifle Regiment",
    "motoriserade skyttebrigaden": r"Motori[sz]ed Rifle Brigade",
    "motoriserade skyttedivisionen": r"(?:Motori[sz]ed Rifle Division|MRD)",
    "motoriserade skyttebataljonen": r"Motori[sz]ed Rifle Battalion",
    "stridsvagnsregementet": r"Tank Regiment",
    "stridsvagnsbrigaden": r"Tank Brigade",
    "stridsvagnsbataljonen": r"Tank Battalion",
    "stridsvagnsdivisionen": r"(?:Tank Division|TD)",
    "stridsvagnsarmén": r"(?:Guards )?(?:Tank Army|GTA)",
    "armén": r"(?:Combined Arms Army|CAA)",
    "armékåren": r"(?:Army Corps|AC)",
    "artilleribrigaden": r"Artillery Brigade",
    "tunga artilleribrigaden": r"Heavy Artillery Brigade",
    "raketartilleribrigaden": r"(?:Rocket Artillery|MLRS) Brigade",
    "artilleriregementet": r"Artillery Regiment",
    "självgående artilleriregementet": r"(?:Self-Propelled )?Artillery Regiment",
    "artilleridivisionen": r"Artillery Division",
    "robotbrigaden": r"(?:Missile|Rocket) Brigade",
    "specialförbandsbrigaden (Spetsnaz)": r"(?:Spetsnaz|Special Purpose|Special Forces) Brigade",
    "specialförbandsregementet": r"(?:Spetsnaz|Special Purpose|Special Forces) Regiment",
    "luftanfallsregementet": r"(?:Air Assault|VDV|Airborne \(VDV\)) Regiment",
    "luftanfallsdivisionen": r"(?:Air Assault|VDV|Airborne \(VDV\)) Division",
    "luftanfallsbrigaden": r"(?:Air Assault|VDV) Brigade",
    "fallskärmsregementet": r"(?:Airborne|Parachute|VDV) Regiment",
    "luftlandsättningsdivisionen": r"(?:Airborne|VDV|Airborne \(VDV\)) Division",
    "luftlandsättningsbrigaden": r"(?:Airborne|VDV) Brigade",
    "marininfanteribrigaden": r"Naval Infantry Brigade",
    "marininfanteridivisionen": r"Naval Infantry Division",
    "marininfanteriregementet": r"Naval Infantry Regiment",
    "marininfanteribataljonen": r"Naval Infantry Battalion",
    "kustförsvarsbrigaden": r"Coastal Defen[cs]e Brigade",
    "underrättelsebrigaden": r"Reconnaissance Brigade",
    "ingenjörbrigaden": r"Engineer Brigade",
    "kulsprute- och artilleridivisionen": r"Machine Gun Artillery Division",
    "luftvärnsrobotbrigaden": r"(?:Anti-Aircraft|Air Defen[cs]e) Missile Brigade",
    "telekrigsbrigaden": r"Electronic Warfare Brigade",
}


def _ordinal(n: int) -> str:
    return f"{n}{'th' if n % 100 in (11, 12, 13) else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def unit_index(units: list = None) -> dict:
    """{unit id: compiled pattern} for every unit whose name ISW can write."""
    if units is None:
        units = json.load(open(UNITS_PATH, encoding="utf-8"))["units"]
    out = {}
    for u in units:
        if u.get("type") == "fartyg":
            continue
        m = re.match(r"^(\d+):\w+ (.*)$", u.get("name_sv") or "")
        if not m:
            continue
        kind = re.sub(r"\b(gardes|självständiga) ", "", m[2]).strip()
        if kind not in KINDS:
            continue
        out[u["id"]] = re.compile(rf"\b{_ordinal(int(m[1]))} (?:Guards )?(?:Separate )?(?:Guards )?{KINDS[kind]}\b")
    return out


def paragraphs(page: str) -> list:
    """The page's paragraphs as plain text."""
    page = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", page)
    parts = re.split(r"(?i)</p>|</li>|</h\d>|</div>|<br\s*/?>\s*<br\s*/?>", page)
    out = []
    for p in parts:
        t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", p))).strip()
        t = re.sub(r"\[\s*[ivxlc\d]+\s*\]", "", t)          # footnote marks
        if len(t) > 60:
            out.append(t)
    return out


def prefilter(paras: list, index: dict) -> list:
    """[(paragraph, [unit ids])] for the paragraphs that name a unit, the
    most units first, within MAX_PARAGRAPHS and MAX_CHARS."""
    hits = []
    for p in paras:
        ids = [uid for uid, pat in index.items() if pat.search(p)]
        if not ids:
            continue
        if len(p) > 1500:
            # A long block: keep the sentences that name a unit, and the one before.
            sents = re.split(r"(?<=[.!?])\s+(?=[A-Z\[])", p)
            keep = set()
            for i, t in enumerate(sents):
                if any(index[uid].search(t) for uid in ids):
                    keep.update({i - 1, i})
            p = " ".join(sents[i] for i in sorted(keep) if 0 <= i < len(sents))
        hits.append((p, ids))
    hits.sort(key=lambda h: -len(h[1]))
    out, size = [], 0
    for p, ids in hits[:MAX_PARAGRAPHS]:
        if size + len(p) > MAX_CHARS:
            break
        out.append((p[:2000], ids))
        size += len(p)
    return out


def fetch_latest(today: date, get=None) -> tuple:
    """(date, url, page html) of the newest assessment within LOOKBACK_DAYS,
    or (None, None, None)."""
    get = get or _get
    for back in range(LOOKBACK_DAYS + 1):
        d = today - timedelta(days=back)
        for pattern in SOURCES:
            url = pattern.format(month=d.strftime("%B").lower(), day=d.day, year=d.year)
            try:
                page = get(url)
            except Exception:
                continue
            if page and "Russian" in page and len(paragraphs(page)) > 10:
                return d, url, page
    return None, None, None


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def prompt_for(hits: list, units: dict, day: date, url: str) -> str:
    names = sorted({uid for _, ids in hits for uid in ids})
    roster = "\n".join(f"- {uid}: {units[uid].get('name_en') or units[uid]['name_sv']}" for uid in names)
    text = "\n\n".join(f"[{i + 1}] {p}" for i, (p, _) in enumerate(hits))
    return f"""ISW's Russian Offensive Campaign Assessment of {day.isoformat()} ({url}).

Below are its paragraphs that name Russian units, and the candidate units (id: name).
For each candidate unit the paragraphs say something about, give where it is operating
and what it is doing, in one short Swedish phrase, as ISW puts it (keep "enligt ISW",
"enligt en rysk militärbloggare" and similar attributions; never state a claim as fact).
Skip a unit the paragraphs only mention in passing (history, a commander's name).

Candidate units:
{roster}

Paragraphs:
{text}

Answer with strict JSON only, a list:
[{{"unit_id": "<an id from the list>", "place": "<place or direction, Latin letters>",
  "activity_sv": "<Swedish, at most 160 characters>", "date": "{day.isoformat()}", "url": "{url}"}}]"""


def validate(answer, units: dict, today: date) -> list:
    """The model's entries that name a known unit, carry a recent date and
    point at ISW; everything else is dropped."""
    if isinstance(answer, dict):
        answer = answer.get("units") or answer.get("entries") or []
    out = []
    if not isinstance(answer, list):
        return out
    for e in answer:
        if not isinstance(e, dict) or e.get("unit_id") not in units:
            continue
        try:
            d = date.fromisoformat(str(e.get("date"))[:10])
        except ValueError:
            continue
        if not (today - timedelta(days=MAX_AGE_DAYS) <= d <= today):
            continue
        url = str(e.get("url") or "")
        activity = re.sub(r"\s+", " ", str(e.get("activity_sv") or "")).strip()[:200]
        place = re.sub(r"\s+", " ", str(e.get("place") or "")).strip()[:120]
        if not ISW_URL.match(url) or not activity:
            continue
        out.append({"unit_id": e["unit_id"], "place": place, "activity_sv": activity, "date": d.isoformat(), "url": url})
    return out


def apply(state: dict, entries: list) -> int:
    """Each entry becomes the unit's newest status; the last HISTORY kept."""
    units = state.setdefault("units", {})
    for e in entries:
        u = units.setdefault(e["unit_id"], {"status_source": []})
        line = e["activity_sv"] + (f" ({e['place']})" if e["place"] and e["place"].lower() not in e["activity_sv"].lower() else "")
        post = {"status_sv": line, "date": e["date"], "url": e["url"], "outlet": "ISW / Critical Threats"}
        hist = [p for p in u.get("status_source", []) if not (p["date"] == post["date"] and p["status_sv"] == post["status_sv"])]
        u["status_source"] = sorted([post] + hist, key=lambda p: p["date"], reverse=True)[:HISTORY]
        u["status_sv"] = u["status_source"][0]["status_sv"]
        u["status_as_of"] = u["status_source"][0]["date"]
    return len(entries)


def run(state: dict, today: date = None, dry_run: bool = False, get=None, ask=None) -> int:
    """The night's ISW reading. Returns the number of unit statuses set.
    At most one model call a day (state["isw"]["called"])."""
    today = today or date.today()
    meta = state.setdefault("isw", {})
    if not dry_run and meta.get("called") == today.isoformat():
        print("  ISW: already read today")
        return 0
    day, url, page = fetch_latest(today, get)
    if not page:
        print("  ISW: no assessment found for the last days")
        return 0
    if not dry_run and meta.get("read") == url:
        print(f"  ISW: {day} already read")
        return 0
    all_units = json.load(open(UNITS_PATH, encoding="utf-8"))["units"]
    units = {u["id"]: u for u in all_units}
    hits = prefilter(paragraphs(page), unit_index(all_units))
    print(f"  ISW: {day}, {len(hits)} paragraphs name {len({i for _, ids in hits for i in ids})} database units")
    if not hits:
        meta["read"] = url
        return 0
    prompt = prompt_for(hits, units, day, url)
    if dry_run:
        print(prompt)
        return 0
    if ask is None:
        from common import ask_model_json, lite_model
        model = lite_model()
        if not model:
            print("  ! ISW: no light model available; skipped")
            return 0

        def ask(p):
            return ask_model_json(p, max_tokens=4000, model=model,
                                  system="You extract where Russian units operate from ISW text. Strict JSON only.")
    meta["called"] = today.isoformat()      # counted before the call: a failure still spends it
    answer = ask(prompt)
    entries = validate(answer, units, today)
    meta["read"] = url
    meta["at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    n = apply(state, entries)
    print(f"  ISW: {n} unit statuses from {day}")
    return n
