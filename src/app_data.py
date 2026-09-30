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
        if "thread_id" in ev and (thread_ids is None or ev["thread_id"] not in thread_ids):
            ev["thread_id"] = None

        articles = ev.get("articles") or parse_sources(ev.get("sources", ""))
        clean = []
        for a in articles:
            outlet = (a.get("outlet") or "").strip()
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
     "known_sv": ["..."], "unknown_sv": ["..."], "thread_id": "...",
     "articles": [{"outlet": "...", "title": "...", "url": "...", "tier": 1,
                   "published": "...", "summary_sv": "...", "relation": "..."}]}"""
