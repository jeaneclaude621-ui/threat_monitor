"""
ACLED in the incident log (Version 3.49).

ACLED (Armed Conflict Location & Event Data, acleddata.com) codes political
violence and strategic developments by hand from news and local partners.
For Europe outside Russia, Belarus and Ukraine its events of the kinds the
log holds - explosions and remote violence, attacks, strategic developments
such as drone sightings, arrests and property destruction - are read, kept
only when their text names sabotage, drones, espionage, cables, GPS
jamming, arson or Russia, and added to data/incidents.json with
origin "acled".

Access: OAuth with the account's e-mail and password (ACLED_EMAIL and
ACLED_PASSWORD, GitHub secrets - never in the repository). A token lasts
24 hours. The account's tier decides what comes back: the free Open tier
has no event rows, Research has them with a 12-month delay. When nothing
comes back the state says so and the job ends quietly.

ACLED's terms: the data may be used and shown with attribution, but not
passed on as a dataset. So the log keeps only what the app needs (date,
place, kind, ACLED's event id and the outlets it rests on) - no ACLED
notes text - and the app names ACLED as the source.

    python3 src/acled.py run                 # the last 60 days (the daily job)
    python3 src/acled.py backfill [FROM]     # from FROM (default 2022-01-01) to today, once
    python3 src/acled.py check               # sign-in and tier only
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import incidents
from common import DATA_DIR

TOKEN_URL = "https://acleddata.com/oauth/token"
READ_URL = "https://acleddata.com/api/acled/read"
STATE = DATA_DIR / "acled.json"
UA = "threat-monitor/1.0 (ACLED API client)"
PAGE = 5000
TIMEOUT = 90

# ISO 3166 numeric codes for the log's European countries, without Russia,
# Belarus and Ukraine (Ukraine's war would drown the rest; the strike map
# covers it).
ISO_NUM = {
    "NO": 578, "SE": 752, "FI": 246, "DK": 208, "EE": 233, "LV": 428, "LT": 440, "PL": 616, "DE": 276,
    "SK": 703, "RO": 642, "MD": 498, "GB": 826, "FR": 250, "BE": 56, "NL": 528, "IS": 352, "BG": 100,
    "HU": 348, "CZ": 203, "AT": 40, "IT": 380, "ES": 724, "GR": 300, "PT": 620, "IE": 372, "CH": 756,
    "HR": 191, "RS": 688, "SI": 705, "BA": 70, "ME": 499, "MK": 807, "AL": 8, "LU": 442, "CY": 196,
    "MT": 470, "XK": 0, "GE": 268, "AM": 51, "AZ": 31, "TR": 792,
}
NUM_ISO = {v: k for k, v in ISO_NUM.items() if v}

EVENT_TYPES = ("Explosions/Remote violence", "Strategic developments", "Violence against civilians")

# What makes an event subversive in the log's sense. Gang bombings, police
# raids and political arrests without these words are left out.
TOPIC = re.compile(r"sabotag|arson|drone|uav|unmanned|airspace|balloon|spy|espionage|intelligence service|"
                   r"cable|pipeline|undersea|subsea|jamming|gps|gnss|spoof|railway sabotage|"
                   r"russia|kremlin|wagner|gru\b|fsb\b|svr\b|hybrid", re.I)
RUSSIA = re.compile(r"russia|kremlin|wagner|\bgru\b|\bfsb\b|\bsvr\b", re.I)

SUB_SV = {
    "Remote explosive/landmine/IED": "Sprängladdning",
    "Air/drone strike": "Drönar- eller luftangrepp",
    "Grenade": "Granatattack",
    "Shelling/artillery/missile attack": "Beskjutning",
    "Suicide bomb": "Självmordsattack",
    "Attack": "Angrepp",
    "Abduction/forced disappearance": "Bortförande",
    "Arrests": "Gripande",
    "Looting/property destruction": "Skadegörelse",
    "Disrupted weapons use": "Avvärjt vapen",
    "Agreement": "Överenskommelse",
    "Headquarters or base established": "Ny bas",
    "Non-violent transfer of territory": "Överlämnat område",
    "Change to group/activity": "Förändrad verksamhet",
    "Other": "Händelse",
}


def category(text: str, sub: str) -> str:
    """The log's kind for an ACLED event, from its text and sub-event."""
    t = text.lower()
    if re.search(r"drone|uav|unmanned|airspace|balloon", t) or sub == "Air/drone strike":
        return "dronare"
    if re.search(r"jamming|gps|gnss|spoof", t):
        return "gps"
    if re.search(r"cable|pipeline|undersea|subsea|power line|substation|railway|rail line", t):
        return "kabel"
    if sub == "Arrests" or re.search(r"\bspy|espionage|intelligence service", t):
        return "spionage"
    if re.search(r"arson|sabotag|explosive|fire|set alight|burn", t) or sub in ("Remote explosive/landmine/IED", "Looting/property destruction"):
        return "sabotage"
    if re.search(r"graffiti|coffin|stunt|leaflet", t):
        return "paverkan"
    return "hot"


def to_incident(ev: dict) -> dict:
    """One ACLED event as a log incident, or None when it is not one."""
    if ev.get("event_type") not in EVENT_TYPES:
        return None
    text = " ".join(str(ev.get(k) or "") for k in ("notes", "tags", "actor1", "actor2", "assoc_actor_1"))
    if not TOPIC.search(text):
        return None
    try:
        iso = NUM_ISO.get(int(ev.get("iso") or 0))
        lat, lon = float(ev["latitude"]), float(ev["longitude"])
        d = str(ev["event_date"])[:10]
        date.fromisoformat(d)
    except (KeyError, TypeError, ValueError):
        return None
    if not iso or iso in incidents.EXCLUDED or iso == "UA":
        return None
    sub = str(ev.get("sub_event_type") or "")
    cat = category(text, sub)
    place = str(ev.get("location") or "").strip()[:80] or None
    outlets = str(ev.get("source") or "").strip()[:160]
    prec = {"1": "ort", "2": "ort", "3": "land"}.get(str(ev.get("geo_precision") or "3"), "land")
    out = {
        "date": d, "cat": cat, "country": iso, "place": place, "place_named": place,
        "lat": round(lat, 3), "lon": round(lon, 3), "precision": prec, "geo": "acled",
        "title_sv": f"{SUB_SV.get(sub, 'Händelse')}: {incidents.CATS[cat].lower()}" + (f" i {place}" if place else ""),
        "summary_sv": "",
        "attribution": "misstänkt" if RUSSIA.search(text) else "oklar",
        "sources": [{"outlet": "ACLED" + (f" (efter {outlets})" if outlets else ""),
                     "title": f"ACLED {ev.get('event_id_cnty') or ''}".strip(), "url": "https://acleddata.com/"}],
        "origin": "acled", "acled_id": str(ev.get("event_id_cnty") or "")[:40],
    }
    out["id"] = "a" + incidents._id(out)[1:]
    return out


# --------------------------------------------------------------------------
# The API
# --------------------------------------------------------------------------
def credentials():
    e, p = os.environ.get("ACLED_EMAIL"), os.environ.get("ACLED_PASSWORD")
    return (e, p) if e and p else None


def token(creds) -> str:
    body = urllib.parse.urlencode({"username": creds[0], "password": creds[1],
                                   "grant_type": "password", "client_id": "acled"}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())["access_token"]


def read(tok: str, since: str, until: str, get=None) -> list:
    """Every event of EVENT_TYPES in the countries between since and until, page by page."""
    rows, page = [], 1
    iso = "|".join(str(v) for v in ISO_NUM.values() if v)
    while True:
        q = {"_format": "json", "iso": iso, "event_type": "|".join(EVENT_TYPES),
             "event_date": f"{since}|{until}", "event_date_where": "BETWEEN",
             "fields": "event_id_cnty|event_date|event_type|sub_event_type|actor1|actor2|assoc_actor_1|"
                       "iso|country|location|latitude|longitude|geo_precision|source|notes|tags",
             "limit": PAGE, "page": page}
        url = READ_URL + "?" + urllib.parse.urlencode(q)
        if get:
            data = get(url)
        else:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = json.loads(r.read())
        batch = data.get("data") or [] if isinstance(data, dict) else []
        rows += batch
        if len(batch) < PAGE:
            return rows
        page += 1


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"runs": []}


def save_state(st: dict):
    st["runs"] = st.get("runs", [])[-60:]
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")


def fetch(since: str, until: str, label: str, get=None, tok=None) -> dict:
    """Reads ACLED between since and until and merges the events into the
    incident log. Returns the run's record (also kept in data/acled.json)."""
    st = load_state()
    rec = {"at": datetime.now().isoformat(timespec="minutes"), "job": label, "since": since, "until": until}
    creds = credentials()
    if not get and not creds:
        rec["status"] = "no_credentials"
        print("  ACLED: ACLED_EMAIL and ACLED_PASSWORD are not set - skipped")
        return rec
    try:
        tok = tok or (None if get else token(creds))
        rows = read(tok, since, until, get=get)
    except urllib.error.HTTPError as e:
        rec["status"] = "no_access" if e.code in (401, 403) else f"http_{e.code}"
        print(f"  ! ACLED: {e.code} - {'the account tier gives no event data' if e.code == 403 else 'sign-in failed' if e.code == 401 else 'failed'}")
        st.setdefault("runs", []).append(rec); st["status"] = rec["status"]; save_state(st)
        return rec
    except Exception as e:
        rec["status"] = f"failed: {type(e).__name__}"
        print(f"  ! ACLED failed: {type(e).__name__}: {str(e)[:160]}")
        st.setdefault("runs", []).append(rec); st["status"] = rec["status"]; save_state(st)
        return rec
    new = [i for i in (to_incident(r) for r in rows) if i]
    log = incidents.load()
    incidents.seed_history(log)
    have = {i.get("acled_id") for i in log["incidents"] if i.get("acled_id")}
    new = [i for i in new if i["acled_id"] not in have]
    added, merged = incidents.merge(log, new)
    log.setdefault("runs", []).append({"at": rec["at"], "origin": "acled", "proposed": len(new),
                                       "added": added, "merged": merged})
    incidents.save(log)
    newest = max((str(r.get("event_date"))[:10] for r in rows), default=None)
    rec.update({"status": "ok" if rows else "empty", "rows": len(rows), "kept": len(new),
                "added": added, "merged": merged, "newest": newest})
    if newest:
        st["newest"] = max(st.get("newest") or "", newest)
    st["status"] = rec["status"]
    st.setdefault("runs", []).append(rec)
    save_state(st)
    lag = (date.today() - date.fromisoformat(newest)).days if newest else None
    print(f"  ACLED: {len(rows)} events {since}..{until}, {len(new)} subversive, {added} added, {merged} merged"
          + (f", newest {newest} ({lag} days ago)" if newest else " - none came back (Open tier has no event rows)"))
    if rows or merged or added:
        incidents.push(log)
    return rec


def run(days: int = 60) -> dict:
    today = date.today()
    return fetch((today - timedelta(days=days)).isoformat(), today.isoformat(), "acled")


def run_safe():
    try:
        return run()
    except Exception as e:
        print(f"  ! ACLED skipped: {type(e).__name__}: {str(e)[:160]}")


def backfill(since: str = "2022-01-01") -> list:
    """Year by year from `since`: a single load of the history."""
    out, y = [], date.fromisoformat(since)
    while y <= date.today():
        end = min(date(y.year, 12, 31), date.today())
        rec = fetch(y.isoformat(), end.isoformat(), "acled_backfill")
        out.append(rec)
        if rec.get("status") not in ("ok", "empty"):
            break
        y = date(y.year + 1, 1, 1)
    return out


def check() -> dict:
    creds = credentials()
    if not creds:
        print("ACLED: no credentials (ACLED_EMAIL / ACLED_PASSWORD)")
        return {"status": "no_credentials"}
    try:
        tok = token(creds)
    except Exception as e:
        print(f"ACLED: sign-in failed ({type(e).__name__}: {str(e)[:120]})")
        return {"status": "sign_in_failed"}
    today = date.today()
    out = {}
    for label, since in (("senaste 30 dagar", today - timedelta(days=30)), ("för 13 månader sedan", today - timedelta(days=400))):
        try:
            rows = read(tok, since.isoformat(), (since + timedelta(days=30)).isoformat())
            out[label] = len(rows)
        except urllib.error.HTTPError as e:
            out[label] = f"HTTP {e.code}"
    # The bare minimum, and ACLED's own message, so a 403 can be told apart
    # from a query the API dislikes. The message names the tier, not data.
    for label, url in (("minimal", READ_URL + "?_format=json&limit=1"),
                       ("aggregated", "https://acleddata.com/api/acled/read?_format=json&limit=1&country=Poland")):
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = json.loads(r.read())
            out[label] = f"ok, {len(body.get('data') or [])} rows"
        except urllib.error.HTTPError as e:
            out[label] = f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}"
    print(f"ACLED: signed in; events {out}")
    return {"status": "ok", "events": out}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "run":
        run()
    elif cmd == "backfill":
        backfill(*(sys.argv[2:3]))
    else:
        check()
