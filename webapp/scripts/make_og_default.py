#!/usr/bin/env python3
"""Draws public/og/default.png (1200x630), the Open Graph image share links
use when there is no image for the day (CONTRACT.md, Version 3.22).

    python3 scripts/make_og_default.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "public"
NAVY, PAPER = (0x15, 0x20, 0x3B), (0xF5, 0xF2, 0xEC)
MUTED = (0xB8, 0xBE, 0xCC)

img = Image.new("RGB", (1200, 630), NAVY)
d = ImageDraw.Draw(img)
serif = ImageFont.truetype(str(ROOT / "fonts/Newsreader-latin-f24c3215.woff2"), 128)
sans = ImageFont.truetype(str(ROOT / "fonts/IBMPlexSans-latin-868a235a.woff2"), 44)
small = ImageFont.truetype(str(ROOT / "fonts/IBMPlexSans-latin-868a235a.woff2"), 30)
for f in (serif, sans, small):
    try:
        f.set_variation_by_axes([600] if f is serif else [500])
    except Exception:
        pass

x = 96
d.rectangle([x, 150, x + 120, 158], fill=PAPER)
d.text((x, 190), "Hotmonitor", font=serif, fill=PAPER)
d.text((x, 360), "AI-sammanställning av ryska hybridhot", font=sans, fill=PAPER)
d.text((x, 418), "ur öppna källor", font=sans, fill=PAPER)
d.text((x, 520), "Daglig lägesbild · AI-genererad, kan innehålla fel", font=small, fill=MUTED)
out = ROOT / "og/default.png"
out.parent.mkdir(exist_ok=True)
img.save(out, optimize=True)
print(out, out.stat().st_size, "bytes")
