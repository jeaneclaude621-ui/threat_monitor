"""
Draws the app icons (navy ground, a paper-coloured index scale with an
amber fill and an amber forecast tick) with only the standard library.
The mark stays inside the central 60 %, so the same art is safe as a
maskable icon.

    python3 webapp/dev/make_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public"

NAVY = (21, 32, 59)
PAPER = (245, 242, 236)
TRACK = (58, 74, 120)
AMBER = (240, 183, 117)


def rounded_rect(px, size, x0, y0, x1, y1, r, color):
    """Fill a rounded rectangle given in fractions of the icon size."""
    X0, Y0, X1, Y1, R = (int(v * size) for v in (x0, y0, x1, y1, r))
    for y in range(Y0, Y1):
        for x in range(X0, X1):
            cx = min(max(x, X0 + R), X1 - R - 1)
            cy = min(max(y, Y0 + R), Y1 - R - 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= R * R:
                px[y][x] = color


def draw(size):
    px = [[NAVY] * size for _ in range(size)]
    # Index scale 0-10: paper track, amber fill to 6.5, forecast tick at 7.
    rounded_rect(px, size, 0.20, 0.52, 0.80, 0.60, 0.04, TRACK)
    rounded_rect(px, size, 0.20, 0.52, 0.20 + 0.60 * 0.65, 0.60, 0.04, PAPER)
    rounded_rect(px, size, 0.20 + 0.60 * 0.70 - 0.02, 0.36, 0.20 + 0.60 * 0.70 + 0.02, 0.68, 0.02, AMBER)
    # Three short bars above: the "report" lines.
    rounded_rect(px, size, 0.20, 0.30, 0.46, 0.34, 0.02, PAPER)
    rounded_rect(px, size, 0.20, 0.40, 0.38, 0.44, 0.02, (185, 195, 221))
    return px


def write_png(path, px):
    size = len(px)
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        write_png(OUT / name, draw(size))
        print(f"wrote {name}")
