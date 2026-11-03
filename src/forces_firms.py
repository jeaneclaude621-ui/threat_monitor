"""
Satellite confirmation of attacks on bases: NASA FIRMS fire detections.

For each attack on a base in the last ATTACK_DAYS days that has not been
checked, ask FIRMS's area API (VIIRS, near real time) for fire detections
within RADIUS_KM of the base in the WINDOW_DAYS after the attack. A hit
marks the event with firms: {date, count, confidence}, and the app shows
"brand sedd av satellit (NASA FIRMS)". No model calls.

Needs FIRMS_MAP_KEY (a free key from NASA FIRMS, set as a repository
secret by the owner). Without it the module logs a line and does nothing.

    python3 src/forces_firms.py --dry-run    # which attacks would be checked
"""
import csv
import io
import math
import os
import sys
import urllib.request
from datetime import date, timedelta

API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{area}/{days}/{date}"
SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
ATTACK_DAYS = 3
WINDOW_DAYS = 2          # the attack day and the next: 48 hours
RADIUS_KM = 3.0
MAX_CHECKS = 20          # requests are cheap, but stay polite
UA = "threat-monitor/1 (https://github.com/jeaneclaude621-ui/threat_monitor)"
CONFIDENCE = {"l": "låg", "n": "normal", "h": "hög", "low": "låg", "nominal": "normal", "high": "hög"}


def km(lat1, lon1, lat2, lon2) -> float:
    la1, la2 = math.radians(lat1), math.radians(lat2)
    d = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(d))


def area(lat: float, lon: float, radius_km: float = RADIUS_KM) -> str:
    """west,south,east,north around the point, a little wider than the radius."""
    dlat = radius_km / 111.0 * 1.2
    dlon = dlat / max(math.cos(math.radians(lat)), 0.1)
    return f"{lon - dlon:.4f},{lat - dlat:.4f},{lon + dlon:.4f},{lat + dlat:.4f}"


def parse(text: str) -> list:
    """FIRMS CSV rows as dicts; an error message (not CSV) gives []."""
    if not text or not text.lstrip().startswith("latitude"):
        return []
    return list(csv.DictReader(io.StringIO(text)))


def match(rows: list, lat: float, lon: float, start: date) -> dict:
    """{date, count, confidence} for the detections within RADIUS_KM of the
    base on the attack day or the WINDOW_DAYS - 1 days after, else None."""
    end = start + timedelta(days=WINDOW_DAYS - 1)
    hits, seen = [], set()
    for r in rows:
        k = (r.get("latitude"), r.get("longitude"), r.get("acq_date"), r.get("acq_time"))
        if k in seen:
            continue
        seen.add(k)
        try:
            d = date.fromisoformat(r["acq_date"])
            dist = km(lat, lon, float(r["latitude"]), float(r["longitude"]))
        except (KeyError, ValueError):
            continue
        if start <= d <= end and dist <= RADIUS_KM:
            hits.append((d, CONFIDENCE.get(str(r.get("confidence", "")).strip().lower(), str(r.get("confidence", "")))))
    if not hits:
        return None
    order = ["låg", "normal", "hög"]
    best = max((c for _, c in hits), key=lambda c: order.index(c) if c in order else -1)
    return {"date": min(d for d, _ in hits).isoformat(), "count": len(hits), "confidence": best}


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def pending(state: dict, today: date) -> list:
    """(base, event) for the recent attacks that have not been checked."""
    since = (today - timedelta(days=ATTACK_DAYS)).isoformat()
    out = []
    for b in state.get("bases", []):
        for e in b.get("events", []):
            if e.get("kind") == "anfallen" and e.get("date", "") >= since and "firms" not in e:
                out.append((b, e))
    return out[:MAX_CHECKS]


def run(state: dict, today: date = None, key: str = None, get=None, dry_run: bool = False) -> int:
    """Checks the recent attacks; returns how many FIRMS confirmed."""
    today = today or date.today()
    key = key if key is not None else os.environ.get("FIRMS_MAP_KEY", "")
    todo = pending(state, today)
    if not key:
        print(f"  FIRMS: FIRMS_MAP_KEY not set; {len(todo)} recent attacks not checked")
        return 0
    get = get or _get
    found = 0
    for b, e in todo:
        start = date.fromisoformat(e["date"][:10])
        if dry_run:
            print(f"  FIRMS: would check {b.get('name')} {e['date']}")
            continue
        rows = []
        for source in SOURCES:
            url = API.format(key=key, source=source, area=area(b["lat"], b["lon"]), days=WINDOW_DAYS, date=start.isoformat())
            try:
                rows += parse(get(url))
            except Exception as ex:
                print(f"  ! FIRMS {source}: {type(ex).__name__}")
        hit = match(rows, b["lat"], b["lon"], start)
        # A check is final once the whole window is in the past; until then
        # a miss is checked again the next night.
        if hit:
            e["firms"] = hit
            found += 1
        elif start + timedelta(days=WINDOW_DAYS) <= today:
            e["firms"] = None
    print(f"  FIRMS: {len(todo)} recent attacks checked, {found} with fire seen by satellite")
    return found


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    import forces
    st = forces.load()
    run(st, dry_run="--dry-run" in sys.argv)
