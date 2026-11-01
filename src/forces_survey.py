"""
The forces map's survey: what is known about each base from its Wikipedia
article, read again every week, so every base on the map says what it is
and what is there - not only the hand-kept ones.

It rolls: each night, after the night's update in forces.py, the bases
surveyed longest ago (never surveyed first) are read, BATCH to a Gemini
call, NIGHTLY_BATCHES calls a night - enough to go round all the bases in
a week. The calls go to a lighter Gemini model than the rest of the
monitor (FORCES_SURVEY_MODEL, else the newest "flash-lite" the key can
use): on the free tier each model has its own daily quota, so the survey
never takes calls from the reports. With no such model it does nothing.

Per base: the Wikipedia article (English, else Russian), found through
Wikidata's links or, for hand-kept bases without a Wikidata id, a search.
The model writes a short Swedish description and the units and equipment
the article names as there now, and the year the article's facts refer to.
Nothing else is read: news is the nightly update's part.

    python3 src/forces.py survey --batches 18   # a full round now
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

UA = "threat-monitor/1 (https://github.com/jeaneclaude621-ui/threat_monitor)"
BATCH = 15
NIGHTLY_BATCHES = 3
REFRESH_DAYS = 7
ARTICLE_CHARS = 5000
GAP = 0.5             # seconds between Wikipedia requests


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def survey_model() -> str:
    """FORCES_SURVEY_MODEL, else the newest flash-lite model the key can
    use, else None."""
    if os.environ.get("FORCES_SURVEY_MODEL"):
        return os.environ["FORCES_SURVEY_MODEL"]
    from common import get_client
    client = get_client()   # kept: the list pages lazily, and a dropped client is closed
    names = [m.name.removeprefix("models/") for m in client.models.list()]
    lite = [n for n in names if "flash-lite" in n and not re.search(r"preview|exp|tts|image|audio|live", n)]
    if not lite:
        return None

    def version(n):
        m = re.search(r"gemini-(\d+)(?:\.(\d+))?", n)
        return (int(m[1]), int(m[2] or 0), -len(n)) if m else (0, 0, 0)
    return max(lite, key=version)


def wikidata_titles(ids: list) -> dict:
    """{qid: (lang, title)} from Wikidata's site links, English first."""
    out = {}
    for i in range(0, len(ids), 50):
        q = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(ids[i:i + 50]), "props": "sitelinks",
                                    "sitefilter": "enwiki|ruwiki", "format": "json"})
        try:
            ents = _get(f"https://www.wikidata.org/w/api.php?{q}").get("entities", {})
        except Exception as e:
            print(f"  ! Survey: Wikidata links failed ({type(e).__name__})")
            continue
        for qid, ent in ents.items():
            links = ent.get("sitelinks") or {}
            for lang in ("en", "ru"):
                if f"{lang}wiki" in links:
                    out[qid] = (lang, links[f"{lang}wiki"]["title"])
                    break
        time.sleep(GAP)
    return out


def search_title(name: str) -> tuple:
    """An English article for a base without a Wikidata id: the first hit
    whose title shares a word with the base's name."""
    words = {w.lower() for w in re.findall(r"\w{4,}", re.sub(r"\(.*?\)", "", name))}
    q = urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": f"{name} Russia military base",
                                "srlimit": 3, "format": "json"})
    try:
        hits = _get(f"https://en.wikipedia.org/w/api.php?{q}")["query"]["search"]
    except Exception:
        return None
    time.sleep(GAP)
    for h in hits:
        if words & {w.lower() for w in re.findall(r"\w{4,}", h["title"])}:
            return ("en", h["title"])
    return None


def article(lang: str, title: str) -> str:
    q = urllib.parse.urlencode({"action": "query", "prop": "extracts", "explaintext": 1, "redirects": 1,
                                "titles": title, "format": "json"})
    try:
        pages = _get(f"https://{lang}.wikipedia.org/w/api.php?{q}")["query"]["pages"]
    except Exception:
        return ""
    time.sleep(GAP)
    text = next(iter(pages.values())).get("extract") or ""
    # Reference lists and links say nothing about the base.
    text = re.split(r"\n==+ ?(See also|References|External links|Notes|Литература|Примечания|Ссылки) ?==+", text)[0]
    return text[:ARTICLE_CHARS]


def due(bases: list, today: date) -> list:
    """Bases never surveyed first, then those surveyed longest ago."""
    cutoff = (today - timedelta(days=REFRESH_DAYS)).isoformat()
    todo = [b for b in bases if not b.get("survey") or b["survey"]["date"] <= cutoff]
    return sorted(todo, key=lambda b: (b.get("survey") or {}).get("date", ""))


def prompt_for(batch: list) -> str:
    parts = []
    for b, (lang, title, text) in batch:
        parts.append(f"### {b['id']} | {b['name']} | {b['branch']} | {b['country']}\n"
                     f"Article ({lang}.wikipedia.org, \"{title}\"):\n{text}")
    return f"""For each Russian or Belarusian military base below, read its Wikipedia
article and record, for a Swedish monitor:
- "summary_sv": 2-3 plain Swedish sentences: what the base is, its role, and
  anything the article says about its use since 2022 (attacks, moves).
- "units": the units the article says are based there NOW (not disbanded
  or moved away), as named in the article, translated to Swedish where
  natural (e.g. "121:a gardes tunga bombflygregementet").
- "equipment": aircraft, ships, missiles or systems there now (e.g. "Tu-160",
  "S-400", "Borej-klass").
- "as_of": the latest year the article's facts about units refer to, or null.
Only what the article says; empty lists when it names nothing current.

{chr(10).join(parts)}

Respond as strict JSON:
{{"bases": [{{"id": "Q123", "summary_sv": "...", "units": ["..."], "equipment": ["..."], "as_of": 2024}}]}}"""


def _strs(v, n=15, size=150) -> list:
    return [x.strip()[:size] for x in v if isinstance(x, str) and x.strip()][:n] if isinstance(v, list) else []


def run(state: dict, batches: int = NIGHTLY_BATCHES) -> int:
    """Survey up to `batches` x BATCH bases in the state. Returns how many
    bases got a survey. Never raises on a single failed call."""
    from common import ask_model_json
    today = date.today()
    todo = due(state["bases"], today)[:batches * BATCH]
    if not todo:
        return 0
    model = survey_model()
    if not model:
        print("  ! Survey: no flash-lite model available; skipped")
        return 0
    titles = wikidata_titles([b["id"] for b in todo if re.fullmatch(r"Q\d+", b["id"])])
    found = []
    for b in todo:
        hit = titles.get(b["id"]) or (search_title(b["name"]) if not b["id"].startswith("Q") else None)
        text = article(*hit) if hit else ""
        if text:
            found.append((b, (hit[0], hit[1], text)))
        else:
            b["survey"] = {"date": today.isoformat(), "none": True}
    done = 0
    for i in range(0, len(found), BATCH):
        batch = found[i:i + BATCH]
        try:
            result = ask_model_json(prompt_for(batch), max_tokens=8000, model=model,
                                    system="You extract facts from Wikipedia articles about military bases. Strict JSON only.")
        except Exception as e:
            print(f"  ! Survey call failed ({type(e).__name__}: {str(e)[:200]}); the rest waits for the next night")
            break
        answers = {a.get("id"): a for a in result.get("bases") or [] if isinstance(a, dict)}
        for b, (lang, title, _) in batch:
            a = answers.get(b["id"])
            if not a:
                continue
            as_of = a.get("as_of") if isinstance(a.get("as_of"), int) and 1990 <= a["as_of"] <= today.year else None
            b["survey"] = {"date": today.isoformat(), "summary_sv": (a.get("summary_sv") or "").strip()[:800] or None,
                           "units": _strs(a.get("units")), "equipment": _strs(a.get("equipment")), "as_of": as_of,
                           "source": {"url": f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
                                      "outlet": f"Wikipedia ({lang})"}}
            done += 1
    print(f"  Survey ({model}): {done} bases read, {len(todo) - len(found)} without an article, "
          f"{len(due(state['bases'], today))} still due")
    return done
