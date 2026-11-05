"""
What the Swedish authorities say: Försvarsmakten, MUST, MCF, the
Government, the Police, Säpo, Tullverket and Kustbevakningen - on the
situation overall, and the last 24 hours - and, in the same call, what
NATO itself says, in Swedish. Runs at 07:00 and 17:00 Stockholm.

A page of its own beside the analysis, like the trends feed: nothing else
reads data/authorities.json, and this job only writes there and to the
app (PUT /api/ingest/authorities).

Few of them have a working feed (checked 1 Nov 2026): MCF, the
Government's press releases and the Police's news are read directly;
Försvarsmakten (where MUST also publishes) and the Government through
Google News for their own site; Säpo, Tullverket and Kustbevakningen only
through what Swedish media report them saying. Each item says which:
"via" names the media when the word is not the agency's own.

What the material is full of, and is filtered out here before the model
sees it: Försvarsmakten's job ads, other countries' coast guards,
unrelated local crime. Old stories republished with a new date (a 2022 TV4
clip in the 1 Nov test) are left to the model.

NATO's own feeds answer 404 and its commands' sites (SHAPE, MARCOM,
AIRCOM) refuse scripts (403, 1 Nov 2026); nato.int is read through Google
News for its own site, with international reporting beside it.

One Gemini call a run, for both.

    python3 src/authorities.py            # collect, summarise, upload
    python3 src/authorities.py --dry-run  # print what it would send, no call
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, ask_model_json
import common
import feed_prefilter
import news_sources

AUTHORITIES_PATH = DATA_DIR / "authorities.json"
WINDOW_DAYS = 7
FRESH_HOURS = 24
MAX_PER_AGENCY = 15

# On the subject: security, defence, preparedness, crime with a state or
# hybrid side. The Police and the Government publish much else.
SECURITY = re.compile(news_sources.RELEVANT.pattern[:-1] + r"|säkerhet|beredskap|totalförsvar|civilt försvar|spion"
                      r"|terror|cyber|it-attack|sabot|smuggl|vapen|gräns|underrättelse|hot\b|hotbild|kris)", re.I)
# Försvarsmakten's site is mostly job ads.
JOB_AD = re.compile(r"\bsöker\b|specialist|ingenjör|officer\b|befäl\b|tekniker|handläggare|praktik|\bprao\b"
                    r"|till (F|I|P|A|K|S|Lv|Ing|T|MHS|FMV)\s?\d|med inriktning|\banställ|rekryter", re.I)

# Google News's Swedish edition carries machine-translated foreign news
# ("Kustbevakningen" in Vietnam, 1 Nov).
FOREIGN_SOURCE = re.compile(r"vietnam|\.vn\b", re.I)

# name, own domains, direct feeds, Google News queries (query, days), the
# word an item from media must name (None: the query is specific enough),
# and whether it must be on the subject.
AGENCIES = [
    ("Försvarsmakten", ["forsvarsmakten.se"], [],
     [("site:forsvarsmakten.se", 3), ("Försvarsmakten", 3), ("försvarschefen OR överbefälhavaren", 3)],
     None, False),
    ("MUST", ["forsvarsmakten.se"], [],
     [("MUST underrättelse", 7), ('"Militära underrättelse- och säkerhetstjänsten"', 7)],
     r"\bMUST\b|militära underrättelse", False),
    ("MCF", ["mcf.se"],
     ["https://www.mcf.se/sv/rss-floden/rss-alla-nyheter-fran-myndigheten-for-civilt-forsvar/"],
     [('"Myndigheten för civilt försvar"', 7)],
     None, False),
    ("Regeringen", ["regeringen.se"],
     ["https://www.regeringen.se/Filter/RssFeed?filterType=Taxonomy&filterByType=FilterablePageBase&preFilteredCategories=1324"],
     [("site:regeringen.se", 3)],
     r"regering|minister|statsråd", True),
    ("Polisen", ["polisen.se"], ["https://polisen.se/aktuellt/rss/hela-landet/nyheter-hela-landet/"],
     [("Polisen sabotage OR spioneri OR drönare OR Ryssland OR terror", 3)],
     r"\bpolis", True),
    ("Säpo", ["sakerhetspolisen.se"], [],
     [("Säpo OR Säkerhetspolisen", 3)],
     None, False),
    ("Tullverket", ["tullverket.se"], [],
     [("Tullverket", 7)],
     r"Tullverk|\btullen\b", True),
    ("Kustbevakningen", ["kustbevakningen.se"], [],
     [("Kustbevakningen", 7)],
     r"Kustbevakningen", False),
]


# NATO: (query, days, own channel). Its own site's pages that are not news
# ("Home", "Monthly Archives") are dropped.
NATO = "Nato"
NATO_QUERIES = [
    ("site:nato.int", 7, True),
    ("NATO Secretary General Rutte", 3, False),
    ('NATO SHAPE OR "Allied Maritime Command" OR "Allied Air Command"', 7, False),
    ('NATO "Baltic Sentry" OR "Eastern Sentry" OR "air policing" OR "eastern flank"', 3, False),
]
NATO_NAMES = re.compile(r"\bNATO\b|\bNato\b|\bOTAN\b|Rutte|SHAPE|Allied (Air|Maritime|Land|Command)", re.I)
NATO_NOT_NEWS = re.compile(r"^(Home|Remarks|Monthly Archives|Archive|Search)\b|Portal|Science and Technology Organization$", re.I)
# A media source named in Latin script: Google News's English edition also
# carries Russian sites (1 Nov: "Военное дело").
LATIN_NAME = re.compile(r"^[^\u0400-\u04FF\u0600-\u06FF]*$")
# A date in an article's address: old stories come back with a new date
# (LSM's June and September articles on 31 Oct, a 2022 TV4 clip).
URL_DATES = [re.compile(r"(?<!\d)(?P<d>\d{2})\.(?P<m>\d{2})\.(?P<y>20\d{2})(?!\d)"),
             re.compile(r"/(?P<y>20\d{2})/(?P<m>\d{1,2})/(?P<d>\d{1,2})(?:/|$)"),
             re.compile(r"(?<!\d)(?P<y>20\d{2})-(?P<m>\d{2})-(?P<d>\d{2})(?!\d)")]


def url_date(url: str):
    for rx in URL_DATES:
        m = rx.search(url or "")
        if m:
            try:
                return datetime(int(m["y"]), int(m["m"]), int(m["d"]))
            except ValueError:
                pass
    return None


NATO_TOPICS = ["Generalsekreteraren", "Militära kommandon", "Östersjön och östflanken", "Ukraina", "EU och partner", "Övrigt"]


def gather_nato(now: datetime) -> list:
    items, own, media, seen = [], [], [], set()
    for q, days, is_own in NATO_QUERIES:
        items += [dict(a, own=is_own) for a in news_sources.google_news(q, "en", days=days)]
    for a in sorted(items, key=lambda a: a.get("published") or datetime.min, reverse=True):
        text = f"{a.get('title', '')} {a.get('summary', '')}"
        key = re.sub(r"\W+", " ", a.get("title", "").lower()).strip()
        if not key or key in seen or not a.get("published") or a["published"] < now - timedelta(days=WINDOW_DAYS):
            continue
        if (a["own"] and NATO_NOT_NEWS.search(a["title"])) or FOREIGN_SOURCE.search(a.get("source") or ""):
            continue
        if not a["own"] and not (NATO_NAMES.search(text) and LATIN_NAME.match(a.get("source") or "")):
            continue
        seen.add(key)
        (own if a["own"] else media).append(a)
    # NATO's own news first: newer media items must not push it out.
    kept = own[:MAX_PER_AGENCY] + media[:MAX_PER_AGENCY]
    print(f"  {NATO}: {len(kept)} item(s), {len(own[:MAX_PER_AGENCY])} from nato.int")
    return kept


def _outlet(article: dict) -> str:
    """A short outlet name: "Omni – Alla nyheter. Alla perspektiv." is Omni,
    a bare address its domain."""
    name = (article.get("source") or "").strip()
    if not name or name.startswith("http"):
        return _domain(name or article.get("link"))
    return re.split(r"\s[–|-]\s", name)[0].strip()


def _domain(url: str) -> str:
    try:
        return urlsplit(url or "").netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def gather(now: datetime) -> dict:
    """{agency: [article]}, newest first, at most MAX_PER_AGENCY each."""
    out = {}
    for name, domains, feeds, queries, names_re, on_subject in AGENCIES:
        must_name = re.compile(names_re, re.I) if names_re else None
        items = []
        for url in feeds:
            try:
                items += [dict(a, own=True) for a in feed_prefilter.fetch_feed({"name": name, "url": url})]
            except Exception as e:
                print(f"  ! {name}: feed failed ({type(e).__name__}: {str(e)[:80]})")
        for q, days in queries:
            own_site = q.startswith("site:")
            items += [dict(a, own=own_site) for a in news_sources.google_news(q, "sv", days=days)]
        kept, seen = [], set()
        for a in sorted(items, key=lambda a: a.get("published") or datetime.min, reverse=True):
            text = f"{a.get('title', '')} {a.get('summary', '')}"
            key = re.sub(r"\W+", " ", a.get("title", "").lower()).strip()
            if not key or key in seen or not a.get("published") or a["published"] < now - timedelta(days=WINDOW_DAYS):
                continue
            if a["own"] and name in ("Försvarsmakten", "MUST") and JOB_AD.search(a["title"]):
                continue
            if not a["own"] and (FOREIGN_SOURCE.search(a.get("source") or "")
                                 or (must_name and not must_name.search(text))):
                continue
            if on_subject and not SECURITY.search(text):
                continue
            seen.add(key)
            kept.append(a)
        out[name] = kept[:MAX_PER_AGENCY]
        print(f"  {name}: {len(out[name])} item(s)")
    out[NATO] = gather_nato(now)
    return out


def summarise(material: dict, now: datetime) -> dict:
    mark = common.calls_mark()
    refs, blocks = {}, []
    for name, items in material.items():
        lines = []
        for a in items:
            ref = f"A{len(refs) + 1}"
            refs[ref] = (name, a)
            source = (name if name != NATO else "nato.int") if a["own"] else _outlet(a)
            lines.append(f"[{ref}] {a['published']:%Y-%m-%d %H:%M} · {source} · {a['title']}"
                         + (f" - {a['summary'][:300]}" if a.get("summary") and a["summary"] != a["title"] else ""))
        blocks.append(f"=== {name}\n" + ("\n".join(lines) or "(nothing found)"))
    names = [a[0] for a in AGENCIES]
    prompt = f"""It is {now:%Y-%m-%d %H:%M} in Stockholm. Below is what was published in the
last {WINDOW_DAYS} days by or about Swedish authorities, grouped by authority, and, last,
by or about NATO: their own channels, and media reporting what they say.
Each item has a ref.

{chr(10).join(blocks)}

Write two short briefs, both in natural Swedish (translate what is in
English), on the security situation - Russia, hybrid threats, defence,
espionage, sabotage, preparedness, the Baltic Sea, Ukraine:

1. The Swedish authorities ({", ".join(names)}):
- "overall_sv": 3-5 sentences on the situation as these authorities
  describe it, from all of it together.
- "items": the things worth knowing, at most 3 per authority, newest
  first. Each: "agency" (exactly one of those names), "refs", "text_sv"
  (one or two sentences, max ~40 words: who said or did what).

2. NATO (the "=== {NATO}" group):
- "nato_overall_sv": 3-4 sentences on NATO's line: what NATO itself says
  and does.
- "nato_items": at most 8, newest first. Each: "topic" (exactly one of:
  {", ".join(NATO_TOPICS)}), "refs", "text_sv" (one or two sentences, max
  ~40 words).

For both: write what the authority or NATO says or does; when it rests on
media, write it as reported ("enligt TV4", "enligt Reuters"), never
stronger than the source. Give a person's title or role only as the items
state it, never from your own knowledge; when unsure, give the name alone.
Put an item under the authority it is really about, not under the query
that found it. Prefer established media over aggregator and content-farm
sites (such as Magzter, HurBra). For NATO, build on NATO's own items (nato.int) first and use media
for what they do not cover; never cite Russian state or pro-Kremlin outlets.
Leave out job ads, routine and local matters unrelated to security,
items about other countries' authorities (in part 1), and anything that is
an old story republished (events from earlier years or months with a new
date). Nothing worth knowing gives no items.

Respond as strict JSON:
{{"overall_sv": "...", "items": [{{"agency": "...", "refs": ["A1"], "text_sv": "..."}}],
  "nato_overall_sv": "...", "nato_items": [{{"topic": "...", "refs": ["A9"], "text_sv": "..."}}]}}"""
    result = ask_model_json(prompt, system="You brief a Swedish security analysis team on what Swedish "
                            "authorities and NATO say. Strict JSON only.", max_tokens=6000)

    def build(it, label):
        cited = [refs[r] for r in it.get("refs") or [] if r in refs]
        if not cited or not isinstance(it.get("text_sv"), str):
            return None
        # Drop it when every source's address dates it before the window.
        dates = []
        for _, a in cited:
            link = a.get("link") or ""
            if "news.google.com/rss/articles/" in link:
                link = a["link"] = news_sources.decode_google_link(link) or link
            dates.append(url_date(link))
        if all(d and d < now - timedelta(days=WINDOW_DAYS + 1) for d in dates):
            print(f"  Left out an old story: {cited[0][1].get('title', '')[:80]}")
            return None
        newest = max(a["published"] for _, a in cited)
        media = sorted({_outlet(a) for _, a in cited if not a["own"]})
        link = next((a.get("link") for _, a in cited if a["own"]), None) or cited[0][1].get("link")
        if link and "news.google.com/rss/articles/" in link:
            link = news_sources.decode_google_link(link)
        return {
            "agency": label, "text_sv": it["text_sv"].strip(),
            "via": (", ".join(media[:-1]) + " och " + media[-1] if len(media) > 1 else media[0])
                   if media and not any(a["own"] for _, a in cited) else None,
            "date": f"{newest:%Y-%m-%d}", "url": link if link and link.startswith("https://") else None,
            "fresh": newest >= now - timedelta(hours=FRESH_HOURS),
        }, [g for g, _ in cited]

    items = []
    for it in result.get("items") or []:
        built = build(it, it.get("agency")) if it.get("agency") in names else None
        if not built:
            continue
        item, groups = built
        # Under the authority its sources were found for, not where the
        # model put it (1 Nov: Försvarsmakten's warning filed under MUST).
        groups = [g for g in groups if g in names]
        if not groups:
            continue
        if item["agency"] not in groups:
            item["agency"] = max(set(groups), key=groups.count)
        items.append(item)
    # Agencies in their order above, each newest first.
    items.sort(key=lambda i: i["date"], reverse=True)
    items.sort(key=lambda i: names.index(i["agency"]))

    nato_items = []
    for it in result.get("nato_items") or []:
        built = build(it, it.get("topic") if it.get("topic") in NATO_TOPICS else "Övrigt")
        if built and NATO in built[1]:
            nato_items.append(built[0])
    nato_items.sort(key=lambda i: i["date"], reverse=True)

    return {
        "generated_at": now.astimezone().isoformat(timespec="seconds"),
        "overall_sv": result.get("overall_sv"),
        "items": items,
        "quiet": [n for n in names if not any(i["agency"] == n for i in items)],
        "nato": {"overall_sv": result.get("nato_overall_sv"), "items": nato_items},
        "found": {n: len(v) for n, v in material.items()},
        "generated_by": common.generated_by(mark),
    }


def run(dry_run: bool = False):
    now = datetime.now()
    print(f"[{now.isoformat(timespec='minutes')}] Authorities starting")
    material = gather(now)
    if dry_run:
        for name, items in material.items():
            for a in items[:5]:
                print(f"  {name:16} {a['published']:%m-%d %H:%M} {'eget' if a['own'] else 'media'} | {a['title'][:90]}")
        return
    if not any(material.values()):
        print("  ! Nothing found for any authority; keeping the last brief")
        return
    brief = summarise(material, now)
    print(f"  Brief: {len(brief['items'])} item(s), {sum(i['fresh'] for i in brief['items'])} from the last "
          f"{FRESH_HOURS}h; nothing from {', '.join(brief['quiet']) or 'none'}; "
          f"NATO: {len(brief['nato']['items'])} item(s)")
    with open(AUTHORITIES_PATH, "w", encoding="utf-8") as f:
        json.dump(brief, f, ensure_ascii=False, indent=1)
    from app_sync import push_authorities
    push_authorities(brief)
    print("Authorities done.\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    run(ap.parse_args().dry_run)
