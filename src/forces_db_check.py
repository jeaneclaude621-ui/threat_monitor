"""
Checks the forces foundation database (config/forces_db): every id
reference resolves, every entry has a source, every image file exists and
carries author, licence and source, and the app's static copies match.

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
    images = 0
    for s in systems.values():
        if not good_src(s.get("sources")):
            err(f"system {s['id']}: no source")
        for k in ("name", "category_sv", "role_sv", "description_sv"):
            if not s.get(k):
                err(f"system {s['id']}: {k}")
        img = s.get("image")
        if img:
            images += 1
            f = PUBLIC / "img" / img["file"]
            if not f.exists():
                err(f"system {s['id']}: image file {img['file']} missing")
            elif f.stat().st_size > 80_000:
                err(f"system {s['id']}: image over 80 KB")
            if not (img.get("author") and FREE.match(img.get("license") or "") and (img.get("source_url") or "").startswith("https://commons.wikimedia.org/")):
                err(f"system {s['id']}: image attribution")
    for sid in STRIKE_IDS:
        if sid not in systems:
            err(f"strike weapon {sid}: no system card")
    for name, n in (("systems", len(systems)), ("units", len(units))):
        p = PUBLIC / f"{name}.json"
        if not p.exists() or len(json.load(open(p, encoding="utf-8"))[name]) != n:
            err(f"webapp/public/forces/{name}.json is missing or stale: run python3 src/forces.py export-db")
    for e in errors:
        print("  !", e)
    print(f"{len(bases)} bases, {len(units)} units, {len(systems)} systems, {images} images: "
          f"{'OK' if not errors else f'{len(errors)} problems'}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
