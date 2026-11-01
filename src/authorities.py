"""
What the Swedish authorities say: Försvarsmakten, MUST, MCF, the
Government, the Police, Säpo, Tullverket and Kustbevakningen - on the
situation overall, and the last 24 hours. Runs at 07:00 and 17:00
Stockholm.

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

One Gemini call a run.

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
    return out


def summarise(material: dict, now: datetime) -> dict:
    refs, blocks = {}, []
    for name, items in material.items():
        lines = []
        for a in items:
            ref = f"A{len(refs) + 1}"
            refs[ref] = (name, a)
            source = name if a["own"] else _outlet(a)
            lines.append(f"[{ref}] {a['published']:%Y-%m-%d %H:%M} · {source} · {a['title']}"
                         + (f" - {a['summary'][:300]}" if a.get("summary") and a["summary"] != a["title"] else ""))
        blocks.append(f"=== {name}\n" + ("\n".join(lines) or "(nothing found)"))
    prompt = f"""It is {now:%Y-%m-%d %H:%M} in Stockholm. Below is what was published in the
last {WINDOW_DAYS} days by or about Swedish authorities, grouped by authority: their own
channels, and Swedish media reporting what they say. Each item has a ref.

{chr(10).join(blocks)}

Write a short brief, in natural Swedish, of what these authorities say
about the security situation - Russia, hybrid threats, defence, espionage,
sabotage, preparedness, the Baltic Sea:

- "overall_sv": 3-5 sentences on the situation as the authorities describe
  it, from all of it together.
- "items": the things worth knowing, at most 3 per authority, newest
  first. Each: "agency" (exactly one of the names above), "refs" (the refs
  it rests on), "text_sv" (one or two sentences, max ~40 words: who said or
  did what). Write what the authority says or does; when it rests on media,
  write it as reported ("enligt TV4"), never stronger than the source.
  Give a person's title or role only as the items state it, never from
  your own knowledge; when unsure, give the name alone. Put an item under
  the authority it is really about, not under the query that found it.
  Prefer established Swedish media over aggregator and content-farm sites.

Leave out: job ads, routine and local matters unrelated to security,
items about other countries' authorities, and anything that is an old
story republished (e.g. events from 2022 or earlier). An authority with
nothing worth knowing gets no items.

Respond as strict JSON:
{{"overall_sv": "...", "items": [{{"agency": "...", "refs": ["A1"], "text_sv": "..."}}]}}"""
    result = ask_model_json(prompt, system="You brief a Swedish security analysis team on what Swedish "
                            "authorities say. Strict JSON only.", max_tokens=4000)
    names = [a[0] for a in AGENCIES]
    items = []
    for it in result.get("items") or []:
        cited = [refs[r] for r in it.get("refs") or [] if r in refs]
        if it.get("agency") not in names or not cited or not isinstance(it.get("text_sv"), str):
            continue
        # Under the authority its sources were found for, not where the
        # model put it (1 Nov: Försvarsmakten's warning filed under MUST).
        groups = [g for g, _ in cited]
        if it["agency"] not in groups:
            it["agency"] = max(set(groups), key=groups.count)
        newest = max(a["published"] for _, a in cited)
        media = sorted({_outlet(a) for _, a in cited if not a["own"]})
        link = next((a.get("link") for _, a in cited if a["own"]), None) or cited[0][1].get("link")
        if link and "news.google.com/rss/articles/" in link:
            link = news_sources.decode_google_link(link)
        items.append({
            "agency": it["agency"], "text_sv": it["text_sv"].strip(),
            "via": (", ".join(media[:-1]) + " och " + media[-1] if len(media) > 1 else media[0])
                   if media and not any(a["own"] for _, a in cited) else None,
            "date": f"{newest:%Y-%m-%d}", "url": link if link and link.startswith("https://") else None,
            "fresh": newest >= now - timedelta(hours=FRESH_HOURS),
        })
    # Agencies in their order above, each newest first.
    items.sort(key=lambda i: i["date"], reverse=True)
    items.sort(key=lambda i: names.index(i["agency"]))
    return {
        "generated_at": now.astimezone().isoformat(timespec="seconds"),
        "overall_sv": result.get("overall_sv"),
        "items": items,
        "quiet": [n for n in names if not any(i["agency"] == n for i in items)],
        "found": {n: len(v) for n, v in material.items()},
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
          f"{FRESH_HOURS}h; nothing from {', '.join(brief['quiet']) or 'none'}")
    with open(AUTHORITIES_PATH, "w", encoding="utf-8") as f:
        json.dump(brief, f, ensure_ascii=False, indent=1)
    from app_sync import push_authorities
    push_authorities(brief)
    print("Authorities done.\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    run(ap.parse_args().dry_run)
