"""
Russia's air attacks on Ukraine for the app's strike map: per night, what
was launched (drones, cruise and ballistic missiles), from where, at which
regions, and how much was shot down.

Source: the Kaggle dataset "Massive Missile Attacks on Ukraine"
(piterfm/massive-missile-attacks-on-ukraine), compiled daily from the
Ukrainian Air Force's reports. Kaggle needs a free account: the secrets
KAGGLE_USERNAME and KAGGLE_KEY. Without them this does nothing.

The places in the data are names ("Kursk oblast and Primorsko-Akhtarsk");
LAUNCH and TARGET below put them on the map. A name not there is kept in
the row's text but not drawn, and printed so it can be added.

The dataset is updated about once a week, so the nights after its newest
one are read from news headlines quoting the Air Force (Google News, no
Russian state media): one light-model call a night at most, for totals per
weapon kind and the regions named. Such a night is marked "preliminary"
and kept until the dataset covers it. Without a light model, or with no
headlines, the gap stays empty.

Run by daily_report.py after the forces map, or alone:

    python3 src/strikes.py              # fetch, build, upload
    python3 src/strikes.py --dry-run    # fetch and print, no upload
"""
import argparse
import base64
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR
import blocklist

DATASET = "piterfm/massive-missile-attacks-on-ukraine"
URL = f"https://www.kaggle.com/api/v1/datasets/download/{DATASET}"
SOURCE_URL = f"https://www.kaggle.com/datasets/{DATASET}"
DAYS = 30
PATH = DATA_DIR / "strikes.json"

# Launch areas, lat/lon (approximate centres).
LAUNCH = {
    "kursk oblast": (51.7, 36.2), "kursk": (51.73, 36.19), "oryol oblast": (52.9, 36.1), "orel oblast": (52.9, 36.1),
    "oryol": (52.97, 36.07), "bryansk oblast": (52.9, 33.4), "bryansk": (53.25, 34.37), "navlya": (52.83, 34.5),
    "belgorod oblast": (50.7, 37.4), "belgorod": (50.6, 36.6), "voronezh oblast": (50.9, 40.0), "voronezh": (51.67, 39.2),
    "rostov oblast": (47.7, 41.0), "millerovo": (48.95, 40.3), "taganrog": (47.2, 38.9), "morozovsk": (48.31, 41.79),
    "krasnodar krai": (45.3, 39.0), "primorsko-akhtarsk": (46.04, 38.17), "yeysk": (46.68, 38.21),
    "novorossiysk": (44.72, 37.79), "shatalovo": (54.33, 32.47), "smolensk oblast": (54.8, 32.5),
    "kaluga oblast": (54.4, 35.4), "tula oblast": (54.0, 37.5), "lipetsk oblast": (52.6, 39.4),
    "tambov oblast": (52.7, 41.5), "ryazan oblast": (54.4, 40.6), "saratov oblast": (51.5, 46.5),
    "engels": (51.48, 46.21), "volgograd oblast": (49.5, 44.0), "astrakhan oblast": (47.0, 47.5),
    "caspian sea": (44.5, 49.5), "black sea": (43.8, 34.5), "sea of azov": (46.0, 36.5), "azov sea": (46.0, 36.5),
    "crimea": (45.3, 34.3), "cape chauda": (45.0, 35.83), "hvardiiske": (45.12, 33.98), "gvardeyskoye": (45.12, 33.98),
    "saky": (45.09, 33.6), "chauda": (45.0, 35.83), "vologda oblast": (59.9, 40.0), "dzhankoi": (45.7, 34.42), "donetsk oblast": (48.0, 37.8), "luhansk oblast": (48.6, 39.3),
    "zaporizhzhia oblast": (47.3, 35.5), "kherson oblast": (46.6, 33.4), "mozdok": (43.79, 44.6),
    "murmansk oblast": (68.5, 33.0), "olenya": (68.15, 33.46), "shaykovka": (54.23, 34.37),
    "soltsy": (58.14, 30.33), "orel": (52.97, 36.07), "prymorsko-akhtarsk": (46.04, 38.17), "donetsk": (48.0, 37.8),
    "luhansk": (48.57, 39.31), "mariupol": (47.1, 37.55), "smolensk": (54.78, 32.05), "kaluga": (54.53, 36.27),
    "lipetsk": (52.61, 39.6), "tambov": (52.72, 41.45), "voronezh oblast": (50.9, 40.0), "millerovo": (48.95, 40.3), "orenburg oblast": (51.8, 55.1), "orenburg": (51.77, 55.1), "belarus": (53.7, 27.9), "kaliningrad": (54.7, 20.5),
}
# Target regions in Ukraine, lat/lon (oblast centres).
TARGET = {
    "ukraine": (49.0, 31.4), "kyiv": (50.45, 30.52), "kyiv oblast": (50.3, 30.4), "kharkiv": (49.99, 36.23),
    "kharkiv oblast": (49.6, 36.6), "odesa": (46.48, 30.72), "odesa oblast": (46.8, 30.0), "dnipro": (48.46, 35.04),
    "dnipropetrovsk oblast": (48.3, 35.0), "zaporizhzhia": (47.84, 35.14), "zaporizhzhia oblast": (47.4, 35.6),
    "mykolaiv": (46.97, 31.99), "mykolaiv oblast": (47.3, 31.8), "kherson": (46.64, 32.62), "kherson oblast": (46.7, 33.3),
    "sumy": (50.91, 34.8), "sumy oblast": (51.0, 34.0), "chernihiv": (51.5, 31.3), "chernihiv oblast": (51.3, 32.0),
    "poltava": (49.59, 34.55), "poltava oblast": (49.6, 33.8), "cherkasy oblast": (49.2, 31.6), "cherkasy": (49.44, 32.06),
    "kirovohrad oblast": (48.4, 32.2), "kropyvnytskyi": (48.51, 32.26), "vinnytsia oblast": (49.1, 28.6),
    "vinnytsia": (49.23, 28.47), "zhytomyr oblast": (50.5, 28.4), "zhytomyr": (50.25, 28.66),
    "khmelnytskyi oblast": (49.4, 27.0), "khmelnytskyi": (49.42, 26.99), "starokostiantyniv": (49.76, 27.2),
    "rivne oblast": (50.9, 26.4), "volyn oblast": (51.2, 25.0), "lviv oblast": (49.8, 24.0), "lviv": (49.84, 24.03),
    "ternopil oblast": (49.4, 25.5), "ivano-frankivsk oblast": (48.8, 24.5), "kolomyia": (48.53, 25.04),
    "chernivtsi oblast": (48.3, 25.9), "zakarpattia oblast": (48.4, 23.3), "donetsk oblast": (48.2, 37.6),
    "kramatorsk": (48.72, 37.56), "sloviansk": (48.85, 37.6), "luhansk oblast": (48.8, 38.9),
    "ochakiv": (46.61, 31.55), "kryvyi rih": (47.91, 33.39), "pavlohrad": (48.53, 35.87), "izmail": (45.35, 28.84),
    "south": (47.0, 32.5), "north": (51.0, 31.5), "east": (49.0, 36.5), "west": (49.5, 25.0), "center": (49.0, 32.0),
    "centre": (49.0, 32.0), "south-east": (47.6, 35.5), "north-east": (50.6, 35.2), "center-east": (48.6, 34.8),
    "center-west": (49.6, 27.5), "south-west": (47.5, 29.5), "north-west": (51.0, 26.5),
}
KINDS = [("drönare", re.compile(r"shahed|geran|gerbera|uav|drone|lancet|italmas|parody|гербера", re.I)),
         ("ballistisk robot", re.compile(r"iskander-m|kn-23|kinzhal|x-47|kh-47|ballistic|[sc]-[34]00|tochka|oreshnik", re.I)),
         ("kryssningsrobot", re.compile(r"x-\d|kh-\d|kalibr|iskander-k|onyx|oniks|cruise|zircon|tsirkon|p-800|banderol", re.I))]
# The dataset's weapon names -> the ids of the app's weapon catalogue
# (webapp/public/forces/systems.json), for the picture and performance card.
SYSTEM_IDS = {
    "shahed-136": "geran-2", "shahed": "geran-2", "geran-2": "geran-2", "131": "shahed-131", "geran-3": "geran-3",
    "geran-4": "geran-4", "geran-5": "geran-5", "gerbera": "gerbera", "x-101": "kh-101", "x-555": "kh-555",
    "kalibr": "kalibr", "iskander-m": "iskander-m", "iskander-k": "iskander-k", "kn-23": "kn-23",
    "x-47 kinzhal": "kinzhal", "kinzhal": "kinzhal", "x-22": "kh-22", "x-32": "kh-32", "x-59": "kh-59", "x-69": "kh-69",
    "x-31p": "kh-31p", "x-31pd": "kh-31p", "x-31": "kh-31", "x-35": "kh-35", "x-35y": "kh-35", "p-800 oniks": "oniks",
    "3m22 zircon": "tsirkon", "zircon": "tsirkon", "c-300": "s-300", "c-400": "s-400", "banderol": "banderol",
    "orlan-10": "orlan-10", "lancet": "lancet", "supercam": "supercam", "zala": "zala", "merlin-vr": "merlin-vr",
    "orion": "orion", "mohajer-6": "mohajer-6", "forpost": "forpost",
}


def system_ids(model: str) -> list:
    """"C-400 and Iskander-M/KN-23" -> ["s-400", "iskander-m", "kn-23"]."""
    out = []
    for part in re.split(r"\s+and\s+|/", (model or "").lower()):
        sid = SYSTEM_IDS.get(part.strip())
        if sid and sid not in out:
            out.append(sid)
    return out


def kind_of(model: str) -> str:
    return next((k for k, rx in KINDS if rx.search(model or "")), "övrigt")


# Cyrillic letters that look Latin, as typed into the dataset ("Zakarpattia оblast").
LOOKALIKES = str.maketrans("аеорсухіјкмтвн", "aeopcyxijkmtbh")


def places(text: str, table: dict) -> tuple:
    """([{name, lat, lon}], [unknown names]) from "A and B, C"."""
    found, unknown = [], []
    for part in re.split(r"\s+and\s+|,|;|/", text or ""):
        name = part.strip().lower().replace("’", "'")
        if re.search(r"[a-z]", name):   # a Latin name with a stray Cyrillic look-alike
            name = name.translate(LOOKALIKES)
        if not name:
            continue
        key = name if name in table else name.removesuffix(" region").replace(" region", " oblast")
        if key in table:
            lat, lon = table[key]
            found.append({"name": part.strip(), "lat": lat, "lon": lon})
        else:
            unknown.append(part.strip())
    return found, unknown


def _num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def download() -> list:
    user, key = os.environ.get("KAGGLE_USERNAME"), os.environ.get("KAGGLE_KEY")
    if not (user and key):
        return None
    auth = base64.b64encode(f"{user}:{key}".encode()).decode()
    req = urllib.request.Request(URL, headers={"Authorization": f"Basic {auth}", "User-Agent": "threat-monitor/1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        zf = zipfile.ZipFile(io.BytesIO(r.read()))
    name = next(n for n in zf.namelist() if n.endswith("missile_attacks_daily.csv"))
    return list(csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="utf-8")))


def build(rows: list, today: date) -> dict:
    since = (today - timedelta(days=DAYS)).isoformat()
    nights, unknown = {}, Counter()
    for r in rows:
        end = (r.get("time_end") or r.get("time_start") or "")[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end) or end < since:
            continue
        launch, u1 = places(r.get("launch_place"), LAUNCH)
        # target_main names the regions actually aimed at when the report
        # gives them; target is often only "Ukraine" or a direction.
        main = (r.get("target_main") or "").strip()
        target, u2 = places(main or r.get("target"), TARGET)
        unknown.update(u1 + u2)
        unspecified = not target or all(t["name"].lower() == "ukraine" for t in target)
        model = (r.get("model") or "").strip()
        nights.setdefault(end, []).append({
            "model": model[:120], "kind": kind_of(model), "launched": _num(r.get("launched")),
            "destroyed": _num(r.get("destroyed")), "carrier": (r.get("carrier") or "").strip()[:120] or None,
            "launch_place": (r.get("launch_place") or "").strip()[:300], "target": (r.get("target") or "").strip()[:300],
            "target_main": main[:300] or None, "unspecified": unspecified, "systems": system_ids(model),
            "hits": _num(r.get("num_hit_location")), "fragments": _num(r.get("num_fall_fragment_location")),
            "hidden": r.get("status_data") == "hidden",
            "from": launch, "to": [] if unspecified else target, "time_start": (r.get("time_start") or "")[:16], "time_end": (r.get("time_end") or "")[:16]})
    if unknown:
        print("  Strikes: places not on the map: " + ", ".join(f"{n} ({c})" for n, c in unknown.most_common(25)))
    days = []
    for d in sorted(nights, reverse=True):
        totals = {}
        for row in nights[d]:
            t = totals.setdefault(row["kind"], {"launched": 0, "destroyed": 0})
            t["launched"] += row["launched"] or 0
            t["destroyed"] += row["destroyed"] or 0
        days.append({"date": d, "rows": nights[d][:60], "totals": totals})
    return {"generated_at": datetime.now().astimezone().isoformat(timespec="seconds"), "date": today.isoformat(),
            "source": {"url": SOURCE_URL, "outlet": "Kaggle: Massive Missile Attacks on Ukraine (ukrainska flygvapnets rapporter)"},
            "days": days}


# --------------------------------------------------------------------------
# Preliminary nights from news headlines
PRELIM_QUERIES = [
    'Ukraine "air force" drones missiles overnight',
    'Russia launched drones overnight Ukraine "shot down"',
    'Russia attacked Ukraine overnight drones missiles air force',
]
PRELIM_MAX_NIGHTS = 7
KIND_NAMES = {"drönare", "kryssningsrobot", "ballistisk robot"}


def headlines(days: int) -> dict:
    """{YYYY-MM-DD (Kyiv morning): [article]} from Google News."""
    import news_sources
    from zoneinfo import ZoneInfo
    kyiv = ZoneInfo("Europe/Kyiv")
    seen, out = set(), {}
    for q in PRELIM_QUERIES:
        for a in news_sources.google_news(q, days=days):
            title = (a.get("title") or "").strip()
            if not title or title in seen or not a.get("published"):
                continue
            if blocklist.blocked_item(a):
                continue
            seen.add(title)
            pub = a["published"]
            if pub.tzinfo is None:
                pub = pub.replace(tzinfo=ZoneInfo("UTC"))
            out.setdefault(pub.astimezone(kyiv).date().isoformat(), []).append(a)
    return out


PRELIM_PROMPT = """Below are news headlines, grouped by the date they were published, about
Russia's overnight air attacks on Ukraine, some with the opening text of the
article. Each morning Ukraine's Air Force reports how many drones and
missiles Russia launched in the night, from where, and how many were shot
down; the news quotes it.

For each date listed, give the Air Force's figures for the night ending that
morning, ONLY if a headline or article text states them. Never estimate or
add up figures from different nights. Omit a date with no such figures.
The launch places are the areas the Air Force names ("from the directions of
Kursk, Oryol, Millerovo, Primorsko-Akhtarsk, Chauda ..."): give them, in
English, only when the text names them.

{blocks}

Respond as strict JSON:
{{"nights": [{{"date": "YYYY-MM-DD",
  "rows": [{{"kind": "drönare|kryssningsrobot|ballistisk robot",
            "model": "the weapon named, e.g. Shahed, Kh-101, Iskander-M, or empty",
            "launched": 0, "destroyed": 0}}],
  "launch_places": ["places launched from, if named"],
  "targets": ["Ukrainian regions or cities named as hit or targeted"],
  "refs": ["H1"]}}]}}"""


ARTICLE_TEXTS = 3          # articles a night whose opening text the model reads
ARTICLE_TEXT_CHARS = 900


def _article_text(link: str) -> str:
    """The opening text of a news article (Google News link decoded), or ''."""
    import news_sources
    try:
        url = news_sources.decode_google_link(link) if link else ""
        if not url or "news.google.com" in url:
            return ""
        item = news_sources.fetch_article({"url": url})
        return re.sub(r"\s+", " ", item.get("summary") or "").strip()[:ARTICLE_TEXT_CHARS]
    except Exception:
        return ""


def preliminary(kaggle_newest: str, previous: dict, today: date, with_today: bool = False) -> list:
    """Nights after the dataset's newest, up to yesterday (with_today: up to
    the night that ended this morning, for the 12:00 and 21:00 runs, when the
    Air Force's figures are out): kept from the previous run when already
    read, else read now in one light call."""
    start = date.fromisoformat(kaggle_newest) + timedelta(days=1) if kaggle_newest else today - timedelta(days=3)
    start = max(start, today - timedelta(days=PRELIM_MAX_NIGHTS))
    wanted = []
    d = start
    while d < today or (with_today and d == today):
        wanted.append(d.isoformat())
        d += timedelta(days=1)
    # A night read before Version 3.34 from headlines alone, without launch
    # places, is read once more with the articles' text (launch_tried).
    earlier = {x["date"]: x for x in (previous or {}).get("days", []) if x.get("preliminary") and x["date"] in wanted}
    kept = {d: x for d, x in earlier.items()
            if x.get("launch_tried") or any(r.get("from") for r in x.get("rows", []))}
    missing = [w for w in wanted if w not in kept]
    if not missing:
        return [kept[w] for w in wanted if w in kept]
    from common import lite_model, ask_model_json
    model = lite_model()
    if not model:
        print("  Strikes: no light model; nights after the dataset stay empty")
        return list({**earlier, **kept}.values())
    news = headlines(days=(today - date.fromisoformat(missing[0])).days + 2)
    refs, blocks = {}, []
    for w in missing:
        items = news.get(w, [])[:15]
        if not items:
            continue
        lines = [f"Date {w}:"]
        texts = 0
        for a in items:
            ref = f"H{len(refs) + 1}"
            refs[ref] = {"url": a.get("link"), "outlet": a.get("source")}
            lines.append(f"[{ref}] {a.get('source') or '?'}: {a['title']}")
            # The opening text of the first articles with figures in the
            # headline: the Air Force's launch areas are there, not in titles.
            if texts < ARTICLE_TEXTS and re.search(r"\d{2,}", a.get("title") or ""):
                body = _article_text(a.get("link"))
                if body:
                    lines.append(f"    text: {body}")
                    texts += 1
        blocks.append("\n".join(lines))
    if not blocks:
        print(f"  Strikes: no headlines for {', '.join(missing)}")
        return list({**earlier, **kept}.values())
    try:
        # The light model only: this must not take the reports' calls.
        result = ask_model_json(PRELIM_PROMPT.format(blocks="\n\n".join(blocks)), max_tokens=2500,
                                system="You extract figures from news headlines and article text. Strict JSON only.",
                                model=model, fallback=model)
    except Exception as e:
        print(f"  ! Strikes: preliminary nights failed ({str(e)[:160]})")
        return list({**earlier, **kept}.values())
    for n in (result.get("nights") or []) if isinstance(result, dict) else []:
        night = _prelim_night(n, missing, refs)
        if night:
            kept[night["date"]] = night
    # A night read again that gives nothing this time keeps what it had.
    for w, x in earlier.items():
        if w not in kept:
            kept[w] = {**x, "launch_tried": True}
    got = [w for w in wanted if w in kept]
    print(f"  Strikes: preliminary nights from headlines: {', '.join(got) or 'none'}")
    return [kept[w] for w in got]


def _prelim_night(n: dict, missing: list, refs: dict):
    if not isinstance(n, dict) or n.get("date") not in missing:
        return None
    launch, _ = places(", ".join(str(x) for x in n.get("launch_places") or [] if isinstance(x, str)), LAUNCH)
    target, _ = places(", ".join(str(x) for x in n.get("targets") or [] if isinstance(x, str)), TARGET)
    target = [t for t in target if t["name"].lower() != "ukraine"]
    rows, totals = [], {}
    for r in (n.get("rows") or [])[:10]:
        if not isinstance(r, dict):
            continue
        model = str(r.get("model") or "").strip()[:60]
        kind = r.get("kind") if r.get("kind") in KIND_NAMES else kind_of(model)
        launched, destroyed = _num(r.get("launched")), _num(r.get("destroyed"))
        if kind not in KIND_NAMES or not launched or not (0 < launched <= 2000):
            continue
        if destroyed is not None and not (0 <= destroyed <= launched):
            destroyed = None
        sys_ids = system_ids(model) or (["geran-2"] if kind == "drönare" else [])
        rows.append({"model": model or {"drönare": "Shahed-drönare"}.get(kind, kind), "kind": kind,
                     "launched": launched, "destroyed": destroyed, "carrier": None,
                     "launch_place": ", ".join(p["name"] for p in launch), "target": ", ".join(t["name"] for t in target),
                     "target_main": None, "unspecified": not target, "systems": sys_ids,
                     "hits": None, "fragments": None, "hidden": False,
                     "from": launch, "to": target, "time_start": "", "time_end": n["date"]})
        t = totals.setdefault(kind, {"launched": 0, "destroyed": 0})
        t["launched"] += launched
        t["destroyed"] += destroyed or 0
    if not rows:
        return None
    sources = [refs[r] for r in n.get("refs") or [] if isinstance(r, str) and r in refs and refs[r].get("url")][:4]
    if not sources:
        return None
    return {"date": n["date"], "rows": rows, "totals": totals, "preliminary": True, "sources": sources, "launch_tried": True}


def run(dry_run: bool = False, with_today: bool = False):
    rows = download()
    if rows is None:
        print("  Strikes: KAGGLE_USERNAME / KAGGLE_KEY not set; skipped")
        return
    if os.environ.get("STRIKES_DEBUG"):
        print("  Columns:", list(rows[0].keys()))
        for r in rows[:8]:
            print("  ROW", {k: v[:120] for k, v in r.items() if v})
        from collections import Counter as C
        print("  Targets:", C(r.get("target", "") for r in rows[:300]).most_common(15))
        print("  Affected:", C(r.get("affected region", "") for r in rows[:300]).most_common(15))
        print("  Models:", C(r.get("model", "") for r in rows[:600]).most_common(40))
    today = date.today()
    data = build(rows, today)
    previous = None
    if PATH.exists():
        try:
            previous = json.load(open(PATH, encoding="utf-8"))
        except ValueError:
            previous = None
    newest = data["days"][0]["date"] if data["days"] else None
    try:
        extra = preliminary(newest, previous, today, with_today=with_today)
    except Exception as e:
        print(f"  ! Strikes: preliminary nights failed ({type(e).__name__}: {e})")
        extra = []
    have = {d["date"] for d in data["days"]}
    data["days"] = sorted(data["days"] + [x for x in extra if x["date"] not in have],
                          key=lambda d: d["date"], reverse=True)
    print(f"  Strikes: {len(rows)} rows in the dataset, {len(data['days'])} nights in the last {DAYS} days"
          + (f", newest {data['days'][0]['date']}" if data["days"] else ""))
    if dry_run:
        print(json.dumps(data["days"][:2], ensure_ascii=False, indent=1)[:4000])
        return
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    from app_sync import push_strikes
    push_strikes(data)


def run_safe():
    try:
        run()
    except Exception as e:
        print(f"  ! Strikes failed ({type(e).__name__}: {e})")


def retry_if_due():
    """`strikes.py retry` (the 12:00 and 21:00 runs): fills the nights still
    missing up to this morning's (the morning run cannot: the Air Force
    reports later, and Google News sometimes refuses); otherwise nothing."""
    today = date.today()
    try:
        have = {d["date"] for d in json.load(open(PATH, encoding="utf-8")).get("days", [])}
    except (OSError, ValueError):
        have = set()
    gap = [today - timedelta(days=i) for i in range(0, 3)]
    if all(d.isoformat() in have for d in gap):
        return
    print("  Strikes: nights missing up to this morning; reading them again")
    run(with_today=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", choices=["retry"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--with-today", action="store_true")
    a = ap.parse_args()
    if a.cmd == "retry":
        retry_if_due()
    else:
        run(dry_run=a.dry_run, with_today=a.with_today)
