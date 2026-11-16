"""
Version 3.43: read the app as a guest (no login), to see that guests reach
it and are counted. Prints the status of a few public paths; the visit is
counted on Status like any guest's (one a day, delete it in D1 if it
matters).

    python3 src/guest_check.py
"""
import json
import os
import urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) HM-guest-check"   # not "monitor": the Worker skips that as a bot


def main():
    url = (os.environ.get("HOTMONITOR_URL") or "").rstrip("/")
    if not url:
        print("  HOTMONITOR_URL not set")
        return
    for path in ("/api/me", "/api/reports", "/api/strikes"):
        req = urllib.request.Request(url + path, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                kind = r.headers.get("content-type", "")
                try:
                    data = json.loads(body)
                    what = f"{len(data)} items" if isinstance(data, list) else f"keys {list(data)[:4]}" if isinstance(data, dict) else type(data).__name__
                except ValueError:
                    what = f"not JSON ({kind}, {len(body)} bytes)"
                print(f"  {path}: {r.status} {what} (final url {r.geturl().split('?')[0]})")
        except urllib.error.HTTPError as e:
            print(f"  {path}: HTTP {e.code} {e.read()[:120]!r}")
        except Exception as e:
            print(f"  {path}: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
