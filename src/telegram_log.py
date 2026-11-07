"""
A log of public Telegram channels, for judging the channels themselves:
who posts what and when, who they forward, which of them copy each other,
and which report strikes first and get the place right.

Nothing here is a source for the analysis: Telegram stays blocked there
(src/blocklist.py). This only collects and counts; the counts are
indicators about a channel, never evidence about an event.

Collection (hourly, `python3 src/telegram_log.py`): each channel's public
web preview (t.me/s/<name>), paging back until the posts are older than
LOOKBACK_H or already logged. Every post is kept in
data/telegram/posts/<published UTC date>.jsonl: text (capped), views as
seen at several ages, whether it was forwarded and from whom, and whether
it carries its own photo or video. data/telegram/channels.json keeps each
channel's subscriber count per day and the last fetch. Days older than
KEEP_DAYS are deleted.

Figures (`python3 src/telegram_log.py stats`, also at the first run after
STATS_HOUR Stockholm): data/telegram/stats.json, per channel over the last
STATS_DAYS days - posting rhythm, forwarding, copied text, views, and the
strikes it mentioned against the strikes Hotmonitor knows from news
(data/forces.json) and the Ukrainian Air Force (data/strikes.json). Three
indicators of 0-10 come with what they are made of:
  bot_likeness   posting around the clock at an even pace, copied text,
                 views that hardly vary;
  firsthand      first or early on known strikes, with its own pictures;
  accuracy       of its strike posts naming a place, the share that match a
                 known strike there that day.
They are rough and say so in the app; a channel with few posts gets none.

    python3 src/telegram_log.py          # collect (and the figures when due)
    python3 src/telegram_log.py stats    # the figures now
    python3 src/telegram_log.py check    # which channels answer, saving nothing
"""
import hashlib
import html
import json
import re
import statistics
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR

TG_DIR = DATA_DIR / "telegram"
POSTS_DIR = TG_DIR / "posts"
CHANNELS_PATH = TG_DIR / "channels.json"
STATS_PATH = TG_DIR / "stats.json"
TIMEOUT = 20
UA = "Mozilla/5.0 (compatible; threat-monitor/1; +https://github.com/jeaneclaude621-ui/threat_monitor)"
LOOKBACK_H = 36        # how far back each run pages
MAX_PAGES = 6          # at most this many pages (about 20 posts each) per channel and run
KEEP_DAYS = 120
STATS_DAYS = 30
STATS_HOUR = 3         # Stockholm: the figures at the first run from 03:00
TEXT_CAP = 2000
VIEW_AGES = [1, 3, 6, 12, 24, 48, 96]   # hours: views recorded once past each age
MIN_POSTS = 30         # fewer posts in the period: no indicators

# Public channels with a web preview, by kind. "ua": Ukrainian official;
# "oberoende": independent Russian-language media. Run `check` after a change.
# Left out after the check of 7 Nov 2026: rt_russian and the border governors
# (vv_gladkov, Khinshtein, AV_Bogomaz) have no web preview; grey_zone and
# rusich_army have not posted since July.
CHANNELS = {
    "tass_agency": "stat", "mod_russia": "stat", "MID_Russia": "stat", "medvedev_telegram": "stat",
    "zvezdanews": "stat",
    "SolovievLive": "propaganda", "readovkanews": "propaganda", "mash": "propaganda", "shot_shot": "propaganda",
    "bazabazon": "propaganda",
    "rybar": "milblogg", "boris_rozhin": "milblogg", "wargonzo": "milblogg",
    "dva_majors": "milblogg", "voenkorKotenok": "milblogg", "RVvoenkor": "milblogg",
    "epoddubny": "milblogg", "sashakots": "milblogg", "voin_dv": "milblogg", "Sladkov_plus": "milblogg",
    "milinfolive": "milblogg", "mig41": "milblogg",
    "kpszsu": "ua",
    "astrapress": "oberoende", "supernova_plus": "oberoende", "exilenova_plus": "oberoende",
}

POST = re.compile(r'<div class="tgme_widget_message_wrap.*?(?=<div class="tgme_widget_message_wrap|\Z)', re.S)
ATTACK = re.compile(r"атак|удар|бпла|беспилотн|дрон|взрыв|прил[её]т|пожар|ракет|пво|сбит|сбил|обстрел|"
                    r"атак|вибух|ракет|збит|обстріл|шахед", re.I)

# Places in Russian (and Ukrainian) text, by stem, to a key shared with the
# strike data's English names. A post names a place when a stem starts a word.
PLACES = {
    "bryansk": ["брянск"], "kursk": ["курск"], "belgorod": ["белгород", "бєлгород"], "oryol": ["орл", "орёл", "орел"],
    "voronezh": ["воронеж"], "rostov": ["ростов"], "taganrog": ["таганрог"], "krasnodar": ["краснодар", "кубан"],
    "novorossiysk": ["новороссийск"], "tuapse": ["туапсе"], "crimea": ["крым", "крим"], "sevastopol": ["севастопол"],
    "saky": ["саки", "саках"], "dzhankoi": ["джанко"], "feodosia": ["феодоси"], "kerch": ["керч"],
    "moscow": ["москв", "подмосков"], "tula": ["тул"], "kaluga": ["калуг"], "smolensk": ["смоленск"],
    "lipetsk": ["липецк"], "tambov": ["тамбов"], "ryazan": ["рязан"], "saratov": ["саратов"], "engels": ["энгельс"],
    "volgograd": ["волгоград"], "astrakhan": ["астрахан"], "samara": ["самар", "сызран"], "penza": ["пенз"],
    "nizhny novgorod": ["нижегород", "нижнем новгород", "нижний новгород"], "yaroslavl": ["ярослав"], "tver": ["твер"], "pskov": ["псков"],
    "leningrad": ["ленинград", "петербург", "кириш", "усть-луг", "приморск"], "novgorod": ["новгород"],
    "tatarstan": ["татарстан", "казан", "елабуг"], "bashkortostan": ["башкир", "уф"], "orenburg": ["оренбург"],
    "chuvashia": ["чуваш", "чебоксар"], "ulyanovsk": ["ульяновск"], "perm": ["перм"], "murmansk": ["мурманск", "олень"],
    "kaliningrad": ["калининград"], "stavropol": ["ставропол"], "dagestan": ["дагестан", "махачкал"],
    "donetsk": ["донецк", "донеччин"], "luhansk": ["луганск", "луганщин"], "zaporizhzhia": ["запорож", "запоріж"],
    "kherson": ["херсон"], "kyiv": ["киев", "київ"], "kharkiv": ["харьков", "харків"], "odesa": ["одесс", "одес"],
    "dnipro": ["днепр", "дніпр"], "lviv": ["львов", "львів"], "sumy": ["сум"], "chernihiv": ["чернигов", "чернігів"],
    "poltava": ["полтав"], "mykolaiv": ["николаев", "миколаїв"], "vinnytsia": ["винниц", "вінниц"],
    "zhytomyr": ["житомир"], "rivne": ["ровн", "рівн"], "ivano-frankivsk": ["ивано-франков", "івано-франків"],
    "khmelnytskyi": ["хмельниц"], "kryvyi rih": ["кривой рог", "кривий ріг", "кривом рог"],
}
# The longer stems first, so "нижн" does not hide "нижегород"; very short
# stems ("уф", "сум", "тул", "орл") must be the whole beginning of a word.
_STEMS = sorted(((s, k) for k, ss in PLACES.items() for s in ss), key=lambda x: -len(x[0]))
_WORD = re.compile(r"[а-яёіїєґa-z\-]+", re.I)


# Words that start like a place and are not one ("сумма", "тулуп").
_NOT_PLACE = re.compile(r"^(сумм|тулуп|уфолог|орлан)")


def places_in(text: str) -> set:
    t = (text or "").lower()
    found = {k for k in ("nizhny novgorod", "kryvyi rih") if any(s in t for s in PLACES[k])}
    words = [w for w in _WORD.findall(t) if not _NOT_PLACE.match(w)]
    for w in words:
        for stem, key in _STEMS:
            if w.startswith(stem) and (len(stem) > 3 or len(w) - len(stem) <= 4):
                found.add(key)
                break
    if "nizhny novgorod" in found and not re.search(r"(?<!нижний )(?<!нижнем )(?<!нижнего )новгород", t):
        found.discard("novgorod")
    return found


def place_key(name: str) -> str:
    """The strike data's English or Swedish place name to a PLACES key, or None."""
    n = (name or "").lower()
    for key in sorted(PLACES, key=len, reverse=True):
        if key in n:
            return key
    alias = {"orjol": "oryol", "orel": "oryol", "brjansk": "bryansk", "voronezj": "voronezh", "saporizjzja": "zaporizhzhia",
             "krim": "crimea", "sevastopol": "sevastopol", "novorossijsk": "novorossiysk", "rjazan": "ryazan",
             "tatarstan": "tatarstan", "basjkortostan": "bashkortostan", "kiev": "kyiv", "charkiv": "kharkiv",
             "odessa": "odesa", "dnipropetrovsk": "dnipro", "luhansk": "luhansk", "donetsk": "donetsk",
             "leningrad": "leningrad", "st petersburg": "leningrad", "sankt petersburg": "leningrad"}
    for a, key in alias.items():
        if a in n:
            return key
    return None


# --------------------------------------------------------------------------
# Collection
# --------------------------------------------------------------------------
def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read().decode("utf-8", "replace")


def _num(text: str) -> int:
    m = re.match(r"([\d.,]+)\s*([KM]?)", (text or "").strip().replace(" ", ""))
    if not m:
        return 0
    return int(float(m.group(1).replace(",", ".")) * {"": 1, "K": 1_000, "M": 1_000_000}[m.group(2)])


def _iso(dt) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clean(fragment: str) -> str:
    text = html.unescape(re.sub(r"<br\s*/?>", "\n", fragment))
    return re.sub(r"<[^>]+>", "", text).strip()


def parse_page(page: str) -> tuple:
    """(subscribers or None, [post]) from one t.me/s page."""
    subs = None
    m = re.search(r'<span class="counter_value">([^<]+)</span>\s*<span class="counter_type">(subscribers|подписчик)', page)
    if m:
        subs = _num(m.group(1))
    posts = []
    for block in POST.findall(page):
        pid = re.search(r'data-post="([^"]+)"', block)
        when = re.search(r'<time datetime="([^"]+)"', block)
        if not (pid and when):
            continue
        views = re.search(r'tgme_widget_message_views">([^<]+)<', block)
        body = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', block, re.S)
        fwd = re.search(r'tgme_widget_message_forwarded_from_name"(?:\s+href="https://t\.me/([^"/?]+)[^"]*")?[^>]*>(.*?)</', block, re.S)
        reply = re.search(r'tgme_widget_message_reply"[^>]*href="https://t\.me/([^"/?]+)/(\d+)', block)
        posts.append({
            "id": pid.group(1),
            "published": _iso(datetime.fromisoformat(when.group(1))),
            "views": _num(views.group(1)) if views else None,
            "text": _clean(body.group(1))[:TEXT_CAP] if body else "",
            "fwd_from": (fwd.group(1) or _clean(fwd.group(2)))[:80] if fwd else None,
            "photo": "tgme_widget_message_photo_wrap" in block,
            "video": "tgme_widget_message_video" in block or "tgme_widget_message_roundvideo" in block,
            "reply_to": f"{reply.group(1)}/{reply.group(2)}" if reply else None,
            "edited": bool(re.search(r'class="tgme_widget_message_meta"[^>]*>.*?edited', block, re.S)),
        })
    return subs, posts


def fetch_channel(channel: str, known: set, now: datetime) -> tuple:
    """(subscribers, posts) of the last LOOKBACK_H hours, paging back."""
    subs, out, before = None, {}, None
    for _ in range(MAX_PAGES):
        url = f"https://t.me/s/{channel}" + (f"?before={before}" if before else "")
        s, posts = parse_page(_get(url))
        subs = subs or s
        if not posts:
            break
        for p in posts:
            out[p["id"]] = p
        oldest = min(posts, key=lambda p: int(p["id"].rsplit("/", 1)[1]))
        age_h = (now - datetime.fromisoformat(oldest["published"].replace("Z", "+00:00"))).total_seconds() / 3600
        if age_h > LOOKBACK_H or oldest["id"] in known:
            break
        before = int(oldest["id"].rsplit("/", 1)[1])
        time.sleep(1)
    return subs, list(out.values())


def _day_path(day: str) -> Path:
    return POSTS_DIR / f"{day}.jsonl"


def load_days(days: list) -> dict:
    """{post id: post} from the day files named."""
    out = {}
    for d in days:
        p = _day_path(d)
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    rec = json.loads(line)
                    out[rec["id"]] = rec
    return out


def save_days(posts: dict, days: list):
    by_day = defaultdict(list)
    for rec in posts.values():
        if rec["published"][:10] in days:
            by_day[rec["published"][:10]].append(rec)
    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    for d, recs in by_day.items():
        recs.sort(key=lambda r: (r["published"], r["id"]))
        _day_path(d).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs), encoding="utf-8")


def merge(old: dict, new: dict, channel: str, now: datetime) -> dict:
    """A post as logged: the first sight kept, the views recorded once past each age."""
    age = (now - datetime.fromisoformat(new["published"].replace("Z", "+00:00"))).total_seconds() / 3600
    rec = old or {"id": new["id"], "channel": channel, "kind": CHANNELS.get(channel), "published": new["published"],
                  "first_seen": _iso(now), "views_at": {}}
    for k in ("text", "fwd_from", "photo", "video", "reply_to", "edited"):
        rec[k] = new[k] if new[k] not in (None, "") or k not in rec else rec[k]
    rec["last_seen"] = _iso(now)
    if new["views"] is not None:
        rec["views"] = new["views"]
        for a in VIEW_AGES:
            if age >= a and str(a) not in rec["views_at"]:
                rec["views_at"][str(a)] = new["views"]
        if "first_views" not in rec:
            rec["first_views"] = [round(age, 1), new["views"]]
    return rec


def collect(now: datetime = None):
    now = now or datetime.now(timezone.utc)
    days = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(LOOKBACK_H // 24 + 2)]
    posts = load_days(days)
    TG_DIR.mkdir(parents=True, exist_ok=True)
    info = json.loads(CHANNELS_PATH.read_text(encoding="utf-8")) if CHANNELS_PATH.exists() else {}
    new_count, failed = 0, []
    for channel in CHANNELS:
        try:
            subs, got = fetch_channel(channel, set(posts), now)
        except Exception as e:
            failed.append(channel)
            print(f"  ! Telegram {channel}: {type(e).__name__}: {str(e)[:100]}")
            info.setdefault(channel, {})["last_error"] = f"{_iso(now)} {type(e).__name__}"
            continue
        c = info.setdefault(channel, {})
        c["kind"] = CHANNELS[channel]
        c["last_fetch"] = _iso(now)
        c.pop("last_error", None)
        if subs:
            c.setdefault("subscribers", {})[now.strftime("%Y-%m-%d")] = subs
        for p in got:
            if p["published"][:10] not in days:
                continue
            new_count += p["id"] not in posts
            posts[p["id"]] = merge(posts.get(p["id"]), p, channel, now)
        time.sleep(1)
    save_days(posts, days)
    CHANNELS_PATH.write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    prune(now)
    print(f"  Telegram: {len(CHANNELS) - len(failed)} of {len(CHANNELS)} channels read, {new_count} new posts"
          + (f"; failed: {', '.join(failed)}" if failed else ""))


def prune(now: datetime):
    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for p in POSTS_DIR.glob("*.jsonl"):
        if p.stem < cutoff:
            p.unlink()


def check():
    """Which channels answer with posts; nothing saved."""
    for channel in CHANNELS:
        try:
            subs, posts = parse_page(_get(f"https://t.me/s/{channel}"))
            fwd = sum(1 for p in posts if p["fwd_from"])
            print(f"  {channel:20} {len(posts):3} posts  subscribers {subs or '?'}  forwarded {fwd}"
                  + (f"  newest {max(p['published'] for p in posts)}" if posts else "  ! no posts (no web preview?)"))
        except Exception as e:
            print(f"  {channel:20} ! {type(e).__name__}: {str(e)[:80]}")
        time.sleep(1)


# --------------------------------------------------------------------------
# Figures
# --------------------------------------------------------------------------
def _norm_text(text: str) -> str:
    t = re.sub(r"https?://\S+|@\w+|#\w+", " ", (text or "").lower())
    t = re.sub(r"[^\wа-яё ]+", " ", t)
    return " ".join(t.split()[:40])


def known_strikes(since: str) -> list:
    """[{date, key, source}] of strikes Hotmonitor knows: in Russia and the
    occupied areas from the news (data/forces.json), in Ukraine from the Air Force."""
    out = []
    try:
        f = json.loads((DATA_DIR / "forces.json").read_text(encoding="utf-8"))
        bases = {b["id"]: b for b in f.get("bases", [])}
        for n in f.get("nights", []):
            for o in n.get("other", []):
                key = place_key(f"{o.get('search_name', '')} {o.get('place', '')}")
                if key and o.get("date", "") >= since:
                    out.append({"date": o["date"], "key": key, "source": "nyheter", "fire": bool(o.get("firms"))})
            for a in n.get("attacks", []):
                b = bases.get(a.get("base")) or {}
                key = place_key(b.get("name", "")) or place_key(b.get("name_en", ""))
                if key and a.get("date", "") >= since:
                    out.append({"date": a["date"], "key": key, "source": "nyheter", "fire": bool(a.get("firms"))})
    except (OSError, ValueError):
        pass
    try:
        s = json.loads((DATA_DIR / "strikes.json").read_text(encoding="utf-8"))
        for d in s.get("days", []):
            if d["date"] < since:
                continue
            for r in d.get("rows", []):
                for t in r.get("to", []):
                    key = place_key(t.get("name", ""))
                    if key:
                        out.append({"date": d["date"], "key": key, "source": "flygvapnet", "fire": False})
    except (OSError, ValueError):
        pass
    seen, uniq = set(), []
    for e in out:
        if (e["date"], e["key"]) not in seen:
            seen.add((e["date"], e["key"]))
            uniq.append(e)
    return uniq


def _clamp(x: float) -> float:
    return round(max(0.0, min(10.0, x)), 1)


def stats(now: datetime = None) -> dict:
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=STATS_DAYS)).strftime("%Y-%m-%d")
    days = [(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(STATS_DAYS + 1)]
    posts = [p for p in load_days(days).values() if p["published"][:10] >= since]
    info = json.loads(CHANNELS_PATH.read_text(encoding="utf-8")) if CHANNELS_PATH.exists() else {}
    sthlm = ZoneInfo("Europe/Stockholm")
    when = lambda p: datetime.fromisoformat(p["published"].replace("Z", "+00:00"))  # noqa: E731

    # Copied text: the same opening (40 words, at least 12) in another
    # channel within six hours, forwards aside. The first to post it is the origin.
    groups = defaultdict(list)
    for p in posts:
        t = _norm_text(p.get("text"))
        if len(t.split()) >= 12 and not p.get("fwd_from"):
            groups[hashlib.sha1(t.encode()).hexdigest()].append(p)
    copied, origin = Counter(), Counter()
    for g in groups.values():
        chans = {p["channel"] for p in g}
        if len(chans) < 2:
            continue
        g.sort(key=when)
        first = g[0]
        origin[first["channel"]] += 1
        for p in g[1:]:
            if p["channel"] != first["channel"] and (when(p) - when(first)) <= timedelta(hours=6):
                copied[p["channel"]] += 1

    # Strikes: a post naming a place and an attack word is a strike post;
    # it matches a known strike at that place dated the same or the next day
    # (posts in the night come before the morning's date).
    events = known_strikes(since)
    by_key = defaultdict(list)
    for e in events:
        by_key[e["key"]].append(e)
    mentions = defaultdict(list)            # (date, key) -> [(time, channel, own media)]
    claims = defaultdict(lambda: [0, 0])    # channel -> [strike posts with a place, matched]
    for p in posts:
        text = p.get("text") or ""
        if not ATTACK.search(text):
            continue
        keys = places_in(text)
        if not keys:
            continue
        claims[p["channel"]][0] += 1
        t = when(p)
        hit = False
        for k in keys:
            for e in by_key.get(k, []):
                d = datetime.fromisoformat(e["date"]).replace(tzinfo=timezone.utc)
                if d - timedelta(hours=30) <= t <= d + timedelta(hours=36):
                    mentions[(e["date"], k)].append((t, p["channel"], bool(p.get("photo") or p.get("video")) and not p.get("fwd_from")))
                    hit = True
        claims[p["channel"]][1] += hit
    first_on, early_on, reported, own_media_on = Counter(), Counter(), Counter(), Counter()
    lead = defaultdict(list)
    for ev, ms in mentions.items():
        ms.sort()
        t0 = ms[0][0]
        seen = set()
        for t, ch, media in ms:
            if ch in seen:
                continue
            seen.add(ch)
            reported[ch] += 1
            lead[ch].append((t - t0).total_seconds() / 60)
            if ch == ms[0][1]:
                first_on[ch] += 1
            if (t - t0) <= timedelta(minutes=60):
                early_on[ch] += 1
            own_media_on[ch] += media

    out = {}
    for channel, kind in CHANNELS.items():
        mine = sorted((p for p in posts if p["channel"] == channel), key=when)
        n = len(mine)
        c = {"kind": kind, "posts": n, "days": STATS_DAYS}
        subs = (info.get(channel) or {}).get("subscribers") or {}
        if subs:
            c["subscribers"] = subs[max(subs)]
        if n:
            span_days = max(1.0, (when(mine[-1]) - when(mine[0])).total_seconds() / 86400)
            hours = Counter(when(p).astimezone(sthlm).hour for p in mine)
            gaps = [(when(b) - when(a)).total_seconds() / 60 for a, b in zip(mine, mine[1:])]
            views = [p["views"] for p in mine if p.get("views")]
            v24 = [p["views_at"]["24"] for p in mine if p.get("views_at", {}).get("24")]
            v1 = {p["id"]: p["views_at"]["1"] for p in mine if p.get("views_at", {}).get("1")}
            growth = [p["views_at"]["24"] / v1[p["id"]] for p in mine if p["id"] in v1 and p.get("views_at", {}).get("24")]
            fwd = Counter(p["fwd_from"] for p in mine if p.get("fwd_from"))
            own_media = sum(1 for p in mine if (p.get("photo") or p.get("video")) and not p.get("fwd_from"))
            c.update({
                "per_day": round(n / span_days, 1),
                "hours": [hours.get(h, 0) for h in range(24)],
                "night_share": round(sum(hours.get(h, 0) for h in range(1, 6)) / n, 2),
                "active_hours": sum(1 for h in range(24) if hours.get(h, 0) >= n / 24 * 0.5),
                "gap_cv": round(statistics.pstdev(gaps) / statistics.mean(gaps), 2) if len(gaps) > 5 and statistics.mean(gaps) else None,
                "forwarded_share": round(sum(fwd.values()) / n, 2),
                "top_forwarded": fwd.most_common(8),
                "own_media_share": round(own_media / n, 2),
                "copied": copied[channel], "copied_share": round(copied[channel] / n, 2), "origin_of_copies": origin[channel],
                "median_views": int(statistics.median(views)) if views else None,
                "views_cv": round(statistics.pstdev(v24) / statistics.mean(v24), 2) if len(v24) > 5 and statistics.mean(v24) else None,
                "views_growth_1_24h": round(statistics.median(growth), 2) if growth else None,
                "views_per_subscriber": round(statistics.median(views) / c["subscribers"], 3) if views and c.get("subscribers") else None,
                "strike_posts": claims[channel][0], "strike_posts_matched": claims[channel][1],
                "strikes_reported": reported[channel], "strikes_first": first_on[channel],
                "strikes_within_hour": early_on[channel], "strikes_own_media": own_media_on[channel],
                "median_lead_min": round(statistics.median(lead[channel])) if lead[channel] else None,
            })
            if n >= MIN_POSTS:
                c["indicators"] = indicators(c)
        out[channel] = c
    result = {"generated_at": _iso(now), "days": STATS_DAYS, "since": since, "posts": len(posts),
              "known_strikes": len(events), "strikes_mentioned": len(mentions), "channels": out}
    STATS_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  Telegram figures: {len(posts)} posts in {STATS_DAYS} days, {len(events)} known strikes, "
          f"{len(mentions)} of them mentioned")
    return result


def indicators(c: dict) -> dict:
    """The three 0-10 indicators and their parts (all rough)."""
    gap = c.get("gap_cv")
    bot_parts = {
        # A person sleeps: posting in 20+ of 24 hours, and at night, is machine-like.
        "dygnet_runt": _clamp((c["active_hours"] - 14) / 10 * 10) if c.get("active_hours") else 0,
        "natt": _clamp(c.get("night_share", 0) / 0.2 * 10),
        # Even gaps (low variation) are scheduled; people post in bursts (cv > 1).
        "jamn_takt": _clamp((1.0 - gap) / 0.6 * 10) if gap is not None else 0,
        "kopierad_text": _clamp(c.get("copied_share", 0) / 0.3 * 10),
        # Views that barely vary from post to post suggest bought views.
        "jamna_visningar": _clamp((0.5 - c["views_cv"]) / 0.4 * 10) if c.get("views_cv") is not None else 0,
    }
    reported = c.get("strikes_reported") or 0
    first_parts = {
        "forst": _clamp(c.get("strikes_first", 0) / reported * 10) if reported else 0,
        "inom_en_timme": _clamp(c.get("strikes_within_hour", 0) / reported * 10) if reported else 0,
        "egna_bilder": _clamp(c.get("strikes_own_media", 0) / reported * 10) if reported else 0,
    }
    claimed = c.get("strike_posts") or 0
    out = {
        "bot_likeness": {"value": _clamp(sum(bot_parts.values()) / len(bot_parts)), "parts": bot_parts},
        "firsthand": {"value": _clamp(sum(first_parts.values()) / len(first_parts)) if reported >= 3 else None,
                      "parts": first_parts, "strikes": reported},
        "accuracy": {"value": _clamp(c.get("strike_posts_matched", 0) / claimed * 10) if claimed >= 5 else None,
                     "strike_posts": claimed, "matched": c.get("strike_posts_matched", 0)},
    }
    return out


def due_for_stats(now: datetime) -> bool:
    if not STATS_PATH.exists():
        return True
    try:
        last = json.loads(STATS_PATH.read_text(encoding="utf-8")).get("generated_at", "")
    except ValueError:
        return True
    local = now.astimezone(ZoneInfo("Europe/Stockholm"))
    return local.hour >= STATS_HOUR and last[:10] < now.strftime("%Y-%m-%d")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "collect"
    if cmd == "check":
        check()
    elif cmd == "stats":
        stats()
    else:
        collect()
        if due_for_stats(datetime.now(timezone.utc)):
            stats()
