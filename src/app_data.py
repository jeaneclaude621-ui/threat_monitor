"""
Shapes the report's events for the web app - ids, articles with links,
topics and countries - per webapp/CONTRACT.md.

The model supplies the Swedish text, topics, countries and article list;
this module assigns the ids and keeps only article links that the
web search really retrieved (common.LAST_SEARCH_RESULTS).
"""
import hashlib
import re
from urllib.parse import urlsplit, urlunsplit

TOPICS = ["Drönare", "Sabotage", "IT-hot", "Skuggflotta", "Sanktioner",
          "Diplomati", "Arktis", "Desinformation", "Kinetiskt"]

TIER_RE = re.compile(r"tier\s*([1-4])", re.IGNORECASE)

# One name per outlet, so the operator's verdicts on "AP" and "Associated
# Press" count as verdicts on the same outlet. Keys are lower-case variants.
OUTLET_ALIASES = {
    "associated press": "AP", "ap news": "AP", "the associated press": "AP",
    "the guardian": "Guardian", "guardian": "Guardian",
    "deutsche welle": "DW", "dw news": "DW",
    "rfe/rl": "RFE/RL", "rferl": "RFE/RL", "radio free europe/radio liberty": "RFE/RL",
    "radio free europe": "RFE/RL",
    "euromaidanpress": "Euromaidan Press", "euromaidan press": "Euromaidan Press",
    "mezha.net": "Mezha", "mezha": "Mezha",
    "ua.news": "UA News", "ua news": "UA News",
    "stars and stripes": "Stars & Stripes", "stars & stripes": "Stars & Stripes",
    "fox news digital": "Fox News", "fox news": "Fox News",
    "us news & world report": "US News", "us news": "US News", "u.s. news": "US News",
    "militarnyi.com": "Militarnyi", "militarnyi": "Militarnyi",
    "nato": "NATO", "nato.int": "NATO",
    "reuters": "Reuters", "bbc": "BBC", "bbc news": "BBC", "afp": "AFP", "agence france-presse": "AFP",
    "the washington post": "Washington Post", "washington post": "Washington Post",
    "the new york times": "New York Times", "new york times": "New York Times", "nyt": "New York Times",
    "the moscow times": "Moscow Times", "moscow times": "Moscow Times",
    "the kyiv independent": "Kyiv Independent", "kyiv independent": "Kyiv Independent",
    "the kyiv post": "Kyiv Post", "kyiv post": "Kyiv Post",
    "ukrainska pravda": "Ukrainska Pravda", "ukraine pravda": "Ukrainska Pravda", "pravda.com.ua": "Ukrainska Pravda",
    "politico europe": "Politico", "politico": "Politico",
    "the war zone": "The War Zone", "twz": "The War Zone",
    "defence news": "Defense News", "defense news": "Defense News",
    "estonian world": "Estonian World", "err news": "ERR", "err": "ERR",
    "tvp world": "TVP World", "pbs newshour": "PBS NewsHour", "pbs": "PBS NewsHour",
    # Named Swedish sources (methodology.named_sources)
    "cornucopia": "Cornucopia?", "cornucopia?": "Cornucopia?", "cornucopia.se": "Cornucopia?",
    "lars wilderäng": "Cornucopia?", "wilderäng": "Cornucopia?",
    "svt nyheter": "SVT", "svt": "SVT", "sveriges television": "SVT",
    "sveriges radio": "Sveriges Radio", "ekot": "Sveriges Radio", "sr ekot": "Sveriges Radio", "sr": "Sveriges Radio",
    "dagens nyheter": "DN", "dn": "DN", "svenska dagbladet": "SvD", "svd": "SvD",
    "tt nyhetsbyrån": "TT", "tt": "TT", "försvarsmakten": "Försvarsmakten", "swedish armed forces": "Försvarsmakten",
    "foi": "FOI", "totalförsvarets forskningsinstitut": "FOI", "säpo": "Säkerhetspolisen",
    "säkerhetspolisen": "Säkerhetspolisen", "swedish security service": "Säkerhetspolisen",
}


def canonical_outlet(name: str) -> str:
    """The one display name for an outlet. Unknown names pass through
    trimmed, so nothing is lost - only known variants are merged."""
    name = re.sub(r"\s+", " ", (name or "").strip())
    # "Meduza (relay of The Atlantic)": the aside is not part of the name.
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name) or name
    key = name.lower()
    if key in OUTLET_ALIASES:
        return OUTLET_ALIASES[key]
    # "Reuters / US News" and "NBC News / AP": the first-named publisher.
    if " / " in name:
        return canonical_outlet(name.split(" / ", 1)[0])
    return name


def article_id(report_date: str, event_index: int, outlet: str, url: str = None) -> str:
    key = url if url else f"{report_date}|{event_index}|{outlet}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _norm_url(url: str) -> str:
    """Scheme, host (no www) and path without trailing slash - enough to
    match a link the model repeats against the one search returned."""
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return ""
    host = p.netloc.lower().removeprefix("www.")
    return urlunsplit(("https", host, p.path.rstrip("/"), p.query, ""))


def parse_sources(sources: str) -> list:
    """Outlets from the free-text sources line, e.g.
    'Reuters (Tier 1, 28 Sep); Kyiv Independent (Tier 3)'."""
    out = []
    for part in re.split(r";|\n", sources or ""):
        part = part.strip()
        if not part:
            continue
        outlet = re.split(r"\s+\(|\s+[—–-]\s+", part, maxsplit=1)[0].strip(" .")
        # Assessments and asides in the sources line are not outlets.
        if (not outlet or len(outlet) > 60 or not outlet[0].isupper()
                or re.search(r"=|\)|\bcit(?:ing|ed)\b|confirm|corroborat|flagged", outlet, re.IGNORECASE)):
            continue
        tier = TIER_RE.search(part)
        out.append({"outlet": outlet, "title": None, "url": None,
                    "tier": int(tier.group(1)) if tier else None})
    return out


DIRECTIONS = ("escalating", "de-escalating", "neutral")
RELATIONS = {"bekräftar", "motsäger", "tillför"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def enrich_events(events: list, report_date: str, search_results: list = None,
                  thread_ids: set = None) -> list:
    """Adds id, model_score, articles (with ids), and cleans topics and
    countries. `search_results` is the list of retrieved pages; article
    urls not among them are dropped. None means: no link check possible
    (backfill), so every url is dropped."""
    known = {_norm_url(r["url"]): r for r in (search_results or []) if r.get("url")}
    for i, ev in enumerate(events, start=1):
        ev["id"] = f"{report_date}-e{i}"
        ev.setdefault("model_score", ev.get("score"))
        ev["topics"] = [t for t in ev.get("topics") or [] if t in TOPICS]
        ev["countries"] = sorted({c.strip().upper() for c in ev.get("countries") or []
                                  if isinstance(c, str) and len(c.strip()) == 2})
        for key in ("known_sv", "unknown_sv"):
            if key in ev:
                ev[key] = [x for x in ev.get(key) or [] if isinstance(x, str) and x.strip()]
        if ev.get("direction") not in DIRECTIONS:
            ev["direction"] = "neutral"
        if "thread_id" in ev and (thread_ids is None or ev["thread_id"] not in thread_ids):
            ev["thread_id"] = None

        articles = ev.get("articles") or parse_sources(ev.get("sources", ""))
        clean = []
        for a in articles:
            outlet = canonical_outlet(a.get("outlet") or "")
            if not outlet:
                continue
            url = a.get("url")
            match = known.get(_norm_url(url)) if url else None
            url = match["url"] if match else None
            title = a.get("title") or (match or {}).get("title")
            tier = a.get("tier")
            item = {
                "id": article_id(report_date, i, outlet, url),
                "outlet": outlet,
                "title": title if url else a.get("title"),
                "url": url,
                "tier": tier if isinstance(tier, int) and 1 <= tier <= 4 else None,
            }
            if a.get("summary_sv"):
                item["summary_sv"] = a["summary_sv"]
            if isinstance(a.get("published"), str) and DATE_RE.match(a["published"]):
                item["published"] = a["published"]
            if a.get("relation") in RELATIONS:
                item["relation"] = a["relation"]
            clean.append(item)
        # Same article twice (same link, or same outlet without a link) -> once.
        seen = set()
        ev["articles"] = [a for a in clean if not (a["id"] in seen or seen.add(a["id"]))]
    return events


SWEEP_EVENT_FIELDS = """Each event also carries, for the Swedish web app:
   - "title_sv": the title in natural Swedish (not translated English),
     max ~10 words;
   - "summary_sv": one or two Swedish sentences, max ~35 words;
   - "topics": one or more of """ + ", ".join(TOPICS) + """;
   - "countries": ISO 3166-1 alpha-2 codes of the countries where it
     happened or that it directly concerns (e.g. "EE", "RO", "UA");
   - "known_sv": 2-4 short Swedish sentences - what is established;
   - "unknown_sv": 1-3 short Swedish sentences - what is still unclear
     or unconfirmed;
   - "thread_id": the id of the watchlist thread it belongs to (listed
     below), or null;
   - "direction": "escalating" | "de-escalating" | "neutral" - which
     way the event, if true, pushes the general index;
   - "articles": the individual articles behind it, each
     {"outlet": "...", "title": "...", "url": "...", "tier": 1-4,
      "published": "YYYY-MM-DD or null",
      "summary_sv": "2-3 Swedish sentences: what this article says",
      "relation": "bekräftar" | "motsäger" | "tillför" | null - how it
      relates to the other articles on the event}. Give only urls you
     actually retrieved in this search - copy them exactly; use null when
     you do not have the article's own url."""

SWEEP_EVENT_JSON = """{"title": "...", "detail": "...", "sources": "...", "score": 0,
     "title_sv": "...", "summary_sv": "...", "topics": ["..."], "countries": ["..."],
     "known_sv": ["..."], "unknown_sv": ["..."], "thread_id": "...", "direction": "...",
     "articles": [{"outlet": "...", "title": "...", "url": "...", "tier": 1,
                   "published": "...", "summary_sv": "...", "relation": "..."}]}"""


FAVICON_DIR = None  # set lazily to data/favicons
FAVICON_MAX_BYTES = 6000


def _domain(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def add_favicons(report: dict) -> dict:
    """`favicons` {domain: data URI} for every linked article, so the app
    can show who published what without loading anything from the
    outlets themselves (the app's CSP allows data: images only). Fetched
    once per domain and cached in data/favicons/. Never raises."""
    import base64
    import urllib.request
    from common import DATA_DIR
    cache = DATA_DIR / "favicons"
    cache.mkdir(exist_ok=True)
    domains = {_domain(a["url"]) for e in report.get("events", []) for a in e.get("articles", []) if a.get("url")}
    icons = {}
    for d in sorted(x for x in domains if x):
        path = cache / f"{d}.png"
        if not path.exists():
            try:
                req = urllib.request.Request(f"https://www.google.com/s2/favicons?domain={d}&sz=64",
                                             headers={"User-Agent": "hotmonitor-mac/1"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = r.read(FAVICON_MAX_BYTES + 1)
                path.write_bytes(data if r.headers.get_content_type() == "image/png" else b"")
            except Exception:
                path.write_bytes(b"")          # remember the miss; the app shows a monogram
        data = path.read_bytes()
        if data and len(data) <= FAVICON_MAX_BYTES:
            icons[d] = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    report["favicons"] = icons
    return report
