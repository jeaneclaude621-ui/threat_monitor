"""
Shapes the report's events for the web app - ids, articles with links,
topics and countries - per webapp/CONTRACT.md.

The model supplies the Swedish text, topics, countries and article list;
this module assigns the ids and keeps only articles the model cited by
the ref of an article it was really given (common.LAST_SEARCH_RESULTS);
an event with none of those is marked "unverified".
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


# --------------------------------------------------------------------------
# Independent origins (#12)
# --------------------------------------------------------------------------
# Agency copy credited in the title or opening text: "(AP) -", "Reuters
# reported", "(TT)". One agency text in twenty papers is one origin.
WIRE_CREDITS = [
    ("AP", re.compile(r"\(AP\)|\bAssociated Press\b|\bAP\s+[-—–]|[-—–]\s*AP\b|\bAP reported\b")),
    ("Reuters", re.compile(r"\bReuters\b")),
    ("AFP", re.compile(r"\bAFP\b|\bAgence France[- ]Presse\b")),
    ("TT", re.compile(r"\(TT\)|\bTT Nyhetsbyrån\b|/TT\b")),
    ("dpa", re.compile(r"\bdpa\b")),
    ("NTB", re.compile(r"\(NTB\)|\bNTB\b")),
    ("Ritzau", re.compile(r"\bRitzau\b")),
    ("STT", re.compile(r"\(STT\)|\bSTT\b")),
    ("PAP", re.compile(r"\(PAP\)|\bPAP\b")),
    ("ANP", re.compile(r"\(ANP\)|\bANP\b")),
    ("Bloomberg", re.compile(r"\(Bloomberg\)|\bBloomberg News\b")),
]
# Aggregators republish others' reporting; together they are one origin.
AGGREGATORS = re.compile(r"(^|\b)(msn|yahoo|devdiscourse|newsbreak|head ?topics|ground ?news|flipboard|newsnow|"
                         r"biztoc|opera news|news ?now|newsoftheworld|latestly|inkl)(\b|$)|"
                         r"(^|[./])(msn\.com|yahoo\.com|devdiscourse\.com|newsbreak\.com|headtopics\.com)", re.I)
TITLE_SAME = 0.6      # word overlap (Jaccard) at which two headlines are one text ...
TITLE_SAME_WORDS = 4  # ... and at least this many words in common


def _title_words(title: str) -> set:
    return {w for w in re.findall(r"\w+", (title or "").lower()) if len(w) > 2}


def independent_sources(articles: list) -> int:
    """How many independent origins the news articles have: the same
    outlet, the same agency text (credited, or with nearly the same
    headline) and every aggregator count once. Video and social posts
    count not at all. Each article is {outlet, url, title, text}."""
    import blocklist
    items = [a for a in articles if blocklist.is_news(a)]
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    keys = []
    for a in items:
        outlet = canonical_outlet(a.get("outlet") or "")
        where = f"{outlet} {a.get('url') or ''}"
        wire = next((w for w, rx in WIRE_CREDITS if w == outlet or rx.search(f"{a.get('title') or ''} "
                                                                                f"{a.get('text') or ''}")), None)
        keys.append({"outlet:" + outlet.lower(), "wire:" + wire if wire else None,
                     "aggregator" if AGGREGATORS.search(where) else None} - {None})
    words = [_title_words(a.get("title")) for a in items]
    for i in range(len(items)):
        for j in range(i):
            common = words[i] & words[j]
            same_title = (len(common) >= TITLE_SAME_WORDS
                          and len(common) / len(words[i] | words[j]) >= TITLE_SAME)
            if keys[i] & keys[j] or same_title:
                parent[find(i)] = find(j)
    return len({find(i) for i in range(len(items))})


# --------------------------------------------------------------------------
# Credibility in code (#2)
# --------------------------------------------------------------------------
CONFIG_DIR = None   # set lazily to config/
_TIERS = None


def _tier_tables() -> tuple:
    """({name lower: tier}, {domain: tier}) from config/feeds.json (feed
    names and sites), methodology.named_sources and config/outlet_tiers.json;
    the earlier one wins."""
    global _TIERS
    if _TIERS is None:
        import json
        from pathlib import Path
        cfg = CONFIG_DIR or Path(__file__).resolve().parent.parent / "config"
        names, domains = {}, {}

        def load(name):
            try:
                return json.loads((cfg / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}
        for f in load("feeds.json").get("feeds", []):
            if isinstance(f.get("tier"), int):
                names.setdefault(f["name"].lower(), f["tier"])
        for n in load("methodology.json").get("named_sources", []):
            if isinstance(n.get("tier"), int):
                names.setdefault(n["name"].lower(), n["tier"])
                domains.setdefault(n["domain"].lower(), n["tier"])
        table = load("outlet_tiers.json")
        for k, v in table.get("outlets", {}).items():
            names.setdefault(k.lower(), v)
        for k, v in table.get("domains", {}).items():
            domains.setdefault(k.lower(), v)
        _TIERS = (names, domains)
    return _TIERS


def source_tier(outlet: str = None, url: str = None, listed: str = None):
    """The tier (1-4) of an article from config, never from the model:
    by the name in the article list (a feed's name), the canonical outlet,
    then the site. None when unknown."""
    names, domains = _tier_tables()
    for name in (listed, outlet, canonical_outlet(listed or "")):
        if name and name.strip().lower() in names:
            return names[name.strip().lower()]
    host = _domain(url or "")
    while host:
        if host in domains:
            return domains[host]
        host = host.partition(".")[2] if host.count(".") > 1 else ""
    return None


def credibility_cap(articles: list, independent: int) -> tuple:
    """(cap, reason): the highest score the event's verified sources carry.
    1 independent source: at most 6, and at most 5 when it is tier 3-4 or
    of unknown tier; 7 or more needs two independent origins of which one
    tier 1-2; 9 or more needs three. No verified news source: at most 4."""
    import blocklist
    high = any(a.get("tier") in (1, 2) for a in articles if blocklist.is_news(a))
    if independent == 0:
        return 4, "ingen verifierad nyhetskälla: högst 4"
    if independent == 1:
        return (6, "en oberoende källa: högst 6") if high else \
               (5, "en oberoende källa på nivå 3-4: högst 5")
    if not high:
        return 6, "ingen källa på nivå 1-2: högst 6"
    if independent == 2:
        return 8, "två oberoende källor: högst 8 (9 kräver tre)"
    return 10, None


def apply_credibility(ev: dict) -> None:
    """The model's score is a proposal: it is held to the cap the sources
    carry. model_score keeps the proposal; score_capped_reason says why."""
    cap, reason = credibility_cap(ev.get("articles") or [], ev.get("independent_sources") or 0)
    score = ev.get("score")
    ev.pop("score_capped_reason", None)
    if isinstance(score, (int, float)) and not isinstance(score, bool) and score > cap:
        ev["score"] = cap
        ev["score_capped_reason"] = reason


def _outlet_for(a: dict, match: dict) -> str:
    """The outlet of a verified article: the name the article list gave,
    so the model cannot put "Reuters" on a Devdiscourse copy. The model's
    shorter name is used only when the list's name begins with it or
    contains it - "BBC" for the feed "BBC Europe", "Reuters" for GDELT's
    reuters.com - so verdicts on one outlet stay on one name."""
    listed = (match.get("outlet") or "").strip()
    model = canonical_outlet(a.get("outlet") or "")
    if not listed:
        return model
    canon = canonical_outlet(listed)
    m = re.sub(r"[^a-z0-9]", "", model.lower())
    full = re.sub(r"[^a-z0-9]", "", listed.lower())
    if m and m != re.sub(r"[^a-z0-9]", "", canon.lower()) and (full.startswith(m) or (len(m) >= 4 and m in full)):
        return model
    return canon


def enrich_events(events: list, report_date: str, search_results: list = None,
                  thread_ids: set = None) -> list:
    """Adds id, model_score, articles (with ids), and cleans topics and
    countries.

    `search_results` is the list of articles the model was given. Only an
    article cited by a "ref" (or url) in that list is kept, with the list's
    own link, title and outlet; an article the list does not have is left
    out, never shown unlinked. An event left with no verified article - or
    whose only verified articles are video or social posts
    (blocklist.is_news) - is kept but gets "unverified": true, which the
    app shows.

    None means: no link check possible (backfill of reports from before
    refs), so the articles are the outlets the model read off the old
    sources line, without links - and every such event is unverified."""
    from news_sources import decode_google_link
    import blocklist
    known = {_norm_url(r["url"]): r for r in (search_results or []) if r.get("url")}
    by_ref = {r["ref"]: r for r in (search_results or []) if r.get("ref") and r.get("url")}
    dropped = 0
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

        if search_results is None:
            ev["articles"] = _legacy_articles(ev, report_date, i)
            ev["unverified"] = True
            ev["independent_sources"] = 0
            continue

        # New reports: only the articles list, never the free-text sources line.
        clean, texts = [], {}
        for a in ev.get("articles") or []:
            if not isinstance(a, dict):
                continue
            ref = str(a.get("ref") or "").strip("[] ")
            match = by_ref.get(ref)
            if not match and a.get("url"):
                match = known.get(_norm_url(a["url"]))
            if not match or blocklist.blocked(match.get("url"), match.get("outlet")):
                dropped += 1
                continue
            outlet = _outlet_for(a, match)
            if not outlet:
                dropped += 1
                continue
            url = decode_google_link(match["url"])
            item = {
                "id": article_id(report_date, i, outlet, url),
                "outlet": outlet,
                "title": match.get("title") or a.get("title"),
                "url": url,
                # From config, not the model (#2).
                "tier": source_tier(outlet, url, match.get("outlet")),
            }
            if a.get("summary_sv"):
                item["summary_sv"] = a["summary_sv"]
            # The date is the article list's, never the model's (#13). An
            # undated article stands only when it was added in the app.
            if "published" in match:
                if match["published"]:
                    item["published"] = match["published"]
                elif match.get("via") != "app":
                    dropped += 1
                    continue
            elif isinstance(a.get("published"), str) and DATE_RE.match(a["published"]):
                item["published"] = a["published"]
            if a.get("relation") in RELATIONS:
                item["relation"] = a["relation"]
            clean.append(item)
            texts[item["id"]] = match.get("summary") or ""
        # Same article twice -> once.
        seen = set()
        ev["articles"] = [a for a in clean if not (a["id"] in seen or seen.add(a["id"]))]
        ev["independent_sources"] = independent_sources(
            [{**a, "text": texts.get(a["id"], "")} for a in ev["articles"]])
        apply_credibility(ev)
        # Video and social posts may stand beside a news source, never alone (#15).
        if any(blocklist.is_news(a) for a in ev["articles"]):
            ev.pop("unverified", None)
        else:
            ev["unverified"] = True
    if dropped:
        print(f"  Left out {dropped} cited article(s) not in the article list (no verified source)")
    unverified = sum(1 for e in events if e.get("unverified"))
    if unverified and search_results is not None:
        print(f"  {unverified} event(s) marked unverified: no verified news source")
    return events


def _legacy_articles(ev: dict, report_date: str, i: int) -> list:
    """Outlets without links, for reports from before refs (backfill)."""
    out, seen = [], set()
    for a in ev.get("articles") or parse_sources(ev.get("sources", "")):
        outlet = canonical_outlet((a or {}).get("outlet") or "")
        if not outlet or outlet in seen:
            continue
        seen.add(outlet)
        tier = a.get("tier")
        out.append({"id": article_id(report_date, i, outlet), "outlet": outlet, "title": a.get("title"),
                    "url": None, "tier": tier if isinstance(tier, int) and 1 <= tier <= 4 else None})
    return out


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
     {"ref": "A12", "outlet": "...", "title": "...", "tier": 1-4,
      "published": "YYYY-MM-DD or null",
      "summary_sv": "2-3 Swedish sentences: what this article says",
      "relation": "bekräftar" | "motsäger" | "tillför" | null - how it
      relates to the other articles on the event}. "ref" is the article's
     ref in the list above, copied exactly (e.g. "A12"); cite only
     articles from that list."""

SWEEP_EVENT_JSON = """{"title": "...", "detail": "...", "sources": "...", "score": 0,
     "title_sv": "...", "summary_sv": "...", "topics": ["..."], "countries": ["..."],
     "known_sv": ["..."], "unknown_sv": ["..."], "thread_id": "...", "direction": "...",
     "articles": [{"ref": "A1", "outlet": "...", "title": "...", "tier": 1,
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
