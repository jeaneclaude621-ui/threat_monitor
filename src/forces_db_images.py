"""
Finds freely licensed Commons photos for bases (and systems without one)
in the forces database: the lead image of the entry's Wikipedia article,
kept only when Commons gives CC0, CC BY, CC BY-SA or public domain, with
author and file page. Saved as webapp/public/forces/img/base-<id>.jpg,
about 640 px wide and under 80 KB.

    python3 src/forces_db_images.py bases|systems [id,id,...] [--dry-run]

Every picked image must still be looked at by a person before it is
committed: the script cannot tell a base from a town square or a badge.
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
                         "https://commons.wikimedia.org/wiki/" + urllib.parse.quote("File:" + name.replace(" ", "_")))
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


def main(kind, dry):
    name = "bases" if kind == "bases" else "systems"
    data = json.load(open(DB / f"{name}.json", encoding="utf-8"))
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
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
    added = 0
    for r in rows:
        if only is not None and r["id"] not in only:
            continue
        f = next((f for f in cand.get(r["id"], []) if f in info), None)
        if not f:
            continue
        thumb, author, lic, lic_url, page = info[f]
        out = IMG / f"{prefix}-{r['id']}.jpg"
        print(r["id"], "<-", f, "|", lic, "|", author[:40])
        if dry:
            continue
        try:
            raw = get(thumb, binary=True)
        except Exception as e:
            print("  ! download", type(e).__name__, e)
            continue
        if not save_jpeg(raw, out):
            print("  ! too large")
            continue
        r["image"] = {"file": out.name, "commons_file": "File:" + f, "author": author, "license": lic,
                      "license_url": lic_url, "source_url": page}
        added += 1
        if not dry:  # save as we go: a slow download must not lose the rest
            (DB / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    if not dry:
        (DB / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{added} images added of {len(rows)} {name} without one")


if __name__ == "__main__":
    main(sys.argv[1], "--dry-run" in sys.argv)
