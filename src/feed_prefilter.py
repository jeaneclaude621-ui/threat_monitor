"""
RSS prefilter for the hourly monitor - in shadow mode.

Before the hourly checks, the feeds in config/feeds.json are fetched and
each watchlist thread is matched against the articles published since the
thread was last checked. A thread with no matching article is one the
prefilter would skip, sparing its Gemini call.

Shadow mode: nothing is skipped yet. Every thread is still checked by
Gemini as before; the prefilter only records what it would have decided,
next to what Gemini then found, in data/logs/prefilter_shadow.jsonl. Once
that record shows the prefilter does not miss real changes, it can be
allowed to skip calls.

Matching is plain code, no model: the names and acronyms in a thread's
label and last snapshot (Witkoff, OFAC, Kaliningrad ...) are its keywords,
minus the ones nearly every article on the war contains (Russia, Ukraine,
NATO ...). An article matches a thread when it names at least two of them.
Names are matched on their start, so "Zelensky" also finds "Zelenskyj".

A feed that fails three runs in a row gets a "!" warning (once), so a feed
that moved or closed is noticed; data/feed_status.json keeps the count.

    python3 src/feed_prefilter.py            # what it would decide right now
    python3 src/feed_prefilter.py --report   # shadow record: would it have missed anything?
"""
import argparse
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, DATA_DIR, LOG_DIR, load_state

FEEDS_PATH = ROOT / "config" / "feeds.json"
STATUS_PATH = DATA_DIR / "feed_status.json"
SHADOW_LOG = LOG_DIR / "prefilter_shadow.jsonl"

TIMEOUT = 15
MIN_KEYWORD_HITS = 2
DEAD_AFTER_FAILURES = 3

# In nearly every article on the war, so they say nothing about which
# thread an article belongs to. Lower case; English and Swedish.
GENERIC = {
    "russia", "russian", "russians", "ryssland", "ryska", "ryssar", "rysk",
    "ukraine", "ukrainian", "ukrainians", "ukraina", "ukrainska", "ukrainsk",
    "nato", "eu", "europe", "european", "europa", "kremlin", "kreml",
    "moscow", "moskva", "kyiv", "kiev", "kyjiv", "putin", "putins", "us", "usa",
    "trump", "west", "western", "sweden", "sverige", "high", "confidence",
    "unverified", "unconfirmed", "corroboration", "required", "low", "single",
    "source", "the", "and", "for", "with", "per",
    "new", "first", "second", "third", "last", "nya", "inga", "inget",
}
# Capitalised words in a label or snapshot that are not names.
COMMON_CAPITALISED = {
    "the", "this", "that", "these", "there", "after", "before", "under",
    "over", "not", "non", "pre", "yet", "still", "also", "both", "all", "any",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "januari", "februari",
    "mars", "maj", "juni", "juli", "augusti", "oktober", "jan", "feb", "mar",
    "apr", "jun", "jul", "aug", "sep", "sept", "oct", "okt", "nov", "dec",
    "morning", "evening", "diplomatic", "track", "talks", "act", "acts",
    "deal", "crisis", "cluster", "doctrine", "posture", "warning", "escalation",
    "provocation", "enforcement", "monitoring", "response", "report", "news",
    "minister", "ministry", "foreign", "global", "group", "economic", "security",
    "defence", "defense", "emergency", "eastern", "western", "northern",
    "southern", "hybrid", "insider", "active", "article", "post", "rep",
    "col", "gen", "president", "prime", "state", "states", "united", "national",
    "efter", "inte", "även", "enligt", "den", "det", "för", "som", "med",
}
TOKEN = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'\-]+")
TAG = re.compile(r"<[^>]+>")


def load_feeds() -> list:
    with open(FEEDS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)["feeds"]


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _published(text: str):
    """A feed date as naive local time (how the watchlist stores times), or None."""
    if not text:
        return None
    text = text.strip()
    try:
        dt = parsedate_to_datetime(text)          # RSS 2.0: RFC 822
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))  # Atom, RDF dc:date
        except ValueError:
            return None
    return dt.astimezone().replace(tzinfo=None) if dt.tzinfo else dt


def parse_feed(data: bytes) -> list:
    """Items of an RSS 2.0, RSS 1.0 (RDF) or Atom feed."""
    items = []
    for node in ET.fromstring(data).iter():
        if _local(node.tag) not in ("item", "entry"):
            continue
        fields = {}
        for child in node:
            name = _local(child.tag)
            if name == "link" and child.get("href"):
                fields.setdefault("link", child.get("href"))
            elif child.text and name not in fields:
                fields[name] = child.text
        summary = fields.get("description") or fields.get("summary") or ""
        items.append({
            "title": html.unescape(TAG.sub(" ", fields.get("title", ""))).strip(),
            "summary": html.unescape(TAG.sub(" ", summary)).strip()[:600],
            "link": (fields.get("link") or fields.get("guid") or "").strip(),
            "published": _published(fields.get("pubDate") or fields.get("published")
                                    or fields.get("updated") or fields.get("date")),
        })
    return items


def fetch_feed(feed: dict) -> list:
    req = urllib.request.Request(feed["url"], headers={"User-Agent": "Mozilla/5.0 threat-monitor"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        items = parse_feed(resp.read())
    for item in items:
        item["source"] = feed["name"]
    return items


def fetch_all(feeds: list):
    """(articles, {feed name: error}) - one article per link across feeds."""
    def one(feed):
        try:
            return feed, fetch_feed(feed), None
        except Exception as e:
            return feed, [], f"{type(e).__name__}: {str(e)[:120]}"

    articles, failures, seen = [], {}, set()
    with ThreadPoolExecutor(max_workers=8) as ex:
        for feed, items, error in ex.map(one, feeds):
            if error:
                failures[feed["name"]] = error
            for item in items:
                key = item["link"] or item["title"]
                if key and key not in seen:
                    seen.add(key)
                    articles.append(item)
    return articles, failures


def update_feed_status(feeds: list, failures: dict, now: datetime):
    status = {}
    if STATUS_PATH.exists():
        with open(STATUS_PATH, "r", encoding="utf-8") as f:
            status = json.load(f)
    for feed in feeds:
        rec = status.setdefault(feed["name"], {"failures_in_a_row": 0, "last_ok": None, "last_error": None})
        if feed["name"] in failures:
            rec["failures_in_a_row"] += 1
            rec["last_error"] = failures[feed["name"]]
            if rec["failures_in_a_row"] == DEAD_AFTER_FAILURES:
                where = "the app's Källor tab" if feed.get("added_in_app") else "config/feeds.json"
                print(f"  ! RSS feed {feed['name']} has failed {DEAD_AFTER_FAILURES} runs in a row "
                      f"({rec['last_error']}) - check its URL in {where}")
        else:
            rec["failures_in_a_row"] = 0
            rec["last_ok"] = now.isoformat(timespec="minutes")
    # Feeds removed from the config drop out of the status file.
    status = {name: rec for name, rec in status.items() if any(f["name"] == name for f in feeds)}
    with open(STATUS_PATH, "w", encoding="utf-8") as f:
        json.dump(status, f, indent=2, ensure_ascii=False)
    return status


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------
def _words(raw: str) -> list:
    raw = re.sub(r"'s$", "", raw.strip("'-"))
    return [w for w in raw.split("-") if w]


def thread_keywords(thread: dict) -> list:
    """Names and acronyms in the thread's label and last snapshot, lower
    case, as groups: the words of one name ("Black Sea", "Abu Dhabi") form
    one group, so a name counts once however many of its words match."""
    text = f"{thread.get('label', '')} {thread.get('last_snapshot', '')}"
    groups, run = {}, []

    def close():
        if run:
            groups[" ".join(run)] = frozenset(run)
            run.clear()

    # Capitalised words next to each other are one name; anything else
    # in between (lower-case word, punctuation, digits) ends it.
    for piece in re.split(r"([^A-Za-zÀ-ÖØ-öø-ÿ'\-\s]+|\s+)", text):
        if not piece or piece.isspace():
            continue
        if not TOKEN.fullmatch(piece):
            close()
            continue
        for word in _words(piece):
            low = word.lower()
            if len(word) < 3 or not word[0].isupper() or low in COMMON_CAPITALISED:
                close()
            elif low not in GENERIC:
                run.append(low)
    close()
    # Groups sharing a word ("Carlyle", "Carlyle Lukoil") are merged, so
    # one name never counts twice.
    merged = []
    for group in groups.values():
        for other in [m for m in merged if m & group]:
            merged.remove(other)
            group = group | other
        merged.append(group)
    return sorted(merged, key=sorted)


def _matches(keywords: list, text_tokens: set) -> list:
    """The keyword groups the text names."""
    def hit(kw):
        return kw in text_tokens or (len(kw) >= 5 and any(t.startswith(kw) for t in text_tokens))
    return [" ".join(sorted(g)) for g in keywords if any(hit(kw) for kw in g)]


def assess_thread(thread: dict, articles: list) -> dict:
    since = thread.get("last_checked")
    since_dt = datetime.fromisoformat(since) if since else None
    keywords = thread_keywords(thread)
    if since_dt is None or len(keywords) < MIN_KEYWORD_HITS:
        return {"would_call": True, "reason": "no last check" if since_dt is None else "too few keywords",
                "keywords": len(keywords), "matches": 0, "near": 0, "articles": []}

    hits, near = [], 0
    for a in articles:
        # An article without a date counts as new: missing a change costs
        # more than an extra call.
        if a["published"] is not None and a["published"] <= since_dt:
            continue
        tokens = {w.lower() for raw in TOKEN.findall(f"{a['title']} {a['summary']}") for w in _words(raw)}
        found = _matches(keywords, tokens)
        if len(found) >= MIN_KEYWORD_HITS:
            hits.append({"source": a["source"], "title": a["title"][:140], "link": a["link"],
                         "keywords": found})
        elif found:
            near += 1
    # "near": articles naming just one keyword - kept to tune the threshold.
    return {"would_call": bool(hits), "reason": "matching articles" if hits else "no matching article",
            "keywords": len(keywords), "matches": len(hits), "near": near, "articles": hits[:3]}


def check(watchlist: list, now: datetime = None, record_status: bool = True, feeds: list = None):
    """(thread id -> what the prefilter would decide for it, the fetched
    articles). `feeds` defaults to config/feeds.json. Never raises: a
    prefilter failure must not stop the hourly run."""
    now = now or datetime.now()
    try:
        feeds = feeds if feeds is not None else load_feeds()
        articles, failures = fetch_all(feeds)
        if record_status:
            update_feed_status(feeds, failures, now)
        print(f"  RSS prefilter (shadow mode): {len(articles)} articles from "
              f"{len(feeds) - len(failures)}/{len(feeds)} feeds")
        if len(failures) == len(feeds):
            return {}, []
        return {t["id"]: assess_thread(t, articles) for t in watchlist}, articles
    except Exception as e:
        print(f"  RSS prefilter failed, ignored ({type(e).__name__}: {e})")
        return {}, []


def record_shadow(decisions: dict, outcomes: dict, now: datetime):
    """One line per thread: the prefilter's decision and Gemini's classification."""
    if not decisions:
        return
    skipped = [tid for tid, d in decisions.items() if not d["would_call"]]
    missed = [tid for tid in skipped if outcomes.get(tid) not in (None, "NO_CHANGE")]
    print(f"  RSS prefilter (shadow mode): would have skipped {len(skipped)}/{len(decisions)} threads"
          + (f"; Gemini found a change in {len(missed)} of them ({', '.join(missed)})" if missed else ""))
    try:
        with open(SHADOW_LOG, "a", encoding="utf-8") as f:
            for tid, d in decisions.items():
                f.write(json.dumps({
                    "ts": now.isoformat(timespec="minutes"), "thread_id": tid,
                    "would_call": d["would_call"], "reason": d["reason"], "matches": d["matches"],
                    "near": d["near"],
                    "classification": outcomes.get(tid), "articles": d["articles"],
                }, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"  RSS prefilter: could not write the shadow log ({e})")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def report():
    if not SHADOW_LOG.exists():
        print("No shadow record yet - it fills with each hourly run.")
        return
    rows = [json.loads(line) for line in open(SHADOW_LOG, encoding="utf-8") if line.strip()]
    rows = [r for r in rows if r.get("classification")]
    runs = len({r["ts"] for r in rows})
    skip = [r for r in rows if not r["would_call"]]
    missed = [r for r in skip if r["classification"] != "NO_CHANGE"]
    changed = [r for r in rows if r["classification"] != "NO_CHANGE"]
    print(f"{runs} runs, {len(rows)} thread checks since {rows[0]['ts'] if rows else '-'}")
    print(f"Would have skipped:   {len(skip)} calls ({100 * len(skip) / max(len(rows), 1):.0f} %)")
    print(f"Changes Gemini found: {len(changed)}, of which the prefilter would have missed {len(missed)}")
    for r in missed:
        print(f"  missed {r['ts']} {r['thread_id']}: {r['classification']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--report", action="store_true", help="summarise the shadow record")
    args = parser.parse_args()
    if args.report:
        report()
        return
    # A look from the command line leaves the feed status to the scheduled runs.
    for tid, d in check(load_state()["watchlist"], record_status=False)[0].items():
        print(f"{tid}: {'call' if d['would_call'] else 'skip'} ({d['reason']}, {d['keywords']} keywords)")
        for a in d["articles"]:
            print(f"    {a['source']}: {a['title']}  [{', '.join(a['keywords'])}]")


if __name__ == "__main__":
    main()
