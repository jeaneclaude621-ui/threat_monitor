"""
Gathers the articles the model reads. Gemini's free tier has no search
grounding, so instead of the model searching, this module fetches the
reporting itself and hands it over as a numbered list:

- the RSS feeds in config/feeds.json plus the ones added in the web app;
- Google News search (its RSS endpoint, no key) for each watchlist
  thread's queries and for the daily sweep's general and named-source
  queries;
- GDELT's article search (no key, at most one request per 5 seconds);
- single articles added in the web app (page title and opening text).

The model cites an article by its ref ("A12"), never by retyping a URL,
so every link in the app is one that was really fetched. Google News
links are redirects; the ones the model cites are decoded to the
article's own URL (decode_google_link) when the report is enriched.

    python3 src/news_sources.py "Kaliningrad"      # try a query
"""
import html
import json
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common
import feed_prefilter

TIMEOUT = 15
UA = "Mozilla/5.0 (compatible; threat-monitor)"
# Google's cookie-consent answer, so EU-located requests are not sent to
# consent.google.com instead of the content.
GOOGLE_HEADERS = {"User-Agent": "Mozilla/5.0", "Cookie": "SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg"}
GDELT_GAP = 5.5
SUMMARY_CHARS = 300
ARTICLE_TEXT_CHARS = 1500

# Daily sweep queries besides the threads' own and the named sources.
SWEEP_QUERIES = [
    ("Russia hybrid attack Europe", "en"), ("Russia sabotage Europe", "en"),
    ("Russian drones NATO airspace", "en"), ("Russia shadow fleet", "en"),
    ("Russia cyberattack Europe", "en"), ("Russia disinformation campaign", "en"),
    ("Russia NATO Baltic", "en"), ("EU sanctions Russia", "en"),
    ("Russia Arctic military", "en"), ("Ukraine Russia peace talks", "en"),
    ("Ryssland hybridhot", "sv"), ("Ryssland Sverige säkerhet", "sv"),
]
# An RSS article belongs in the daily sweep when it names one of these.
RELEVANT = re.compile(r"\b(russ|rysk|ryss|kreml|kremlin|putin|moscow|moskva|nato|ukrain|baltic|östersjön"
                      r"|sabotage|drone|drönare|hybrid|sanction|sanktion|shadow fleet|skuggflott)", re.I)

SV_TERMS = "(Ryssland OR Ukraina OR Nato OR drönare OR sabotage OR hybridhot OR försvar)"
EN_TERMS = "(Russia OR Ukraine OR NATO OR drone OR sabotage OR hybrid)"

_last_gdelt = 0.0
_gdelt_off = False
_gdelt_lock = threading.Lock()


def _get(url: str, headers: dict = None) -> bytes:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _domain(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


# --------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------
def google_news(query: str, lang: str = "en", days: int = 1) -> list:
    """Google News search results as articles. Never raises."""
    loc = "hl=sv&gl=SE&ceid=SE:sv" if lang == "sv" else "hl=en-US&gl=US&ceid=US:en"
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(f'{query} when:{days}d')}&{loc}"
    try:
        items = feed_prefilter.parse_feed(_get(url, GOOGLE_HEADERS))
    except Exception as e:
        print(f"  ! Google News search failed for {query!r} ({type(e).__name__}: {str(e)[:100]})")
        return []
    out = []
    for it in items:
        # Titles end in " - Outlet"; the outlet is the item's <source>.
        title, _, outlet = it["title"].rpartition(" - ")
        out.append({**it, "title": title or it["title"], "source": outlet or "Google News",
                    "summary": "", "via": "google"})
    return out


def gdelt(query: str, hours: int = 24, limit: int = 40) -> list:
    """GDELT DOC 2.0 article search. Never raises. GDELT often turns
    away shared cloud addresses (429), so the first failure switches it
    off for the rest of the run; Google News and the feeds still cover."""
    global _last_gdelt, _gdelt_off
    url = ("https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode({
        "query": query, "mode": "artlist", "format": "json", "sort": "datedesc",
        "maxrecords": limit, "timespan": f"{hours}h"}))
    with _gdelt_lock:
        if _gdelt_off:
            return []
        wait = _last_gdelt + GDELT_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            raw = _get(url)
            data = json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            _gdelt_off = True
            print(f"  GDELT unavailable, skipped for this run ({type(e).__name__}: {str(e)[:100]})")
            return []
        finally:
            _last_gdelt = time.time()
    out = []
    for a in data.get("articles", []):
        try:
            published = datetime.strptime(a.get("seendate", ""), "%Y%m%dT%H%M%SZ")
            published = published.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
        except ValueError:
            published = None
        out.append({"title": a.get("title", "").strip(), "summary": "", "link": a.get("url", ""),
                    "published": published, "source": a.get("domain", ""), "via": "gdelt"})
    return out


def app_sources() -> list:
    """Sources added in the web app: [{id, kind: rss|article, url, title, added_at}]."""
    import app_sync
    if not app_sync._config():
        return []
    try:
        return app_sync._request("GET", "/api/export/sources", retries=False) or []
    except Exception as e:
        print(f"  ! Could not fetch the app's sources ({e})")
        return []


def all_feeds(app: list) -> list:
    """config/feeds.json plus the app's RSS feeds (named by their title)."""
    feeds = feed_prefilter.load_feeds()
    known = {f["url"] for f in feeds}
    for s in app:
        if s.get("kind") == "rss" and s.get("url") not in known:
            feeds.append({"name": s.get("title") or _domain(s["url"]), "url": s["url"], "added_in_app": True})
    return feeds


META = re.compile(r'<meta\s+[^>]*?(?:property|name)=["\']([^"\']+)["\'][^>]*?content=["\']([^"\']*)["\']', re.I)
META_REV = re.compile(r'<meta\s+[^>]*?content=["\']([^"\']*)["\'][^>]*?(?:property|name)=["\']([^"\']+)["\']', re.I)


def fetch_article(source: dict) -> dict:
    """A single article added in the app: title, site name, date and the
    opening text of its paragraphs. Never raises; falls back to the title
    saved in the app."""
    url = source["url"]
    item = {"title": source.get("title") or url, "summary": "", "link": url,
            "published": None, "source": _domain(url), "via": "app"}
    try:
        page = _get(url, {"User-Agent": "Mozilla/5.0"}).decode("utf-8", "replace")
    except Exception as e:
        print(f"  ! Could not fetch the app article {url} ({type(e).__name__})")
        return item
    meta = {k.lower(): html.unescape(v) for k, v in META.findall(page)}
    meta.update({k.lower(): html.unescape(v) for v, k in META_REV.findall(page) if k.lower() not in meta})
    item["title"] = meta.get("og:title") or item["title"]
    item["source"] = meta.get("og:site_name") or item["source"]
    item["published"] = feed_prefilter._published(meta.get("article:published_time", ""))
    paras = [feed_prefilter.TAG.sub(" ", p) for p in re.findall(r"<p[^>]*>(.*?)</p>", page, re.S | re.I)]
    text = " ".join(html.unescape(re.sub(r"\s+", " ", p)).strip() for p in paras)
    item["summary"] = (meta.get("og:description", "") + " " + text).strip()[:ARTICLE_TEXT_CHARS]
    return item


# --------------------------------------------------------------------------
# Article pool -> numbered prompt block
# --------------------------------------------------------------------------
class Pool:
    def __init__(self):
        self.items, self._seen = [], set()

    def add(self, items):
        for it in items:
            key = (it.get("link") or "").split("?oc=")[0] or None
            tkey = re.sub(r"\W+", " ", (it.get("title") or "").lower()).strip()
            if not tkey or key in self._seen or tkey in self._seen:
                continue
            self._seen.update(k for k in (key, tkey) if k)
            self.items.append(it)
        return self

    def since(self, when: datetime):
        """Drop dated articles older than `when` (undated ones stay)."""
        self.items = [a for a in self.items if a.get("published") is None or a["published"] > when]
        return self

    def prompt_block(self, limit: int, record: bool = True) -> str:
        """The newest `limit` articles as "[A1] Outlet · date · title - summary"
        lines. With `record`, they become the link check's list
        (common.LAST_SEARCH_RESULTS); the hourly checks, which run in
        parallel and cite no links, pass False."""
        items = sorted(self.items, key=lambda a: a.get("published") or datetime.max, reverse=True)[:limit]
        results, lines = [], []
        for i, a in enumerate(items, start=1):
            ref = f"A{i}"
            results.append({"ref": ref, "url": a.get("link"), "title": a.get("title"), "outlet": a.get("source")})
            when = a["published"].strftime("%Y-%m-%d %H:%M") if a.get("published") else "undated"
            summary = (a.get("summary") or "")[:ARTICLE_TEXT_CHARS if a.get("via") == "app" else SUMMARY_CHARS]
            lines.append(f"[{ref}] {a.get('source') or '?'} · {when} · {a.get('title')}"
                         + (f" - {summary}" if summary else ""))
        if record:
            common.LAST_SEARCH_RESULTS[:] = results
        return "\n".join(lines) or "(no articles found)"


def thread_queries(thread: dict) -> list:
    """The thread's own search queries (set by the daily watchlist
    refresh), else the opening words of its label, which name the topic
    ("Ukraine-Russia kinetic escalation cycle")."""
    if thread.get("queries"):
        return [q for q in thread["queries"] if isinstance(q, str) and q.strip()][:3]
    head = re.split(r"[:(]", thread["label"], maxsplit=1)[0]
    return [" ".join(re.sub(r"[^\w\s-]", " ", head).split()[:6])]


def for_thread(thread: dict, feed_articles: list, app_articles: list) -> Pool:
    """Articles for one hourly thread check: matching feed articles, its
    Google News queries, one GDELT search and app articles added since
    the thread was last checked."""
    pool = Pool()
    since = thread.get("last_checked")
    since_dt = datetime.fromisoformat(since) if since else datetime.now() - timedelta(days=1)
    keywords = feed_prefilter.thread_keywords(thread)
    for a in feed_articles:
        tokens = {w.lower() for raw in feed_prefilter.TOKEN.findall(f"{a['title']} {a['summary']}")
                  for w in feed_prefilter._words(raw)}
        if len(feed_prefilter._matches(keywords, tokens)) >= feed_prefilter.MIN_KEYWORD_HITS:
            pool.add([a])
    queries = thread_queries(thread)
    for q in queries:
        pool.add(google_news(q))
    pool.add(gdelt(f"({queries[0]})" if " OR " in queries[0] else queries[0]))
    pool.since(since_dt - timedelta(hours=2))
    pool.add(fetch_article(s) for s in app_articles
             if s.get("added_at") and datetime.fromisoformat(s["added_at"][:19]) > since_dt - timedelta(hours=2))
    return pool


def for_daily(state: dict, feed_articles: list, app_articles: list) -> Pool:
    """Articles for the daily sweep: the threads' and the sweep's Google
    News queries, each named source's site, two GDELT searches and the
    feeds - the last 26h, only items on the subject (RELEVANT) - and app
    articles from the last three days."""
    now = datetime.now()
    pool = Pool()
    pool.add(feed_articles)
    for n in state["methodology"].get("named_sources", []):
        terms = SV_TERMS if n.get("lang") == "sv" else EN_TERMS
        pool.add(google_news(f"site:{n['domain']} {terms}", n.get("lang", "en")))
    for t in state["watchlist"]:
        pool.add(google_news(thread_queries(t)[0]))
    for q, lang in SWEEP_QUERIES:
        pool.add(google_news(q, lang))
    pool.add(gdelt("(Russia OR Russian) (sabotage OR drone OR hybrid OR cyberattack) sourcelang:english"))
    pool.add(gdelt("(Russia OR Russian) (NATO OR Baltic OR Arctic) sourcelang:english"))
    pool.since(now - timedelta(hours=26))
    # Feeds and site searches bring sport and weather too.
    pool.items = [a for a in pool.items if RELEVANT.search(f"{a['title']} {a['summary']}")]
    pool.add(fetch_article(s) for s in app_articles
             if s.get("added_at") and datetime.fromisoformat(s["added_at"][:19]) > now - timedelta(days=3))
    return pool


# --------------------------------------------------------------------------
# Google News links -> the article's own URL
# --------------------------------------------------------------------------
_decoded = {}


def decode_google_link(link: str) -> str:
    """The publisher's URL behind a news.google.com/rss/articles/... link,
    via the same two requests Google News' own page makes. Returns the
    link unchanged when it is not a Google News link or decoding fails."""
    if not link or "news.google.com/rss/articles/" not in link:
        return link
    if link in _decoded:
        return _decoded[link]
    try:
        gid = urlsplit(link).path.rsplit("/", 1)[-1]
        page = _get(f"https://news.google.com/articles/{gid}", GOOGLE_HEADERS).decode("utf-8", "replace")
        sg = re.search(r'data-n-a-sg="([^"]+)"', page).group(1)
        ts = re.search(r'data-n-a-ts="([^"]+)"', page).group(1)
        inner = ["garturlreq", [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None,
                                 None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
                 gid, int(ts), sg]
        body = urllib.parse.urlencode(
            {"f.req": json.dumps([[["Fbv4je", json.dumps(inner), None, "generic"]]])}).encode()
        req = urllib.request.Request("https://news.google.com/_/DotsSplashUi/data/batchexecute", data=body,
                                     headers={**GOOGLE_HEADERS,
                                              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            txt = resp.read().decode("utf-8")
        url = json.loads(json.loads(txt.split("\n\n", 1)[1])[0][2])[1]
        _decoded[link] = url if url.startswith("http") else link
    except Exception:
        _decoded[link] = link
    return _decoded[link]


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "Kaliningrad"
    p = Pool().add(google_news(q)).add(gdelt(q))
    print(p.prompt_block(20))
    print(decode_google_link(next((r["url"] for r in common.LAST_SEARCH_RESULTS
                                   if "news.google" in (r["url"] or "")), "")))
