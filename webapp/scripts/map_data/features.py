"""Natural Earth lakes, major rivers and the regional borders of Russia,
Belarus and Ukraine -> one light JSON for the app's maps."""
import json, sys
ne, out = sys.argv[1], sys.argv[2]
def shift(p): return [p[0] + 360 if p[0] < -150 else p[0], p[1]]
def inbox(pts): return any(-25 <= x <= 192 and 34 <= y <= 84 for x, y in pts)
def dp(pts, tol):
    if len(pts) < 4: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts) - 1)]
    while st:
        a, b = st.pop(); (x1, y1), (x2, y2) = pts[a], pts[b]; dx, dy = x2 - x1, y2 - y1; n = (dx*dx + dy*dy) ** .5
        best, bi = 0, None
        for i in range(a + 1, b):
            d = (abs(dy*pts[i][0] - dx*pts[i][1] + x2*y1 - y2*x1) / n) if n else ((pts[i][0]-x1)**2 + (pts[i][1]-y1)**2) ** .5
            if d > best: best, bi = d, i
        if bi is not None and best > tol: keep[bi] = True; st += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]
def lines(geom):
    if geom["type"] == "LineString": return [geom["coordinates"]]
    if geom["type"] == "MultiLineString": return geom["coordinates"]
    if geom["type"] == "Polygon": return geom["coordinates"]
    if geom["type"] == "MultiPolygon": return [r for p in geom["coordinates"] for r in p]
    return []
def take(feats, tol, keepf):
    res = []
    for f in feats:
        if not keepf(f["properties"]): continue
        for l in lines(f["geometry"]):
            far = any(p[0] < -150 for p in l)
            pts = [[p[0] + 360 if far and p[0] < 0 else p[0], p[1]] for p in l]
            if not inbox(pts): continue
            pts = dp(pts, tol)
            if len(pts) >= 2: res.append([[round(x, 3), round(y, 3)] for x, y in pts])
    return res
reg = json.load(open(f"{ne}/ne_10m_admin_1_states_provinces_lines.geojson"))["features"]
riv = json.load(open(f"{ne}/ne_50m_rivers_lake_centerlines.geojson"))["features"]
lak = json.load(open(f"{ne}/ne_50m_lakes.geojson"))["features"]
data = {
    "source": "Natural Earth (public domain): 1:10m regional borders of Russia, Belarus and Ukraine; 1:50m lakes and rivers",
    "regions": take(reg, 0.03, lambda p: p.get("ADM0_NAME") in ("Russia", "Belarus", "Ukraine")),
    "rivers": take(riv, 0.03, lambda p: (p.get("scalerank") or 9) <= 6),
    "lakes": take(lak, 0.02, lambda p: (p.get("scalerank") or 9) <= 6),
}
json.dump(data, open(out, "w"), separators=(",", ":"))
print({k: (len(v), sum(map(len, v))) for k, v in data.items() if k != "source"})
