"""
Checks the forces foundation database (config/forces_db): every id
reference resolves (and a unit's garrison lists the unit, and back), every
entry has a source, every image file exists and carries author, licence
and source, every ship has a class and a home base, no base or unit text is the
first pass's template, and the app's static copies match.
Also: no Russian state media, Telegram or email addresses anywhere, the
image folder within its limits (15 MB in all, 80 KB a file), and the
nightly payload and base list within theirs.

    python3 src/forces_db_check.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "config" / "forces_db"
PUBLIC = ROOT / "webapp" / "public" / "forces"
BRANCHES = {"flyg", "marin", "armé", "luftvärn", "robot", "fallskärm"}
FREE = re.compile(r"^(CC0|CC BY|CC-BY|Public domain|PD|Attribution)", re.I)
# Ids the strike map (src/strikes.py) emits: each must have a card.
STRIKE_IDS = ["geran-2", "shahed-131", "geran-3", "geran-4", "geran-5", "gerbera", "kh-101", "kh-555", "kalibr", "iskander-m",
              "iskander-k", "kn-23", "kinzhal", "kh-22", "kh-32", "kh-59", "kh-69", "kh-31p", "kh-31", "kh-35", "oniks", "tsirkon",
              "s-300", "s-400", "banderol", "orlan-10", "lancet", "supercam", "zala", "merlin-vr", "orion", "mohajer-6", "forpost"]
# Never a source: Russian state media and Telegram.
BANNED = re.compile(r"(^|[/.])(tass\.(ru|com)|rt\.com|ria\.ru|sputniknews\.|sputnik\.|iz\.ru|tvzvezda\.ru|rg\.ru|t\.me|telegram\.(org|me))(/|$)", re.I)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
TEMPLATE = re.compile(r"^\S.* är en (militär flygbas|garnison för|luftvärnsgarnison|marinbas|robotgarnison) .*militärdistrikt|Här finns enligt källorna|Materiel som nämns:")
UNIT_TEMPLATE = re.compile(r" är en? \w+ i (Rysslands|Belarus|ryska)\b.*Status: ")
IMG_TOTAL = 15_000_000
IMG_FILE = 80_000
PAYLOAD_MAX = 1_500_000
BASE_LINES_MAX = 60_000


def urls(obj):
    """Every url field anywhere in obj."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("url", "source_url") and isinstance(v, str):
                yield v
            else:
                yield from urls(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from urls(v)


def check_image(img, what, err):
    f = PUBLIC / "img" / (img.get("file") or "")
    if not img.get("file") or not f.exists():
        err(f"{what}: image file {img.get('file')} missing")
    elif f.stat().st_size > IMG_FILE:
        err(f"{what}: image over 80 KB")
    if not (img.get("author") and FREE.match(img.get("license") or "") and (img.get("source_url") or "").startswith("https://commons.wikimedia.org/")):
        err(f"{what}: image attribution")


def main() -> int:
    bases = json.load(open(DB / "bases.json", encoding="utf-8"))["bases"]
    units = {u["id"]: u for u in json.load(open(DB / "units.json", encoding="utf-8"))["units"]}
    systems = {s["id"]: s for s in json.load(open(DB / "systems.json", encoding="utf-8"))["systems"]}
    errors = []
    err = errors.append
    good_src = lambda lst: bool(lst) and all(re.match(r"^https?://", s.get("url") or "") and s.get("outlet") for s in lst)
    ids = set()
    for b in bases:
        if b["id"] in ids:
            err(f"base {b['id']}: duplicate id")
        ids.add(b["id"])
        if b["branch"] not in BRANCHES:
            err(f"base {b['id']}: branch {b['branch']}")
        if not (-90 <= b["lat"] <= 90 and -180 <= b["lon"] <= 180):
            err(f"base {b['id']}: position")
        if not good_src(b.get("sources")):
            err(f"base {b['id']}: no source")
        for u in b["units"]:
            if u not in units:
                err(f"base {b['id']}: unit {u} missing")
        for s in b["equipment"]:
            if s not in systems:
                err(f"base {b['id']}: system {s} missing")
        for e in b["events"]:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", e["date"]) or not good_src(e.get("sources")):
                err(f"base {b['id']}: event {e.get('date')} needs a date and a source")
        if not b.get("description_sv") or not (b.get("status") or {}).get("status_sv"):
            err(f"base {b['id']}: description or status")
        if b.get("image"):
            check_image(b["image"], f"base {b['id']}", err)
    base_units = {b["id"]: set(b["units"]) for b in bases}
    for b in bases:
        for uid in b["units"]:
            if uid in units and b["id"] not in (units[uid].get("garrison") or []):
                err(f"base {b['id']}: unit {uid} does not have the base as garrison")
        # The first pass wrote one template sentence per base; each now has its own text.
        if TEMPLATE.search(b.get("description_sv") or ""):
            err(f"base {b['id']}: description is still the template")
    for u in units.values():
        if u.get("parent") and u["parent"] not in units:
            err(f"unit {u['id']}: parent {u['parent']} missing")
        for g in u.get("garrison") or []:
            if g not in ids:
                err(f"unit {u['id']}: garrison {g} missing")
        for s in u.get("equipment") or []:
            if s not in systems:
                err(f"unit {u['id']}: system {s} missing")
        if not good_src(u.get("sources")):
            err(f"unit {u['id']}: no source")
        if u["branch"] not in BRANCHES:
            err(f"unit {u['id']}: branch")
        if u.get("garrison") == [] and not u.get("garrison_note_sv"):
            err(f"unit {u['id']}: no garrison and no garrison_note_sv")
        if UNIT_TEMPLATE.search(u.get("description_sv") or ""):
            err(f"unit {u['id']}: description is still the template")
        if not u.get("status_sv") or not u.get("as_of"):
            err(f"unit {u['id']}: status_sv or as_of")
        if u.get("type") == "fartyg" and u.get("class") not in systems:
            err(f"unit {u['id']}: ship class {u.get('class')} missing")
        if u.get("type") == "fartyg" and not u.get("garrison"):
            err(f"unit {u['id']}: ship without home base")
        for g in u.get("garrison") or []:
            if g in base_units and u["id"] not in base_units[g]:
                err(f"unit {u['id']}: garrison {g} does not list the unit")
        if u.get("image"):
            check_image(u["image"], f"unit {u['id']}", err)
    images = 0
    for s in systems.values():
        if not good_src(s.get("sources")):
            err(f"system {s['id']}: no source")
        for k in ("name", "category_sv", "role_sv", "description_sv"):
            if not s.get(k):
                err(f"system {s['id']}: {k}")
        if s.get("image"):
            images += 1
            check_image(s["image"], f"system {s['id']}", err)
    for sid in STRIKE_IDS:
        if sid not in systems:
            err(f"strike weapon {sid}: no system card")
    for name in ("bases", "units", "systems"):
        text = (DB / f"{name}.json").read_text(encoding="utf-8")
        for m in EMAIL.finditer(text):
            err(f"{name}.json: email address {m.group(0)}")
        for u in urls(json.loads(text)):
            if BANNED.search(u.split("?")[0]):
                err(f"{name}.json: banned source {u}")
    files = [f for f in (PUBLIC / "img").iterdir() if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    for f in files:
        if f.stat().st_size > IMG_FILE:
            err(f"img/{f.name}: over 80 KB")
    if total > IMG_TOTAL:
        err(f"webapp/public/forces/img: {total / 1e6:.1f} MB, over 15 MB")
    sizes = payload_sizes()
    if sizes:
        if sizes[0] > PAYLOAD_MAX:
            err(f"payload {sizes[0]} bytes, over {PAYLOAD_MAX}")
        if sizes[1] > BASE_LINES_MAX:
            err(f"base_lines {sizes[1]} characters, over {BASE_LINES_MAX}")
    for name, n in (("systems", len(systems)), ("units", len(units))):
        p = PUBLIC / f"{name}.json"
        if not p.exists() or len(json.load(open(p, encoding="utf-8"))[name]) != n:
            err(f"webapp/public/forces/{name}.json is missing or stale: run python3 src/forces.py export-db")
    for e in errors:
        print("  !", e)
    print(f"img: {len(files)} files, {total / 1e6:.2f} MB"
          + (f"; payload {sizes[0] / 1e3:.0f} kB, base_lines {sizes[1]} characters (without Wikidata's bases)" if sizes else ""))
    print(f"{len(bases)} bases, {len(units)} units, {len(systems)} systems, {images} images: "
          f"{'OK' if not errors else f'{len(errors)} problems'}")
    return 1 if errors else 0


def payload_sizes():
    """The app payload (bytes) and the nightly base list (characters) built
    from the hand-kept list and the database alone, without Wikidata's
    bases (they add short lines only). None when forces.py cannot load."""
    try:
        sys.path.insert(0, str(ROOT / "src"))
        from datetime import date
        import forces
        state = {"bases": [], "nights": [], "wikidata": []}
        forces.merge(state, forces.catalogue([]))
        body = json.dumps(forces.payload(state), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return len(body), len(forces.base_lines(state, date.today()))
    except Exception as e:
        print(f"  (payload size not measured: {type(e).__name__}: {e})")
        return None


if __name__ == "__main__":
    sys.exit(main())
