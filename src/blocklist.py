"""
The one list of what is never a source for the analysis: Telegram,
Russian state media and the pro-Kremlin network around them - and what is
not news on its own (video and social posts).

Checked on the host name of the link AND on the publisher's name, since a
Google News link goes to news.google.com and only its "source" names the
outlet, while GDELT gives the outlet as a bare domain. news_sources.Pool.add
applies it, so it covers every way in: the feeds, Google News, GDELT, the
app's sources, Forces and Strikes. forces_db_check uses it for the
foundation database.

    blocked(url, outlet)   -> True for Telegram / state media / pro-Kremlin
    is_news({"url", "outlet"}) -> False for YouTube, X, Facebook ...
"""
import re
from urllib.parse import urlsplit

# Host names; a host matches itself and its subdomains.
BLOCKED_HOSTS = (
    # Telegram
    "t.me", "telegram.me", "telegram.org", "telegra.ph", "telesco.pe",
    # State agencies, TV and papers
    "tass.ru", "tass.com", "rt.com", "ria.ru", "sputniknews.com", "sputniknews.ru", "sputnikglobe.com",
    "sputnik.by", "sputnik.kz", "sputniknews.cn", "iz.ru", "tvzvezda.ru", "rg.ru", "1tv.ru", "1tv.com",
    "vesti.ru", "smotrim.ru", "ren.tv", "ntv.ru",
    # Pro-Kremlin outlets
    "lenta.ru", "gazeta.ru", "kp.ru", "aif.ru", "ukraina.ru", "kommersant.ru", "kommersant.com",
    "interfax.ru", "interfax.com", "pravda.ru", "news-front.info", "news-front.su",
    "southfront.org", "southfront.press", "rubaltic.ru", "baltnews.com", "eadaily.com", "regnum.ru",
    "inosmi.ru", "rusvesna.su", "tsargrad.tv", "topwar.ru", "reseauinternational.net",
    # The "Pravda" network (Portal Kombat): news-pravda.com and its language sites
    "news-pravda.com", "pravda-en.com", "pravda-fr.com", "pravda-de.com", "pravda-es.com", "pravda-pl.com",
    "pravda-fi.com", "pravda-se.com", "pravda-nl.com", "pravda-it.com", "pravda-pt.com",
)
# pravda-xx.com for any language code, and their subdomains.
PORTAL_KOMBAT = re.compile(r"(^|\.)pravda-[a-z]{2,3}\.com$")
# Never blocked although they look alike: Ukrainska Pravda, Interfax-Ukraine.
ALLOWED_HOSTS = ("pravda.com.ua", "interfax.com.ua")

# Publisher names as Google News and the feeds give them; matched against
# the whole name (case-insensitive), so "Art Daily" is not "RT".
BLOCKED_OUTLETS = re.compile(r"""^(?:the\s+)?(?:
    tass(?:\s+news\s+agency)?|тасс|itar[-\s]tass
  | rt(?:\s+(?:news|international|en\s+español|en\s+espanol|france|deutsch|arabic|on\s+rumble))?|russia\s+today|rt\.com
  | ria(?:\s+novosti)?|риа\s+новости|ria\.ru
  | sputnik(?:\s+(?:news|international|globe|india|africa|brasil|mundo|international))?|sputnikglobe(?:\.com)?
  | izvestia|известия|iz\.ru
  | zvezda|tv\s*zvezda|звезда
  | rossiyskaya\s+gazeta|российская\s+газета|rg\.ru
  | channel\s+one(?:\s+russia)?|первый\s+канал|vesti(?:\.ru)?|вести|ntv\.ru|ren\s*tv
  | lenta\.ru|лента\.ру
  | gazeta\.ru|газета\.ру
  | komsomolskaya\s+pravda|комсомольская\s+правда|kp\.ru
  | argumenty\s+i\s+fakty|аргументы\s+и\s+факты|aif\.ru
  | ukraina\.ru|украина\.ру
  | kommersant(?:\.ru)?|коммерсантъ?
  | interfax(?:\.ru)?|интерфакс
  | pravda\.ru|pravda\s+(?:en|fr|de|es|pl|fi|se|nl|it|pt)|news[-\s]pravda(?:\.com)?|portal\s+kombat
  | news\s*front|news-front(?:\.info)?
  | south\s*front|inosmi|eadaily|regnum|tsargrad|rubaltic|baltnews
  | telegram|t\.me
)$""", re.I | re.X)


def host(url: str) -> str:
    """The lower-case host of a URL (or of a bare domain), without www."""
    url = (url or "").strip()
    if not url:
        return ""
    if "//" not in url:
        url = "//" + url
    try:
        h = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return h.removeprefix("www.")


def blocked_host(url: str) -> bool:
    h = host(url)
    if not h or any(h == a or h.endswith("." + a) for a in ALLOWED_HOSTS):
        return False
    return bool(PORTAL_KOMBAT.search(h)) or any(h == b or h.endswith("." + b) for b in BLOCKED_HOSTS)


DOMAIN_LIKE = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$", re.I)


def blocked_outlet(name: str) -> bool:
    """A publisher's name, or a bare domain as GDELT gives it."""
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name:
        return False
    if DOMAIN_LIKE.match(name) and blocked_host(name):
        return True
    return bool(BLOCKED_OUTLETS.match(name))


def blocked(url: str = None, outlet: str = None) -> bool:
    """Telegram, Russian state media or the pro-Kremlin network, by link or by name."""
    return blocked_host(url) or blocked_outlet(outlet)


def blocked_item(item: dict) -> bool:
    """For an article as the sources give it ({link, source}) or as stored ({url, outlet})."""
    return blocked(item.get("link") or item.get("url"), item.get("source") or item.get("outlet"))


# Not news: video and social posts. They may stand beside a news source
# but never alone - not in the daily report, not in Forces.
NOT_NEWS = re.compile(r"(youtube|youtu\.be|\bx\.com|twitter|facebook|\bfb\.watch|instagram|tiktok|telegram|\bt\.me\b|"
                      r"reddit|\bvk\.com|vkontakte|rumble|odysee|threads\.net|bsky\.app|bluesky|truthsocial|"
                      r"truth social|mastodon|linkedin|\bok\.ru|dzen\.ru)", re.I)


def is_news(src: dict) -> bool:
    """False for video and social posts; reads the outlet and the link."""
    return not NOT_NEWS.search(f"{src.get('outlet') or src.get('source') or ''} "
                               f"{src.get('url') or src.get('link') or ''}")
