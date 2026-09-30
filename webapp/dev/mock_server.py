"""
Local stand-in for the Worker, for building and testing the web app
without Cloudflare. Serves webapp/public and a mock of the API in
CONTRACT.md from the real reports/*_report_data.json files. Where a report
predates the contract it fills in ids, articles, topics and countries by
simple keyword rules - good enough to exercise the UI, not real data.

    MOCK_ROLE=admin python3 webapp/dev/mock_server.py      # port 8787
    MOCK_ROLE=reader MOCK_PORT=8788 python3 webapp/dev/mock_server.py
    MOCK_AUTH=fail MOCK_PORT=8789 python3 webapp/dev/mock_server.py  # logged out

Assessments live in memory and vanish on restart.
"""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "webapp" / "public"
REPORTS = ROOT / "reports"
ROLE = os.environ.get("MOCK_ROLE", "admin")
EMAIL = os.environ.get("MOCK_EMAIL", "operator@example.test")
PORT = int(os.environ.get("MOCK_PORT", "8787"))
AUTH_FAIL = os.environ.get("MOCK_AUTH") == "fail"   # every /api call answers 401

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
    return out


REPORT_DATA = load_reports()
ASSESSMENTS = []


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

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return super().do_GET()
        if AUTH_FAIL:
            return self._json(401, {"error": "not signed in"})
        if path == "/api/me":
            return self._json(200, {"email": EMAIL, "role": ROLE})
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

    def do_POST(self):
        if self.path.split("?")[0] != "/api/assessments":
            return self._json(404, {"error": "not found"})
        if ROLE != "admin":
            return self._json(403, {"error": "admins only"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
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
