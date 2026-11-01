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

No model call. Run by daily_report.py after the forces map, or alone:

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
    "soltsy": (58.14, 30.33), "belarus": (53.7, 27.9), "kaliningrad": (54.7, 20.5),
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
    "centre": (49.0, 32.0),
}
KINDS = [("drönare", re.compile(r"shahed|geran|gerbera|uav|drone|lancet|italmas|parody|гербера", re.I)),
         ("ballistisk robot", re.compile(r"iskander-m|kn-23|kinzhal|x-47|kh-47|ballistic|s-300|s-400|tochka|oreshnik", re.I)),
         ("kryssningsrobot", re.compile(r"x-\d|kh-\d|kalibr|iskander-k|onyx|oniks|cruise|zircon|tsirkon|p-800", re.I))]


def kind_of(model: str) -> str:
    return next((k for k, rx in KINDS if rx.search(model or "")), "övrigt")


def places(text: str, table: dict) -> tuple:
    """([{name, lat, lon}], [unknown names]) from "A and B, C"."""
    found, unknown = [], []
    for part in re.split(r"\s+and\s+|,|;|/", text or ""):
        name = part.strip().lower().replace("’", "'")
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
        target, u2 = places(r.get("target"), TARGET)
        unknown.update(u1 + u2)
        model = (r.get("model") or "").strip()
        nights.setdefault(end, []).append({
            "model": model[:120], "kind": kind_of(model), "launched": _num(r.get("launched")),
            "destroyed": _num(r.get("destroyed")), "carrier": (r.get("carrier") or "").strip()[:120] or None,
            "launch_place": (r.get("launch_place") or "").strip()[:300], "target": (r.get("target") or "").strip()[:300],
            "from": launch, "to": target, "time_start": (r.get("time_start") or "")[:16], "time_end": (r.get("time_end") or "")[:16]})
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


def run(dry_run: bool = False):
    rows = download()
    if rows is None:
        print("  Strikes: KAGGLE_USERNAME / KAGGLE_KEY not set; skipped")
        return
    data = build(rows, date.today())
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


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    run(dry_run=ap.parse_args().dry_run)
