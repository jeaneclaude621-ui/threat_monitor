"""
Sync between the Mac and the web app (Cloudflare Worker + D1):
- pull the operator's new assessments into data/operator_assessments.jsonl
  before a run, so the analysis and the local backup both have them;
- push a finished report so the app can show it.

Authenticates as the Mac's Cloudflare Access service token. Env:
    HOTMONITOR_URL            e.g. https://hotmonitor.<name>.workers.dev
    CF_ACCESS_CLIENT_ID       service token id
    CF_ACCESS_CLIENT_SECRET   service token secret

    python3 src/app_sync.py pull
    python3 src/app_sync.py push 2026-09-30     # one report
    python3 src/app_sync.py push-all            # every report in reports/

Never raises - the app being unreachable must not stop the daily report.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUTPUT_DIR, NETWORK_RETRY_DELAYS
from operator_weight import ASSESSMENTS_PATH, load_rows


def _config():
    url = (os.environ.get("HOTMONITOR_URL") or "").rstrip("/")
    cid = os.environ.get("CF_ACCESS_CLIENT_ID")
    secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    return (url, cid, secret) if url and cid and secret else None


def _request(method: str, path: str, body=None, retries=True):
    url, cid, secret = _config()
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method, headers={
        "CF-Access-Client-Id": cid,
        "CF-Access-Client-Secret": secret,
        "Content-Type": "application/json",
        "User-Agent": "hotmonitor-mac/1",
    })
    delays = (NETWORK_RETRY_DELAYS if retries else []) + [None]
    for delay in delays:
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # The server answered - waiting won't change a 4xx.
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read()[:200]!r}") from e
        except (urllib.error.URLError, OSError) as e:
            if delay is None:
                raise RuntimeError(f"{method} {path}: {e}") from e
            print(f"  ! Web app unreachable ({e}); retrying in {delay}s")
            time.sleep(delay)


def pull_assessments() -> int:
    """Appends rows not yet in the local file. Returns how many."""
    if not _config():
        print("  App sync skipped - HOTMONITOR_URL / CF_ACCESS_CLIENT_* not set")
        return 0
    try:
        local = load_rows()
        known = {r["id"] for r in local}
        # A minute back from the newest local row: two rows can share a
        # timestamp at the boundary, and duplicates are dropped by id below.
        newest = max((r.get("ts", "") for r in local), default="")
        since = ""
        if newest:
            since = (datetime.fromisoformat(newest.replace("Z", "+00:00"))
                     - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        rows = _request("GET", "/api/export/assessments?since=" + urllib.request.quote(since))
        new = [r for r in rows if r.get("id") not in known]
        if new:
            with open(ASSESSMENTS_PATH, "a", encoding="utf-8") as f:
                for r in new:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"  Operator assessments: {len(new)} new ({len(local) + len(new)} total)")
        return len(new)
    except Exception as e:
        print(f"  ! Operator assessment pull failed: {e}")
        return 0


def push_report(report_data: dict) -> bool:
    if not _config():
        print("  App upload skipped - HOTMONITOR_URL / CF_ACCESS_CLIENT_* not set")
        return False
    try:
        _request("PUT", f"/api/ingest/reports/{report_data['date']}", report_data)
        print(f"  Uploaded to web app: {report_data['date']}")
        return True
    except Exception as e:
        print(f"  ! Web app upload failed: {e}")
        return False


def backup_app(keep: int = 30) -> bool:
    """The app's own data (users, audit and security logs, reads, live
    updates) saved on the Mac daily - assessments are already pulled into
    data/operator_assessments.jsonl. Keeps the newest `keep` files."""
    if not _config():
        return False
    from datetime import date
    backup_dir = ASSESSMENTS_PATH.parent / "backups"
    try:
        data = _request("GET", "/api/export/all")
        backup_dir.mkdir(exist_ok=True)
        path = backup_dir / f"app-{date.today().isoformat()}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        for old in sorted(backup_dir.glob("app-*.json"))[:-keep]:
            old.unlink()
        print(f"  App backup: {path.name}")
        return True
    except Exception as e:
        print(f"  ! App backup failed: {e}")
        return False


def push_updates(entries: list) -> bool:
    """Hourly thread updates for the app's live feed, per CONTRACT.md v2."""
    if not entries:
        return True
    if not _config():
        return False
    import hashlib
    from datetime import timezone
    rows = []
    for e in entries:
        # A naive datetime is local time; astimezone() reads it as such.
        ts = e["when"].astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        rows.append({
            "id": hashlib.sha1(f"{e['thread_id']}|{ts}".encode()).hexdigest()[:16],
            "ts": ts, "thread_id": e["thread_id"], "thread_label": e["thread_label"],
            "classification": e["classification"],
            "title_sv": e.get("title_sv") or e["thread_label"],
            "summary_sv": e.get("summary_sv") or e.get("summary", ""),
            "outlets": e.get("outlets", [])[:5],
            "report_date": None,
        })
    try:
        _request("PUT", "/api/ingest/updates", rows)
        print(f"  Uploaded {len(rows)} live update(s) to web app")
        return True
    except Exception as e:
        print(f"  ! Live update upload failed: {e}")
        return False


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if cmd == "pull":
        pull_assessments()
    elif cmd == "push" and len(sys.argv) > 2:
        push_report(json.load(open(OUTPUT_DIR / f"{sys.argv[2]}_report_data.json", encoding="utf-8")))
    elif cmd == "backup":
        backup_app()
    elif cmd == "push-all":
        for f in sorted(OUTPUT_DIR.glob("*_report_data.json")):
            push_report(json.load(open(f, encoding="utf-8")))
    else:
        print(__doc__)
