"""
Local stand-in for the Worker, for building and testing the web app
without Cloudflare. Serves webapp/public and a mock of the API in
CONTRACT.md from the real reports/*_report_data.json files. Where a report
predates the contract it fills in ids, articles, topics and countries by
simple keyword rules - good enough to exercise the UI, not real data.

    MOCK_ROLE=admin python3 webapp/dev/mock_server.py      # port 8787
    MOCK_ROLE=reader MOCK_PORT=8788 python3 webapp/dev/mock_server.py
    MOCK_AUTH=fail MOCK_PORT=8789 python3 webapp/dev/mock_server.py  # logged out
    MOCK_AUTH=denied MOCK_PORT=8790 python3 webapp/dev/mock_server.py  # verified but not a user

Version 2 (CONTRACT.md): users and roles, read marks, the live update
feed, security log, audit log and status. The signed-in user is
MOCK_EMAIL; MOCK_OWNER is the break-glass owner (default: the same
address when MOCK_ROLE=admin). Everything lives in memory.
"""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "webapp" / "public"
REPORTS = ROOT / "reports"
ROLE = os.environ.get("MOCK_ROLE", "admin")
EMAIL = os.environ.get("MOCK_EMAIL", "operator@example.test")
PORT = int(os.environ.get("MOCK_PORT", "8787"))
AUTH_FAIL = os.environ.get("MOCK_AUTH") == "fail"   # every /api call answers 401
AUTH_DENIED = os.environ.get("MOCK_AUTH") == "denied"  # every /api call answers 403 not_allowed
OWNER = os.environ.get("MOCK_OWNER", EMAIL if ROLE == "admin" else "owner@example.test")
ALARM = os.environ.get("MOCK_ALARM") == "1"         # today's report is missing
# A real P-256 public key (uncompressed, base64url) so the browser accepts
# the subscription; nothing is ever sent with it.
VAPID_PUBLIC = "BGtaPHvxosJ2B0_wo51rsv8waq1od-6bZIzGaQcW8sHo9QnG6akuEoh9ii-jHgb1036i5H2AWoqfZQVs9G1KOXo"
PUSH_SUBS = {}
NOTICES = []   # in-memory notices (Version 3.2)

TOPIC_RULES = {
    "Drönare": r"drone|drönar|uav|shahed|geran",
    "Sabotage": r"sabotage|arson|brand|gru|explosion",
    "IT-hot": r"cyber|hack|data cent|it-|ddos",
    "Skuggflotta": r"shadow.?fleet|skuggflott|tanker",
    "Sanktioner": r"sanction|graham|ofac|sria|tariff|decree",
    "Diplomati": r"talks|summit|diplomat|ceasefire|abu dhabi|g20|unga",
    "Arktis": r"arctic|greenland|grönland|svalbard",
    "Desinformation": r"denial|narrative|disinformation|propaganda|fabricat",
    "Kinetiskt": r"strike|missile|attack|killed|bomb",
}
COUNTRY_RULES = {
    "EE": r"estonia|tallinn|kapo|milrem", "LV": r"latvia", "LT": r"lithuania", "PL": r"poland|polish",
    "RO": r"romania", "MD": r"moldova", "UA": r"ukrain|kyiv|kharkiv|dnipro", "RU": r"russia|kremlin|putin|moscow",
    "DE": r"german|leipzig|munich", "SK": r"slovak", "DK": r"denmark|danish|ddis", "FI": r"finland",
    "SE": r"sweden|swedish", "NO": r"norway", "BY": r"belarus", "US": r"\bus\b|trump|washington|ofac",
    "GL": r"greenland", "AE": r"abu dhabi|uae", "IN": r"india",
}
TIER_HINT = [(r"reuters|\bap\b|associated press|afp|bbc|bloomberg|official|kapo|nato\.int|ministry", 1),
             (r"al jazeera|euronews|dw|nbc|pbs|defense news|breaking defense|guardian", 2),
             (r"kyiv|meduza|moscow times|ukrinform|censor|tvp|pravda", 3)]


def sha16(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def enrich(report):
    date = report["date"]
    for i, e in enumerate(report.get("events", []), start=1):
        e.setdefault("id", f"{date}-e{i}")
        text = f"{e.get('title', '')} {e.get('detail', '')}".lower()
        e.setdefault("topics", [t for t, rx in TOPIC_RULES.items() if re.search(rx, text)][:3])
        e.setdefault("countries", [c for c, rx in COUNTRY_RULES.items() if re.search(rx, text)][:4])
        e.setdefault("title_sv", e.get("title"))
        e.setdefault("model_score", e.get("score"))
        if "articles" not in e:
            outlets = []
            for part in re.split(r";", e.get("sources", "")):
                name = re.sub(r"\(.*", "", part).strip(" .")
                if name and len(name) < 60 and name not in outlets:
                    outlets.append(name)
            arts = []
            for j, name in enumerate(outlets[:5]):
                tier = next((t for rx, t in TIER_HINT if re.search(rx, name.lower())), 4)
                url = f"https://example.com/{sha16(date + name)}" if j % 2 == 0 else None
                arts.append({"id": sha16(url) if url else sha16(f"{date}|{i - 1}|{name}"),
                             "outlet": name, "title": None, "url": url, "tier": tier})
            e["articles"] = arts
    exec_path = REPORTS / f"{date}_executive_sv.json"
    if "executive_sv" not in report and exec_path.exists():
        report["executive_sv"] = json.loads(exec_path.read_text(encoding="utf-8"))
    return report


def load_reports():
    out = {}
    for path in sorted(REPORTS.glob("*_report_data.json")):
        r = enrich(json.loads(path.read_text(encoding="utf-8")))
        out[r["date"]] = r
    if out:
        # Give the latest report a sample operator trace so the UI has one to show.
        latest = out[max(out)]
        ev = latest["events"][0] if latest.get("events") else None
        if ev and ev["articles"]:
            a = ev["articles"][0]
            trace = [{"assessment_id": str(uuid.uuid4()), "article_id": a["id"], "outlet": a["outlet"],
                      "value": 2, "date": latest["date"], "weight": 0.8, "effect": 0.5}]
            ev["operator"] = {"delta": 0.5, "divergent": False, "trace": trace}
            latest["operator_influence"] = {"index_delta": 0.1, "trace": trace,
                                            "note_sv": "Operatörens bedömningar av två källor höjde indexet något."}
        # Version 3: yesterday's events re-checked, and a track record.
        dates = sorted(out)
        if len(dates) >= 2:
            prev = out[dates[-2]]
            outcomes = ["CONFIRMED", "CONFIRMED", "CONTRADICTED", "UNRESOLVED", "CONFIRMED", "CONFIRMED"]
            notes = {"CONFIRMED": "Senare rapportering från flera nyhetsbyråer stöder uppgiften.",
                     "CONTRADICTED": "Myndigheten gick senare ut och drog tillbaka uppgiften.",
                     "UNRESOLVED": "Ingen ny information sedan dess."}
            latest["self_check_results"] = [{"event_id": e["id"], "outcome": outcomes[i % 6], "note": notes[outcomes[i % 6]]}
                                            for i, e in enumerate(prev.get("events", []))]
        latest["operator_track_record"] = {
            EMAIL: {"evaluated": 9, "agreed": 7, "rate": 7 / 9},
            "johan@example.test": {"evaluated": 4, "agreed": 2, "rate": 0.5},
            "greger@example.test": {"evaluated": 0, "agreed": 0, "rate": None},
        }
    return out


REPORT_DATA = load_reports()
# The alarm is for the day after the newest report (as if it never came).
MISSING_DATE = (datetime.fromisoformat(max(REPORT_DATA)) + timedelta(days=1)).date().isoformat() if REPORT_DATA else None
ASSESSMENTS = []

THREADS = [
    ("baltic-nato-hybrid-provocation", "Hybridprovokationer i Baltikum och mot Nato", r"drone|airspace|romania|moldova|poland|baltic|estonia"),
    ("eu-hybrid-emergency-protocol-saceur", "GRU-sabotage i Europa", r"sabotage|arson|gru|milrem|protocol|saceur"),
    ("ukraine-russia-kinetic-escalation", "Kriget Ukraina–Ryssland", r"kyiv|kharkiv|strike|missile|ballistic"),
    ("diplomatic-track-ceasefire", "Diplomatiska spåret", r"talks|abu dhabi|ceasefire|g20|unga"),
    ("graham-act-shadow-fleet-ofac", "Graham Act och skuggflottan", r"graham|sria|ofac|shadow|decree|refinery"),
    ("us-denmark-greenland-arctic", "Grönland och Arktis", r"greenland|arctic"),
]


def assign_threads():
    for r in REPORT_DATA.values():
        for e in r.get("events", []):
            text = f"{e.get('title', '')} {e.get('detail', '')}".lower()
            e.setdefault("thread_id", next((tid for tid, _, rx in THREADS if re.search(rx, text)), None))
    if not REPORT_DATA:
        return
    # Rich v2 fields on the latest report only, so older reports exercise the fallback.
    latest = REPORT_DATA[max(REPORT_DATA)]
    for i, e in enumerate(latest.get("events", [])):
        e.setdefault("known_sv", [f"{e.get('title_sv') or e.get('title')} bekräftas av flera källor.", "Officiella uttalanden finns från berörda regeringar."])
        e.setdefault("unknown_sv", ["Vem som beställde operationen i sista led.", "Om fler anläggningar är utpekade."] if i % 2 == 0 else ["Hur Ryssland kommer att svara."])
        rels = ["bekräftar", "tillför", "motsäger", None]
        for j, a in enumerate(e.get("articles", [])):
            a.setdefault("summary_sv", f"{a.get('outlet')} rapporterar om händelsen och ger detaljer om tidslinjen och de inblandade aktörerna.")
            a.setdefault("published", latest["date"])
            a.setdefault("relation", rels[j % len(rels)])
            if not a.get("url") and j % 2 == 0:
                a["url"] = f"https://www.example.com/artikel/{sha16(latest['date'] + str(a.get('outlet')))}"


assign_threads()


def tiny_png(rgb, size=16):
    """A real 16x16 PNG: a colored square with a light inner block."""
    import struct, zlib, base64
    rows = b""
    for y in range(size):
        row = b"\x00"
        for x in range(size):
            inner = 4 <= x < 12 and 4 <= y < 12
            row += bytes((255, 255, 255) if inner else rgb)
        rows += row
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode()


def add_favicons():
    """Version 3.1: links on the two newest reports, favicons for most domains
    (every third domain left out so the monogram fallback shows too)."""
    from urllib.parse import urlsplit
    colors = [(200, 40, 40), (20, 90, 180), (230, 140, 20), (40, 140, 80), (110, 60, 160)]
    for date in sorted(REPORT_DATA)[-2:]:
        r = REPORT_DATA[date]
        for i, e in enumerate(r.get("events", [])):
            for j, a in enumerate(e.get("articles", [])):
                if not a.get("url") and (i + j) % 3 != 2:
                    slug = re.sub(r"[^a-z0-9]+", "", (a.get("outlet") or "kalla").lower())[:20] or "kalla"
                    a["url"] = f"https://www.{slug}.example/artikel/{sha16(date + str(a.get('outlet')))}"
                    a["id"] = sha16(a["url"])
    for date, r in REPORT_DATA.items():
        domains = sorted({urlsplit(a["url"]).hostname.removeprefix("www.")
                          for e in r.get("events", []) for a in e.get("articles", []) if a.get("url")})
        r["favicons"] = {d: tiny_png(colors[k % len(colors)]) for k, d in enumerate(domains) if k % 3 != 2}


add_favicons()


def ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat(timespec="seconds").replace("+00:00", "Z")


def make_updates():
    out = []
    specs = [(0.5, 1, "NEW_DEVELOPMENT", "Rumänien bekräftar nya drönardelar", "Försvarsministeriet bekräftar vrakdelar vid Brăila; ingen luftrumskränkning har deklarerats.", ["Ukrinform"]),
             (2, 0, "NEW_DEVELOPMENT", "Estland kallar upp rysk diplomat igen", "Utrikesministeriet begär förklaring om Milrem-branden efter KAPO:s slutsats.", ["ERR", "Reuters"]),
             (5, 2, "CORRECTION", "Dödssiffran i Kyiv justeras ned", "Stadens förvaltning rättar tidigare uppgift om antalet döda från fyra till tre.", ["Kyiv Independent"]),
             (9, 3, "NARRATIVE_SHIFT", "Nya signaler om samtal i Abu Dhabi", "Kreml säger att ett datum 'kan komma snart' men avvisar förhandsvillkor.", ["TASS", "Meduza"]),
             (30, 4, "NEW_DEVELOPMENT", "OFAC publicerar inga nya beteckningar", "Tysta dagar fortsätter inför tidsgränsen 18 oktober.", ["Morgan Lewis"]),
             (60, 5, "NEW_DEVELOPMENT", "Danska analytiker om ratificeringen", "Folketingets tidsplan för Grönlandsavtalet är fortfarande oklar.", ["CEPA"])]
    for hours, t, cls, title, summary, outlets in specs:
        tid, label, _ = THREADS[t]
        out.append({"id": f"u-{sha16(title)}", "ts": ago(hours=hours), "thread_id": tid, "thread_label": label,
                    "classification": cls, "title_sv": title, "summary_sv": summary, "outlets": outlets,
                    "report_date": max(REPORT_DATA) if REPORT_DATA else None})
    return out


UPDATES = make_updates()
READS = {}                 # email -> set of item ids
LAST_VISIT = ago(hours=20)
USERS = {}
for email, role in [(OWNER, "admin"), (EMAIL, ROLE), ("johan@example.test", "admin"), ("greger@example.test", "admin"),
                    ("daniel@example.test", "reader"), ("charlotte@example.test", "reader")]:
    USERS.setdefault(email, {"email": email, "role": role, "active": True, "created_at": ago(days=3),
                             "created_by": OWNER, "last_seen": None})
USERS["gammal@example.test"] = {"email": "gammal@example.test", "role": "reader", "active": False,
                                "created_at": ago(days=9), "created_by": OWNER, "last_seen": ago(days=6)}
USERS["johan@example.test"]["last_seen"] = ago(hours=3)
USERS["johan@example.test"].update({"installed_at": ago(hours=20), "platform": "ios"})
USERS["daniel@example.test"].update({"platform": "android"})
AUDIT = [{"id": str(uuid.uuid4()), "ts": ago(days=3), "actor": OWNER, "action": "add_user", "target": e,
          "detail": json.dumps({"role": u["role"]})} for e, u in USERS.items() if e != OWNER]
AUDIT.append({"id": str(uuid.uuid4()), "ts": ago(days=2), "actor": OWNER, "action": "deactivate", "target": "gammal@example.test", "detail": ""})
SECURITY = []
for i in range(24):
    SECURITY.append({"id": str(uuid.uuid4()), "ts": ago(minutes=20 + i * 37), "email": f"okand{i % 3}@example.org", "ip_country": "RU" if i % 2 else "NL",
                     "path": "/api/me", "method": "GET", "reason": "not_allowed", "detail": "e-post finns inte bland användarna"})
SECURITY += [
    {"id": str(uuid.uuid4()), "ts": ago(hours=5), "email": None, "ip_country": "US", "path": "/api/reports", "method": "GET", "reason": "invalid_jwt", "detail": "signaturen stämmer inte"},
    {"id": str(uuid.uuid4()), "ts": ago(days=2), "email": "daniel@example.test", "ip_country": "SE", "path": "/api/assessments", "method": "POST", "reason": "forbidden", "detail": "läsare får inte bedöma"},
    {"id": str(uuid.uuid4()), "ts": ago(days=3), "email": "johan@example.test", "ip_country": "SE", "path": "/api/assessments", "method": "POST", "reason": "bad_request", "detail": "value måste vara -2..2"},
    {"id": str(uuid.uuid4()), "ts": ago(days=4), "email": "johan@example.test", "ip_country": "SE", "path": "/api/reads", "method": "POST", "reason": "rate_limited", "detail": "121 anrop på en minut"},
]
MACHINE_PULL = ago(hours=26)
TOKEN_EXPIRES = ago(days=-21)


def user_of(email):
    u = USERS.get(email)
    if email == OWNER:
        return {"email": email, "role": "admin", "active": True}
    return u if u and u["active"] else None


def log_security(reason, path, method, detail=""):
    SECURITY.append({"id": str(uuid.uuid4()), "ts": now(), "email": EMAIL, "ip_country": "SE",
                     "path": path, "method": method, "reason": reason, "detail": detail})


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        try:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return None

    def _gate(self, path, method):
        """Common checks for every /api call. Returns an error response or None."""
        if AUTH_FAIL:
            return self._json(401, {"error": "not signed in"})
        if AUTH_DENIED or not user_of(EMAIL):
            return self._json(403, {"error": "not_allowed"})
        if method != "GET":
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"):
                log_security("bad_origin", path, method, origin)
                return self._json(403, {"error": "bad_origin"})
        if path.startswith("/api/admin/") and user_of(EMAIL)["role"] != "admin":
            log_security("forbidden", path, method, "bara administratörer")
            return self._json(403, {"error": "forbidden"})
        return None

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return super().do_GET()
        err = self._gate(path, "GET")
        if err is not None:
            return err
        me = user_of(EMAIL)
        if path == "/api/me":
            USERS.get(EMAIL, {})["last_seen"] = now()
            alarm = {"missing_report": MISSING_DATE if ALARM else None,
                     "checked_at": ago(minutes=12) if ALARM else None}
            return self._json(200, {"email": EMAIL, "role": me["role"], "is_owner": EMAIL == OWNER, "alarm": alarm})
        if path == "/api/push/key":
            return self._json(200, {"publicKey": VAPID_PUBLIC})
        if path == "/api/updates":
            return self._json(200, sorted(UPDATES, key=lambda u: u["ts"], reverse=True))
        if path == "/api/notices":
            live = [n for n in NOTICES if n["active"] and n["expires_at"] > now()]
            return self._json(200, sorted(live, key=lambda n: n["ts"], reverse=True))
        if path == "/api/reads":
            return self._json(200, {"item_ids": sorted(READS.get(EMAIL, set())), "last_visit": LAST_VISIT})
        if path == "/api/admin/users":
            rows = []
            for u in USERS.values():
                n = len([a for a in ASSESSMENTS if a["operator"] == u["email"]])
                rows.append({**u, "role": "admin" if u["email"] == OWNER else u["role"], "is_owner": u["email"] == OWNER, "assessments": n})
            return self._json(200, rows)
        if path == "/api/admin/security":
            cutoff7 = ago(days=7)
            rows = sorted([r for r in SECURITY if r["ts"] >= cutoff7], key=lambda r: r["ts"], reverse=True)[:200]
            counts = {"24h": {}, "7d": {}}
            for r in rows:
                counts["7d"][r["reason"]] = counts["7d"].get(r["reason"], 0) + 1
                if r["ts"] >= ago(hours=24):
                    counts["24h"][r["reason"]] = counts["24h"].get(r["reason"], 0) + 1
            return self._json(200, {"counts": counts, "rows": rows})
        if path == "/api/admin/audit":
            return self._json(200, sorted(AUDIT, key=lambda r: r["ts"], reverse=True))
        if path == "/api/admin/status":
            last = max(REPORT_DATA) if REPORT_DATA else None
            return self._json(200, {
                "last_report_date": last, "last_report_uploaded_at": f"{last}T03:05:00Z" if last else None,
                "last_update_at": max((u["ts"] for u in UPDATES), default=None), "last_machine_pull_at": MACHINE_PULL,
                "counts": {"reports": len(REPORT_DATA), "events": sum(len(r.get("events", [])) for r in REPORT_DATA.values()),
                           "assessments": len(ASSESSMENTS), "users": len([u for u in USERS.values() if u["active"]])},
                "service_token_expires": TOKEN_EXPIRES,
                "alarm": {"missing_report": MISSING_DATE if ALARM else None,
                          "checked_at": ago(minutes=12) if ALARM else None},
                "push_subscriptions": len(PUSH_SUBS),
                "push": {"subscriptions": len(PUSH_SUBS), "last": None}})
        if path == "/api/reports":
            rows = [{"date": d, "threat_index": r.get("threat_index"), "threat_index_30d": r.get("threat_index_30d"),
                     "top_sv": (r.get("executive_sv") or {}).get("top") or r.get("top_development")}
                    for d, r in sorted(REPORT_DATA.items(), reverse=True)]
            return self._json(200, rows)
        m = re.fullmatch(r"/api/reports/(\d{4}-\d{2}-\d{2})", path)
        if m:
            r = REPORT_DATA.get(m.group(1))
            return self._json(200, r) if r else self._json(404, {"error": "no such report"})
        if path == "/api/assessments":
            return self._json(200, ASSESSMENTS)
        return self._json(404, {"error": "not found"})

    def _admin_user_change(self, method, email, body):
        target = USERS.get(email)
        if not target:
            return self._json(404, {"error": "no such user"})
        if email == OWNER:
            return self._json(400, {"error": "ägaren kan inte ändras"})
        active_admins = [u for u in USERS.values() if u["active"] and (u["role"] == "admin" or u["email"] == OWNER)]
        demoting = method == "DELETE" or (body or {}).get("active") is False or (body or {}).get("role") == "reader"
        if demoting and target["role"] == "admin" and len(active_admins) <= 1:
            return self._json(400, {"error": "sista administratören"})
        if method == "DELETE" or (body or {}).get("active") is False:
            target["active"] = False
            AUDIT.append({"id": str(uuid.uuid4()), "ts": now(), "actor": EMAIL, "action": "deactivate", "target": email, "detail": ""})
        elif (body or {}).get("role") in ("admin", "reader"):
            old = target["role"]
            target["role"] = body["role"]
            AUDIT.append({"id": str(uuid.uuid4()), "ts": now(), "actor": EMAIL, "action": "role_change", "target": email,
                          "detail": json.dumps({"from": old, "to": body["role"]})})
        else:
            log_security("bad_request", self.path, method, "okänd ändring")
            return self._json(400, {"error": "role or active required"})
        return self._json(200, target)

    def do_PATCH(self):
        path = self.path.split("?")[0]
        err = self._gate(path, "PATCH")
        if err is not None:
            return err
        m = re.fullmatch(r"/api/admin/users/(.+)", path)
        if not m:
            return self._json(404, {"error": "not found"})
        from urllib.parse import unquote
        return self._admin_user_change("PATCH", unquote(m.group(1)).lower(), self._body())

    def do_DELETE(self):
        path = self.path.split("?")[0]
        err = self._gate(path, "DELETE")
        if err is not None:
            return err
        mn = re.fullmatch(r"/api/admin/notices/([0-9a-f-]{36})", path)
        if mn:
            n = next((x for x in NOTICES if x["id"] == mn.group(1)), None)
            if not n:
                return self._json(404, {"error": "no such notice"})
            n["active"] = False
            AUDIT.append({"id": str(uuid.uuid4()), "ts": now(), "actor": EMAIL, "action": "notice_removed", "target": n["id"], "detail": ""})
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/admin/users/(.+)", path)
        if not m:
            return self._json(404, {"error": "not found"})
        from urllib.parse import unquote
        return self._admin_user_change("DELETE", unquote(m.group(1)).lower(), None)

    def do_POST(self):
        path = self.path.split("?")[0]
        err = self._gate(path, "POST")
        if err is not None:
            return err
        if path == "/api/me/device":
            body = self._body() or {}
            if not isinstance(body.get("standalone"), bool) or body.get("platform") not in ("ios", "android", "desktop"):
                log_security("bad_request", path, "POST", "standalone/platform")
                return self._json(400, {"error": "standalone and platform required"})
            u = USERS.setdefault(EMAIL, {"email": EMAIL, "role": ROLE, "active": True, "created_at": now(), "created_by": "seed", "last_seen": now()})
            u["platform"] = body["platform"]
            if body["standalone"] and not u.get("installed_at"):
                u["installed_at"] = now()
            return self._json(200, {"ok": True, "installed_at": u.get("installed_at"), "platform": u["platform"]})
        if path == "/api/push/subscribe":
            body = self._body() or {}
            keys = body.get("keys") or {}
            if not str(body.get("endpoint", "")).startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
                log_security("bad_request", path, "POST", "ogiltig prenumeration")
                return self._json(400, {"error": "invalid subscription"})
            PUSH_SUBS[body["endpoint"]] = {"email": EMAIL, "created_at": now()}
            return self._json(201, {"ok": True})
        if path == "/api/push/unsubscribe":
            body = self._body() or {}
            PUSH_SUBS.pop(str(body.get("endpoint", "")), None)
            return self._json(200, {"ok": True})
        if path == "/api/reads":
            body = self._body() or {}
            ids = body.get("item_ids")
            mine = READS.setdefault(EMAIL, set())
            if isinstance(ids, list):
                mine.update(str(i) for i in ids[:500])
            elif body.get("all_before"):
                mine.update(e["id"] for r in REPORT_DATA.values() for e in r.get("events", []))
                mine.update(u["id"] for u in UPDATES if u["ts"] <= body["all_before"])
            else:
                log_security("bad_request", path, "POST", "item_ids eller all_before krävs")
                return self._json(400, {"error": "item_ids or all_before required"})
            return self._json(200, {"ok": True, "count": len(mine)})
        if path == "/api/admin/notices":
            body = self._body() or {}
            title, text = str(body.get("title") or "").strip(), str(body.get("body") or "").strip()
            url = body.get("url")
            days = body.get("expires_days", 7)
            if not (0 < len(title) <= 80) or not (0 < len(text) <= 500) or (url and not re.fullmatch(r"(#/|/(?!/))[\w\-./?#&=%~+]*", str(url))) \
                    or not isinstance(days, int) or not (1 <= days <= 30):
                log_security("bad_request", path, "POST", "ogiltigt meddelande")
                return self._json(400, {"error": "invalid notice"})
            from datetime import datetime, timedelta, timezone
            n = {"id": str(uuid.uuid4()), "ts": now(), "author": EMAIL, "title": title, "body": text, "url": url or None,
                 "active": True, "expires_at": (datetime.now(timezone.utc) + timedelta(days=days)).isoformat().replace("+00:00", "Z")}
            NOTICES.append(n)
            AUDIT.append({"id": str(uuid.uuid4()), "ts": now(), "actor": EMAIL, "action": "notice", "target": n["id"], "detail": json.dumps({"title": title})})
            pushed = len(PUSH_SUBS) if body.get("push") else 0
            return self._json(201, {"notice": n, "pushed": pushed, "failed": 0})
        if path == "/api/admin/users":
            body = self._body() or {}
            email = str(body.get("email", "")).strip().lower()
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or body.get("role") not in ("admin", "reader"):
                log_security("bad_request", path, "POST", "ogiltig e-post eller roll")
                return self._json(400, {"error": "ogiltig e-post eller roll"})
            u = USERS.get(email)
            if u:
                u.update({"active": True, "role": body["role"]})
                action = "reactivate"
            else:
                u = USERS[email] = {"email": email, "role": body["role"], "active": True, "created_at": now(), "created_by": EMAIL, "last_seen": None}
                action = "add_user"
            AUDIT.append({"id": str(uuid.uuid4()), "ts": now(), "actor": EMAIL, "action": action, "target": email, "detail": json.dumps({"role": body["role"]})})
            return self._json(201, u)
        if path != "/api/assessments":
            return self._json(404, {"error": "not found"})
        if user_of(EMAIL)["role"] != "admin":
            log_security("forbidden", path, "POST", "läsare får inte bedöma")
            return self._json(403, {"error": "forbidden"})
        body = self._body()
        if body is None:
            return self._json(400, {"error": "bad json"})
        if body.get("value") not in (-2, -1, 0, 1, 2) or not body.get("article_id") or not body.get("client_id"):
            return self._json(400, {"error": "invalid assessment"})
        for row in ASSESSMENTS:
            if row["client_id"] == body["client_id"]:
                return self._json(200, row)
        if body.get("supersedes") and not any(r["id"] == body["supersedes"] for r in ASSESSMENTS):
            return self._json(400, {"error": "supersedes unknown row"})
        row = {"id": str(uuid.uuid4()), "ts": now(), "operator": EMAIL,
               **{k: body.get(k) for k in ("article_id", "report_date", "event_id", "outlet", "value", "supersedes", "client_id")}}
        ASSESSMENTS.append(row)
        return self._json(201, row)


if __name__ == "__main__":
    print(f"mock API + app on http://localhost:{PORT} (role {ROLE}, {len(REPORT_DATA)} reports)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
