"""
Build webapp/public/forces/places.json, the place list the heat map's
points come from (Version 3.41): Natural Earth's populated places (1:10m,
public domain), for the countries the map shows, with their English,
Swedish, local and German names.

    curl -sSLo /tmp/pp.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places.geojson
    python3 webapp/scripts/build_places.py /tmp/pp.geojson

Each row: [names, iso_a2, lat, lon, population, capital (1/0)]. Names shorter than four
letters, and names that are also common words, are left out so they do not
match ordinary text.
"""
import json
import sys
from pathlib import Path

COUNTRIES = set("NO SE FI DK EE LV LT PL DE BY UA RU SK RO MD GB FR BE NL IS BG HU CZ AT IT ES TR GE AM AZ "
                "GR PT IE CH HR RS SI GL BA ME MK AL LU CY MT KZ XK".split())
COMMON = {"Nice", "Split", "Bath", "Reading", "Mobile", "Wells", "March", "Deal", "Mons", "Sale", "Orange", "Lens",
          "Hull", "Derby", "Union", "Victoria", "Hope", "Grand", "Center", "Central", "Mobile", "Marks", "Polar", "Vladimir", "Victor", "Nikolaev"}
OUT = Path(__file__).resolve().parents[1] / "public" / "forces" / "places.json"


def main(path):
    feats = json.load(open(path, encoding="utf-8"))["features"]
    rows = []
    for f in feats:
        p = f["properties"]
        iso = p.get("ISO_A2")
        if iso == "-99" and p.get("ADM0NAME") == "Kosovo":
            iso = "XK"
        if iso not in COUNTRIES:
            continue
        lat, lon = float(p["LATITUDE"]), float(p["LONGITUDE"])
        if iso in ("RU", "KZ") and lon > 62:
            continue
        names = []
        for k in ("NAME_EN", "NAME_SV", "NAME", "NAMEASCII", "NAME_DE", "NAME_PL"):
            n = (p.get(k) or "").strip()
            if len(n) >= 4 and n not in COMMON and n not in names and not any(ch.isdigit() for ch in n):
                names.append(n)
        if names:
            cap = 1 if p.get("ADM0CAP") in (1, 1.0, "1") else 0
            rows.append([names, iso, round(lat, 3), round(lon, 3), int(p.get("POP_MAX") or 0), cap])
    rows.sort(key=lambda r: -r[4])
    # A short name that is the start of a bigger town's name in the same
    # country ("Rostov" and "Rostov-on-Don") is taken from the smaller town:
    # texts often shorten the big one.
    for i, small in enumerate(rows):
        for big in rows[:i]:
            if big[1] != small[1]:
                continue
            small[0] = [n for n in small[0]
                        if not any(b != n and (b.startswith(n + "-") or b.startswith(n + " ")) for b in big[0])]
    rows = [r for r in rows if r[0]]
    OUT.write_text(json.dumps({"source": "Natural Earth 1:10m populated places (public domain)", "places": rows},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} places -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
