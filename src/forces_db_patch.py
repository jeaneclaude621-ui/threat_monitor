"""
Merges a hand-researched patch into the forces foundation database.

    python3 src/forces_db_patch.py patch.json

The patch is JSON:
    {"accessed": "2026-11-02",
     "bases": {"<id>": {"description_sv": ..., "status": {...}, "sources": [...]}},
     "units": {"<id>": {"description_sv": ..., "status_sv": ..., "as_of": ..., "sources": [...]}},
     "new_units": [{...full unit...}],
     "new_bases": [{...full base...}],
     "systems": {"<id>": {...}}}
Fields replace the old ones (null removes one), except `sources`, which are added (no
duplicate urls) and get the patch's `accessed` date when they lack one.
A new unit's garrison bases get the unit id in their `units` list.
"""
import json
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "config" / "forces_db"


def add_sources(entry, new, accessed):
    have = {s["url"] for s in entry.get("sources") or []}
    for s in new:
        s = dict(s)
        s.setdefault("accessed", accessed)
        if s["url"] not in have:
            entry.setdefault("sources", []).append(s)
            have.add(s["url"])


def merge(entry, fields, accessed):
    for k, v in fields.items():
        if k == "sources":
            add_sources(entry, v, accessed)
        elif v is None:
            entry.pop(k, None)
        else:
            entry[k] = v


def main(path):
    patch = json.load(open(path, encoding="utf-8"))
    accessed = patch.get("accessed", "2026-11-02")
    files = {n: json.load(open(DB / f"{n}.json", encoding="utf-8")) for n in ("bases", "units", "systems")}
    index = {n: {r["id"]: r for r in files[n][n]} for n in files}
    for n in ("bases", "units", "systems"):
        for rid, fields in (patch.get(n) or {}).items():
            if rid not in index[n]:
                sys.exit(f"{n}: unknown id {rid}")
            merge(index[n][rid], fields, accessed)
    for b in patch.get("new_bases") or []:
        if b["id"] in index["bases"]:
            sys.exit(f"new base {b['id']} exists")
        for s in b.get("sources") or []:
            s.setdefault("accessed", accessed)
        b.setdefault("units", [])
        b.setdefault("equipment", [])
        b.setdefault("events", [])
        files["bases"]["bases"].append(b)
        index["bases"][b["id"]] = b
        for uid in b["units"]:
            u = index["units"].get(uid)
            if u is None:
                sys.exit(f"new base {b['id']}: unknown unit {uid}")
            if b["id"] not in (u.get("garrison") or []):
                u["garrison"] = (u.get("garrison") or []) + [b["id"]]
                u.pop("garrison_note_sv", None)
    for u in patch.get("new_units") or []:
        if u["id"] in index["units"]:
            sys.exit(f"new unit {u['id']} exists")
        for s in u.get("sources") or []:
            s.setdefault("accessed", accessed)
        files["units"]["units"].append(u)
        index["units"][u["id"]] = u
        for g in u.get("garrison") or []:
            b = index["bases"].get(g)
            if b is None:
                sys.exit(f"new unit {u['id']}: unknown base {g}")
            if u["id"] not in b["units"]:
                b["units"].append(u["id"])
    for n in files:
        (DB / f"{n}.json").write_text(json.dumps(files[n], ensure_ascii=False, indent=1), encoding="utf-8")
    print({n: len(patch.get(n) or {}) for n in ("bases", "units", "systems")}, "new units:", len(patch.get("new_units") or []),
          "new bases:", len(patch.get("new_bases") or []))


if __name__ == "__main__":
    main(sys.argv[1])
