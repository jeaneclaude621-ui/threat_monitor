# Map data for the Styrkor tab

Built from Natural Earth (public domain). Nothing is fetched at run time
from other hosts; the app serves these files itself.

- `webapp/public/forces/countries-10m.json`: fine coastlines and borders,
  loaded when a map is zoomed in.
  `npm pack world-atlas@2.0.2`, then
  `python3 -I countries_10m.py package/countries-10m.json OUT.json 0.015`
- `webapp/public/forces/features.json`: lakes, major rivers, and the
  regional borders of Russia, Belarus and Ukraine. From
  github.com/nvkelso/natural-earth-vector, `geojson/`:
  ne_10m_admin_1_states_provinces_lines, ne_50m_rivers_lake_centerlines,
  ne_50m_lakes; then `python3 -I features.py DIR OUT.json`
- `webapp/public/forces/countries.json`: the light 1:50m outlines (older).

Rings that reach past 150° W (Chukotka, Alaska) are moved east whole, so
no ring spans the map.
