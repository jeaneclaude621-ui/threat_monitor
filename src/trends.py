"""
Trends: what is spreading right now, as a feed of its own beside the
analysis. Runs at 08:00, 12:00, 16:00 and 21:00 Stockholm.

Two sides, kept apart all the way to the app:
- "open": Wikipedia page views, Google Trends' daily searches, Mastodon
  and Bluesky - what people in Europe read, search and share (Reddit
  answers 429 to GitHub's and most other addresses, so it is left out);
- "ru": public Telegram channels of Russian state media, the defence
  ministry and pro-Kremlin war bloggers - what the Russian side pushes.
  They are the excluded tier of config/methodology.json: shown so the
  readers can see the narratives, never counted as evidence.

Nothing here feeds the daily report, the thread checks, the scores or the
index: no other module reads data/trends.json, and this job only writes
there and to the app (PUT /api/ingest/trends). A failing source is
skipped and noted; a failing job stops nothing else.

Virality is growth, not size: views against the page's usual level
(Wikipedia), a post's views against its channel's usual level
(Telegram), today's sharing against the days before (Mastodon). Only
items on the subject are kept.

One Gemini call a day, in the first run from 20:00: a Swedish summary of
each side and Swedish titles for the Russian posts.

    python3 src/trends.py            # collect, upload, summarise if due
    python3 src/trends.py --dry-run  # print what it found, keep and send nothing
"""
import argparse
import hashlib
import html
import json
import re
import statistics
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, load_state, ask_model_json
import news_sources
import feed_prefilter

TRENDS_PATH = DATA_DIR / "trends.json"
TIMEOUT = 20
UA = "threat-monitor/1 (https://github.com/jeaneclaude621-ui/threat_monitor)"

WIKI_LANGS = ["en", "sv", "fi", "no", "da", "de", "pl", "et", "lv", "lt"]
GOOGLE_GEOS = ["SE", "FI", "NO", "DK", "DE", "PL", "EE", "LV", "LT", "GB", "US"]
MASTODON = "https://mastodon.social/api/v1/trends/links?limit=40"
BLUESKY = "https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics"
# Russian state media, the defence ministry and pro-Kremlin war bloggers
# with a public web preview (t.me/s/...). RIA Novosti has none.
TELEGRAM = ["tass_agency", "mod_russia", "medvedev_telegram", "SolovievLive",
            "rybar", "readovkanews", "boris_rozhin", "wargonzo"]
# The feeds' subject filter, without "Russell" (Brand, Crowe ...), which
# fills the search and Wikipedia trends.
RELEVANT = re.compile(news_sources.RELEVANT.pattern.replace("(russ|", "(russ(?!ell)|", 1), re.I)
# A Russian post is kept when it names NATO, Europe or the neighbours, not
# only the front - that is where the hybrid narratives are. Drones alone
# are mostly the front.
RU_TOPIC = re.compile(r"НАТО|Европ|Евросоюз|Швец|Швед|Финлян|Норвег|Дани[яию]|Эстон|Латви|Литв|Прибалт"
                      r"|Балти|Польш|Герман|Франц|Британ|Калинингр|Арктик|диверс|саботаж|санкци|тенев", re.I)

KEEP_DAYS = 3
WIKI_SPIKE = 2.0          # views at least this many times the page's median
WIKI_MIN_VIEWS = {"en": 1000, "de": 500}   # and at least this many views; 100 elsewhere
TELEGRAM_SPIKE = 1.5      # a post's views against its channel's median
MAX_ITEMS = {"open": 40, "ru": 30}
SUMMARY_FROM_HOUR = 20


def _get(url: str, headers: dict = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _id(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def _iso(dt) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _text(el, tag) -> str:
    x = el.find(tag)
    return html.unescape(re.sub(r"<[^>]+>", " ", x.text or "")).strip() if x is not None and x.text else ""


def _times(n: float) -> str:
    return f"{n:.1f}".replace(".", ",") + "×"


def _count(n: int) -> str:
    return f"{n:,}".replace(",", "\u00a0")


# --------------------------------------------------------------------------
# Open side
# --------------------------------------------------------------------------
def wikipedia(now: datetime) -> list:
    """Pages on the subject among each language's most read yesterday,
    kept when read at least WIKI_SPIKE times their usual level."""
    day = now - timedelta(days=1)
    out = []
    for lang in WIKI_LANGS:
        top = json.loads(_get(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/"
                              f"{lang}.wikipedia/all-access/{day:%Y/%m/%d}"))
        for a in top["items"][0]["articles"]:
            title = a["article"].replace("_", " ")
            if ":" in title or not RELEVANT.search(title):
                continue
            series = json.loads(_get(
                f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{lang}.wikipedia/all-access/user/"
                f"{urllib.parse.quote(a['article'], safe='')}/daily/{day - timedelta(days=30):%Y%m%d}/{day:%Y%m%d}"))
            views = [i["views"] for i in series["items"]]
            if len(views) < 8:
                continue
            base = statistics.median(views[:-1]) or 1
            spike = views[-1] / base
            if spike < WIKI_SPIKE or views[-1] < WIKI_MIN_VIEWS.get(lang, 100):
                continue
            out.append({
                "id": _id("wikipedia", lang, a["article"], f"{day:%Y-%m-%d}"), "side": "open",
                "source": "wikipedia", "where": f"{lang}.wikipedia", "title": title,
                "url": f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(a['article'])}",
                "metric": views[-1], "spike": round(spike, 1),
                "metric_sv": f"{_count(views[-1])} visningar i går, {_times(spike)} det normala",
                "published": f"{day:%Y-%m-%d}",
            })
    return out


def google_trends(now: datetime) -> list:
    """Each country's daily search trends that are on the subject, by the
    search term or the news it links to."""
    ns = {"ht": "https://trends.google.com/trending/rss"}
    out = []
    for geo in GOOGLE_GEOS:
        root = ET.fromstring(_get(f"https://trends.google.com/trending/rss?geo={geo}"))
        for item in root.iter("item"):
            title = _text(item, "title")
            news = [(_text(n, "ht:news_item_title"), _text(n, "ht:news_item_url"), _text(n, "ht:news_item_source"))
                    for n in item.findall("ht:news_item", ns)]
            if not (RELEVANT.search(title) or any(RELEVANT.search(t) for t, _, _ in news)):
                continue
            traffic = _text(item, "ht:approx_traffic")
            out.append({
                "id": _id("google_trends", geo, title.lower(), f"{now:%Y-%m-%d}"), "side": "open",
                "source": "google_trends", "where": geo, "title": title,
                "url": news[0][1] if news and news[0][1] else None,
                "detail": " · ".join(f"{t} ({s})" if s else t for t, _, s in news[:3]) or None,
                "metric": int(re.sub(r"\D", "", traffic) or 0), "spike": None,
                "metric_sv": f"{traffic} sökningar i {geo}" if traffic else f"Trendar i {geo}",
            })
    return out


def mastodon(now: datetime) -> list:
    out = []
    for link in json.loads(_get(MASTODON)):
        text = f"{link.get('title', '')} {link.get('description', '')}"
        if not RELEVANT.search(text):
            continue
        hist = [int(d.get("accounts") or 0) for d in link.get("history") or []]
        today, before = (hist[0], hist[1:]) if hist else (0, [])
        base = statistics.mean(before) if before and statistics.mean(before) else None
        out.append({
            "id": _id("mastodon", link.get("url")), "side": "open",
            "source": "mastodon", "where": link.get("provider_name") or "Mastodon",
            "title": link.get("title") or link.get("url"), "url": link.get("url"),
            "detail": (link.get("description") or "")[:300] or None,
            "metric": today, "spike": round(today / base, 1) if base else None,
            "metric_sv": f"Delad av {today} konton i dag" + (f", {_times(today / base)} dagarna innan" if base else ""),
        })
    return out


def bluesky(now: datetime) -> list:
    out = []
    data = json.loads(_get(BLUESKY))
    for t in (data.get("topics") or []) + (data.get("suggested") or []):
        if not RELEVANT.search(t.get("topic", "")):
            continue
        out.append({
            "id": _id("bluesky", t["topic"].lower(), f"{now:%Y-%m-%d}"), "side": "open",
            "source": "bluesky", "where": "Bluesky", "title": t["topic"],
            "url": "https://bsky.app" + t["link"] if t.get("link", "").startswith("/") else t.get("link"),
            "metric": None, "spike": None, "metric_sv": "Trendar på Bluesky",
        })
    return out


# --------------------------------------------------------------------------
# Russian side
# --------------------------------------------------------------------------
POST = re.compile(r'<div class="tgme_widget_message_wrap.*?(?=<div class="tgme_widget_message_wrap|\Z)', re.S)


def _views(text: str) -> int:
    m = re.match(r"([\d.]+)([KM]?)", text.strip())
    if not m:
        return 0
    return int(float(m.group(1)) * {"": 1, "K": 1_000, "M": 1_000_000}[m.group(2)])


def telegram(now: datetime) -> list:
    """Posts of the last 24h on NATO, Europe and the neighbours, with their
    views against the channel's median over the page."""
    out = []
    for channel in TELEGRAM:
        page = _get(f"https://t.me/s/{channel}", {"User-Agent": "Mozilla/5.0"}).decode("utf-8", "replace")
        posts = []
        for block in POST.findall(page):
            post = re.search(r'data-post="([^"]+)"', block)
            when = re.search(r'<time datetime="([^"]+)"', block)
            views = re.search(r'tgme_widget_message_views">([^<]+)<', block)
            body = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', block, re.S)
            if not (post and when and views):
                continue
            text = html.unescape(re.sub(r"<br\s*/?>", "\n", body.group(1)) if body else "")
            text = re.sub(r"<[^>]+>", "", text).strip()
            posts.append((post.group(1), datetime.fromisoformat(when.group(1)), _views(views.group(1)), text))
        base = statistics.median([p[2] for p in posts]) if posts else 0
        for post, when, views, text in posts:
            if now - when > timedelta(hours=24) or not text or not RU_TOPIC.search(text):
                continue
            first = next((l.strip(" 📝⚡️❗️🔴") for l in text.splitlines() if l.strip(" 📝⚡️❗️🔴")), text)
            spike = views / base if base else None
            out.append({
                "id": _id("telegram", post), "side": "ru", "source": "telegram", "where": f"@{channel}",
                "title": first[:160], "url": f"https://t.me/{post}", "detail": text[:700],
                "metric": views, "spike": round(spike, 1) if spike else None,
                "metric_sv": f"{_count(views)} visningar"
                             + (f", {_times(spike)} kanalens normala" if spike and spike >= TELEGRAM_SPIKE else ""),
                "published": _iso(when),
            })
    return out


SOURCES = {"wikipedia": wikipedia, "google_trends": google_trends,
           "mastodon": mastodon, "bluesky": bluesky, "telegram": telegram}


# --------------------------------------------------------------------------
# Thread tags, ranking, summary
# --------------------------------------------------------------------------
def tag_threads(items: list, watchlist: list):
    """A display tag only: the watchlist thread an open item names."""
    keywords = [(t["id"], feed_prefilter.thread_keywords(t)) for t in watchlist]
    for it in items:
        if it["side"] != "open":
            continue
        tokens = {w.lower() for raw in feed_prefilter.TOKEN.findall(f"{it['title']} {it.get('detail') or ''}")
                  for w in feed_prefilter._words(raw)}
        hits = [(len(feed_prefilter._matches(kw, tokens)), tid) for tid, kw in keywords]
        best = max(hits, default=(0, None))
        if best[0] >= feed_prefilter.MIN_KEYWORD_HITS:
            it["thread_id"] = best[1]


def rank(item: dict) -> float:
    """Growth first; items with no growth figure rank by being there at all."""
    return (item.get("spike") or 1.0) + (0.5 if item["source"] in ("google_trends", "wikipedia") else 0)


def summarise(items: list, date: str) -> dict:
    by_side = {s: [i for i in items if i["side"] == s] for s in ("open", "ru")}
    listing = "\n\n".join(
        f"=== {side}\n" + "\n".join(
            f"[{i['id']}] {i['where']} · {i['metric_sv']} · {i['title']}"
            + (f"\n    {i['detail'][:300]}" if i.get("detail") and side == "ru" else "")
            for i in sorted(group, key=rank, reverse=True)[:MAX_ITEMS[side]])
        for side, group in by_side.items() if group)
    prompt = f"""Below is what spread on {date} on the subject of Russia, NATO, the EU
and Ukraine, from two sides kept apart:

- "open": what people in Europe read on Wikipedia, searched on Google,
  and shared on Mastodon and Bluesky;
- "ru": posts of Russian state media, the Russian defence ministry and
  pro-Kremlin war bloggers on Telegram (in Russian).

{listing}

Write, in natural Swedish:
- "open_sv": 2-4 sentences on what is spreading on the open side and
  what it seems to be about. Say plainly when little is.
- "ru_sv": 2-4 sentences on which narratives the Russian side is
  pushing about NATO, Europe and the neighbours. Report them as claims
  and narratives ("ryska kanaler hävdar ..."), never as facts.
- "titles_sv": for every "ru" item, and every "open" item not in Swedish
  or English, a short Swedish title (max ~12 words), keyed by its id.
  For "ru" items, again as a claim ("Rybar hävdar att ...").

Respond as strict JSON:
{{"open_sv": "...", "ru_sv": "...", "titles_sv": {{"<id>": "..."}}}}"""
    result = ask_model_json(prompt, system="You summarise social-media and search trends for a Swedish "
                            "security analysis team. Strict JSON only.", max_tokens=6000)
    return {"date": date, "open_sv": result.get("open_sv"), "ru_sv": result.get("ru_sv"),
            "titles_sv": {k: v for k, v in (result.get("titles_sv") or {}).items() if isinstance(v, str)}}


# --------------------------------------------------------------------------
def load() -> dict:
    if TRENDS_PATH.exists():
        with open(TRENDS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"items": {}, "summaries": {}, "sources": {}}


def run(dry_run: bool = False):
    now = datetime.now(timezone.utc)
    local = datetime.now()
    print(f"[{local.isoformat(timespec='minutes')}] Trends starting")
    data = load()

    def one(name):
        try:
            return name, SOURCES[name](now), None
        except Exception as e:
            return name, [], f"{type(e).__name__}: {str(e)[:120]}"

    found = []
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as ex:
        for name, items, err in ex.map(one, SOURCES):
            found += items
            data["sources"][name] = {"at": _iso(now), "found": len(items), "error": err}
            print(f"  {name}: {len(items)} on the subject" + (f"  ! {name} failed ({err})" if err else ""))

    tag_threads(found, load_state()["watchlist"])
    for side in ("open", "ru"):
        group = sorted((i for i in found if i["side"] == side), key=rank, reverse=True)[:MAX_ITEMS[side]]
        for it in group:
            prev = data["items"].get(it["id"], {})
            data["items"][it["id"]] = {**prev, **it, "first_seen": prev.get("first_seen") or _iso(now),
                                       "last_seen": _iso(now)}
    cutoff = _iso(now - timedelta(days=KEEP_DAYS))
    data["items"] = {k: v for k, v in data["items"].items() if v["last_seen"] >= cutoff}

    today = f"{local:%Y-%m-%d}"
    summary = None
    if local.hour >= SUMMARY_FROM_HOUR and today not in data["summaries"]:
        todays = [i for i in data["items"].values() if i["last_seen"][:10] >= f"{now:%Y-%m-%d}"]
        if dry_run:
            print(f"  Summary due: would send {len(todays)} items to Gemini")
        elif todays:
            try:
                summary = summarise(todays, today)
                for iid, title in summary.pop("titles_sv").items():
                    if iid in data["items"]:
                        data["items"][iid]["title_sv"] = title
                data["summaries"][today] = summary
                print("  Daily summary written")
            except Exception as e:
                print(f"  ! Daily summary failed ({e})")
    data["summaries"] = dict(sorted(data["summaries"].items())[-14:])

    if dry_run:
        for it in sorted(data["items"].values(), key=rank, reverse=True)[:25]:
            print(f"  [{it['side']}] {it['where']:>16} | {it['metric_sv']} | {it['title'][:90]}")
        return
    with open(TRENDS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    from app_sync import push_trends
    push_trends({"items": list(data["items"].values()),
                 "summaries": list(data["summaries"].values())[-7:], "sources": data["sources"]})
    print("Trends done.\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    run(ap.parse_args().dry_run)
