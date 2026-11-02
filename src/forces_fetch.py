"""
Polite cached fetching for the forces database research scripts.

    from forces_fetch import get, get_json
    get_json("https://en.wikipedia.org/w/api.php", params={...})

Honours 429 Retry-After with backoff, waits a minimum interval per host,
names the repo in the User-Agent, and caches answers on disk
(FORCES_CACHE, default .cache/forces_fetch) so a rerun reads nothing twice.
"""
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "threat_monitor-forces-db/1.0 (https://github.com/jeaneclaude621-ui/threat_monitor)"
CACHE = Path(os.environ.get("FORCES_CACHE", Path(__file__).resolve().parent.parent / ".cache" / "forces_fetch"))
INTERVAL = {"militaryland.net": 4.0}
_last = {}


def _key(url, data):
    return hashlib.sha1((url + "\0" + (data or "")).encode()).hexdigest()


def get(url, params=None, data=None, binary=False, tries=8, timeout=60):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    f = CACHE / (_key(url, data) + (".bin" if binary else ".txt"))
    if f.exists():
        return f.read_bytes() if binary else f.read_text(encoding="utf-8")
    host = urllib.parse.urlparse(url).hostname
    wait = 3.0
    for i in range(tries):
        gap = INTERVAL.get(host, 0.6) - (time.time() - _last.get(host, 0))
        if gap > 0:
            time.sleep(gap)
        _last[host] = time.time()
        req = urllib.request.Request(url, data=data.encode() if data else None, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            CACHE.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            return body if binary else body.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            if e.code in (429, 500, 502, 503, 504) and i < tries - 1:
                ra = e.headers.get("Retry-After")
                time.sleep(max(float(ra) if ra and ra.isdigit() else 0, wait))
                wait = min(wait * 2, 60)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i < tries - 1:
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            raise


def get_json(url, params=None, data=None, **kw):
    return json.loads(get(url, params, data, **kw))
