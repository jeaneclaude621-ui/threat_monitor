"""
Finds freely licensed Commons photos for bases (and systems without one)
in the forces database: the lead image of the entry's Wikipedia article,
kept only when Commons gives CC0, CC BY, CC BY-SA or public domain, with
author and file page. Saved as webapp/public/forces/img/base-<id>.jpg,
about 640 px wide and under 80 KB.

    python3 src/forces_db_images.py bases|systems [id,id,...] [--dry-run]
    python3 src/forces_db_images.py job      # the weekly job (schedule/run_job.py forces_images)

By hand, every picked image is looked at before it is committed: the
script cannot tell a base from a town square or a badge. The weekly job
cannot look, so it takes an image only when the file name or its Commons
description speaks of an airfield, a base, a port, an aircraft or a ship
(PLACE_OR_CRAFT), adds at most JOB_LIMIT a run, stops at the first 429 from
Wikimedia, and lists what it added in its log for review afterwards.
"""
import html
import io
import json
import re
import sys
import urllib.parse
from pathlib import Path

from PIL import Image

from forces_fetch import get, get_json


def api(url, params):
    """A MediaWiki API call sent as POST: long title lists do not fit a URL."""
    return get_json(url, data=urllib.parse.urlencode(params))

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "config" / "forces_db"
IMG = ROOT / "webapp" / "public" / "forces" / "img"
FREE = re.compile(r"^(CC0|CC BY(-SA)? \d|CC BY(-SA)?$|Public domain|PD)", re.I)
# No logos, maps, flags, emblems or diagrams: a photograph of the place or thing.
NOT_PHOTO = re.compile(r"(logo|emblem|insignia|flag|map|locator|coat.of.arms|герб|эмблема|знак|карта|схема|diagram|\.svg$|\.png$|icon|patch|нарукав)", re.I)
MAX_BYTES = 80_000
JOB_LIMIT = 15
_stopped = []    # set when Wikimedia answered 429: the unattended job ends
# What an image must show for the unattended job to take it.
PLACE_OR_CRAFT = re.compile(
    r"(air ?field|air ?base|airport|aerodrome|naval base|harbou?r|\bport\b|pier|aircraft|airplane|plane|jet|bomber|fighter|"
    r"helicopter|ship|vessel|frigate|corvette|cruiser|destroyer|submarine|"
    r"аэродром|аэропорт|авиабаз|военно-морск|гаван|порт|причал|самол[её]т|вертол[её]т|корабл|судно|фрегат|корвет|крейсер|эсминец|подводн|"
    r"flygfält|flygplats|flygbas|hamn|flygplan|fartyg|ubåt|"
    r"\b(Su|Tu|MiG|Il|An|Ka|Mi|Be|Yak)-\d)", re.I)


def strip(text):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", text or ""))).strip()


def page_images(lang, titles):
    """{title: Commons file name} for the articles' lead images."""
    out = {}
    for i in range(0, len(titles), 40):
        chunk = titles[i:i + 40]
        j = api(f"https://{lang}.wikipedia.org/w/api.php", {
            "action": "query", "titles": "|".join(chunk), "prop": "pageimages", "piprop": "name",
            "pilicense": "free", "pilimit": 50, "format": "json", "formatversion": 2, "redirects": 1})
        q = j.get("query", {})
        back = {}
        for k in ("normalized", "redirects"):
            for r in q.get(k, []):
                back[r["to"]] = back.get(r["from"], r["from"])
        for pg in q.get("pages", []):
            if pg.get("pageimage"):
                t = back.get(pg["title"], pg["title"])
                out[back.get(t, t)] = pg["pageimage"]
    return out


def file_info(names):
    """{file name: (thumb url, author, licence, licence url, file page)} for free files."""
    out = {}
    names = list(dict.fromkeys(names))
    for i in range(0, len(names), 40):
        chunk = ["File:" + n for n in names[i:i + 40]]
        j = api("https://commons.wikimedia.org/w/api.php", {
            "action": "query", "titles": "|".join(chunk), "prop": "imageinfo", "iiprop": "url|extmetadata|mime",
            "iiurlwidth": 960, "format": "json", "formatversion": 2})
        for pg in j.get("query", {}).get("pages", []):
            ii = (pg.get("imageinfo") or [None])[0]
            if not ii or ii.get("mime") not in ("image/jpeg", "image/webp", "image/tiff"):
                continue
            md = ii.get("extmetadata") or {}
            lic = strip((md.get("LicenseShortName") or {}).get("value"))
            author = strip((md.get("Artist") or {}).get("value"))[:120]
            if not FREE.match(lic) or not author or "nonfree" in (md.get("NonFree") or {}).get("value", "").lower():
                continue
            name = pg["title"].split(":", 1)[1]
            # Thumbnails are served from thumb.wikimedia.org now; the same path
            # works on upload.wikimedia.org, which the network allows.
            thumb = re.sub(r"^https://thumb\.wikimedia\.org/", "https://upload.wikimedia.org/", (ii.get("thumburl") or ii["url"]).split("?")[0])
            out[name] = (thumb, author, lic, (md.get("LicenseUrl") or {}).get("value"),
                         "https://commons.wikimedia.org/wiki/" + urllib.parse.quote("File:" + name.replace(" ", "_")),
                         strip((md.get("ImageDescription") or {}).get("value"))[:500])
    return out


def save_jpeg(raw, path):
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.width > 640:
        im = im.resize((640, round(im.height * 640 / im.width)), Image.LANCZOS)
    for q in (80, 72, 64, 56, 48, 40):
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
        if buf.tell() < MAX_BYTES:
            path.write_bytes(buf.getvalue())
            return True
    im = im.resize((480, round(im.height * 480 / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=60, optimize=True, progressive=True)
    if buf.tell() < MAX_BYTES:
        path.write_bytes(buf.getvalue())
        return True
    return False


def wiki_titles(entry):
    out = []
    for s in entry.get("sources") or []:
        m = re.match(r"https://(en|ru)\.wikipedia\.org/wiki/(.+)", s["url"])
        if m:
            out.append((m[1], urllib.parse.unquote(m[2]).replace("_", " ")))
    out.sort(key=lambda t: t[0] != "en")
    return out


def main(kind, dry, only=None, limit=None, unattended=False):
    """Adds images to bases or systems without one; returns [(id, file, licence, author)].
    unattended: the weekly job's rules (PLACE_OR_CRAFT, stop at a 429)."""
    name = "bases" if kind == "bases" else "systems"
    data = json.load(open(DB / f"{name}.json", encoding="utf-8"))
    # Ask the APIs about every entry without an image (the same questions as a
    # dry run, so a rerun reads them from the cache) and pick afterwards.
    rows = [r for r in data[name] if not r.get("image")]
    want = {"en": set(), "ru": set()}
    for r in rows:
        for lang, t in wiki_titles(r):
            want[lang].add(t)
    lead = {lang: page_images(lang, sorted(ts)) for lang, ts in want.items()}
    cand = {}
    for r in rows:
        for lang, t in wiki_titles(r):
            f = lead[lang].get(t)
            if f and not NOT_PHOTO.search(f):
                cand.setdefault(r["id"], []).append(f)
    info = file_info([f for fs in cand.values() for f in fs])
    prefix = "base" if kind == "bases" else "sys"
    added = []
    for r in rows:
        if only is not None and r["id"] not in only:
            continue
        if limit is not None and len(added) >= limit:
            break
        f = next((f for f in cand.get(r["id"], []) if f in info
                  and (not unattended or PLACE_OR_CRAFT.search(f + " " + info[f][5]))), None)
        if not f:
            continue
        thumb, author, lic, lic_url, page, _desc = info[f]
        out = IMG / f"{prefix}-{r['id']}.jpg"
        print(r["id"], "<-", f, "|", lic, "|", author[:40])
        if dry:
            continue
        try:
            raw = get(thumb, binary=True)
        except Exception as e:
            print("  ! download", type(e).__name__, str(e)[:120])
            if unattended and "429" in str(e):
                print("  ! Wikimedia answers 429: the job stops here and tries again next week")
                _stopped.append(True)
                break
            continue
        if not save_jpeg(raw, out):
            print("  ! too large")
            continue
        r["image"] = {"file": out.name, "commons_file": "File:" + f, "author": author, "license": lic,
                      "license_url": lic_url, "source_url": page}
        added.append((r["id"], f, lic, author))
        if not dry:  # save as we go: a slow download must not lose the rest
            (DB / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    if not dry:
        (DB / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(added)} images added of {len(rows)} {name} without one")
    return added


def job():
    """The weekly image job: bases first, then systems, JOB_LIMIT in all."""
    import os
    os.environ.setdefault("FORCES_TRIES", "3")      # a 429 ends the run quickly instead of waiting it out
    added = []
    for kind in ("bases", "systems"):
        try:
            added += main(kind, False, limit=JOB_LIMIT - len(added), unattended=True)
        except Exception as e:
            print(f"  ! Forces images ({kind}): {type(e).__name__}: {str(e)[:160]}")
            break
        if len(added) >= JOB_LIMIT or _stopped:
            break
    if added:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import forces
        forces.export_db()
        print("Added this run, to be looked at (webapp/public/forces/img):")
        for rid, f, lic, author in added:
            print(f"  {rid}: {f} | {lic} | {author[:60]}")
    else:
        print("Forces images: nothing new this week")


if __name__ == "__main__":
    if sys.argv[1] == "job":
        job()
    else:
        only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
        main(sys.argv[1], "--dry-run" in sys.argv, only=only)
