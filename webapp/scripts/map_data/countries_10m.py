"""topojson countries -> {countries: [{id, name, rings}]} for the app's map,
cut to the map's area and simplified (Douglas-Peucker, tolerance in degrees)."""
import json, sys
src, out, tol = sys.argv[1], sys.argv[2], float(sys.argv[3])
t = json.load(open(src))
sx, sy = t["transform"]["scale"]; tx, ty = t["transform"]["translate"]
arcs = []
for a in t["arcs"]:
    x = y = 0; pts = []
    for dx, dy in a:
        x += dx; y += dy; pts.append((x * sx + tx, y * sy + ty))
    arcs.append(pts)
def ring(ix):
    pts = []
    for i in ix:
        seg = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(seg if not pts else seg[1:])
    return pts
def dp(pts, tol):
    if len(pts) < 5: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1; n = (dx * dx + dy * dy) ** .5 or 1e-12
        best, bi = 0, None
        for i in range(a + 1, b):
            d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n
            if d > best: best, bi = d, i
        if bi is not None and best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]
res, total = [], 0
for g in t["objects"]["countries"]["geometries"]:
    polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]] if g["type"] == "Polygon" else []
    rings = []
    for poly in polys:
        for r in poly:
            raw = ring(r)
            # A ring that reaches past -150 (Chukotka, Alaska) moves east whole,
            # so it never spans the map.
            far = any(lon < -150 for lon, _ in raw)
            pts = [(lon + 360 if far and lon < 0 else lon, lat) for lon, lat in raw]
            if not any(-25 <= lon <= 192 and 34 <= lat <= 84 for lon, lat in pts):
                continue
            m = len(pts) // 2
            pts = dp(pts[:m + 1], tol)[:-1] + dp(pts[m:], tol)
            if len(pts) >= 4:
                rings.append([[round(lon, 3), round(lat, 3)] for lon, lat in pts])
    if rings:
        total += sum(map(len, rings))
        res.append({"id": g.get("id"), "name": g["properties"]["name"], "rings": rings})
json.dump({"source": f"Natural Earth 1:10m via world-atlas 2.0.2 (public domain), cut to the map and simplified at {tol} degrees",
           "countries": res}, open(out, "w"), separators=(",", ":"))
print(len(res), "countries", total, "points")
