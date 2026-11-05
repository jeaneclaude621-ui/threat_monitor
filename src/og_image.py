"""
The day's shareable image: a 1200x630 PNG (Open Graph size) with the
date, the threat index, the most important event (its title_sv) and
"AI-sammanställning ur öppna källor · Hotmonitor", in the app's colours.

Written to webapp/public/og/<date>.png and webapp/public/og/latest.png;
the job (schedule/run_job.py og_image) commits them to the code repo, so
they go out with the next deploy.

    python3 src/og_image.py [reports/<date>_report_data.json]

Without an argument it uses the newest report in reports/. Fonts come from
webapp/public/fonts/ (woff2, which Pillow reads when it is built with
brotli), else DejaVu, else Pillow's own.
"""
import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS_DIR = ROOT / "reports"
FONTS_DIR = ROOT / "webapp" / "public" / "fonts"
OUT_DIR = ROOT / "webapp" / "public" / "og"

WIDTH, HEIGHT = 1200, 630
MARGIN = 72
BG = "#15203B"
TEXT = "#F5F2EC"
ACCENT = "#C8741A"
MUTED = "#A9AEBB"      # TEXT toward BG, for labels
FOOTER = "AI-sammanställning ur öppna källor · Hotmonitor"

MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti",
          "september", "oktober", "november", "december"]

SERIF = ("Newsreader-latin-*.woff2", ["DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf"])
SANS = ("IBMPlexSans-latin-*.woff2", ["DejaVuSans.ttf"])
SANS_BOLD = ("IBMPlexSans-latin-*.woff2", ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf"])
DEJAVU_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/share/fonts/TTF",
               "/Library/Fonts", "/System/Library/Fonts/Supplemental"]


def swedish_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def format_index(value) -> str:
    try:
        return f"{float(value):.1f}".replace(".", ",")
    except (TypeError, ValueError):
        return "–"


def top_event(report: dict) -> str:
    """title_sv of the highest-scored event; the top development as a fallback."""
    events = [e for e in report.get("events") or [] if isinstance(e, dict) and (e.get("title_sv") or "").strip()]

    def score(e):
        try:
            return float(e.get("score"))
        except (TypeError, ValueError):
            return float("-inf")

    if events:
        return max(events, key=score)["title_sv"].strip()
    return (report.get("top_development") or "").strip()


def load_font(spec, size: int, weight: int = None):
    """The app's woff2 if Pillow can read it, else DejaVu, else Pillow's default."""
    from PIL import ImageFont
    pattern, fallbacks = spec
    # The latin subset covers Swedish; latin-ext only the extra letters.
    for path in sorted(FONTS_DIR.glob(pattern), key=lambda p: ("-ext-" in p.name, p.name)):
        try:
            font = ImageFont.truetype(str(path), size)
        except OSError:      # no brotli: Pillow cannot read woff2
            break
        if weight:
            try:
                font.set_variation_by_axes([weight])
            except Exception:
                pass
        return font
    for name in fallbacks:
        for d in DEJAVU_DIRS:
            try:
                return ImageFont.truetype(str(Path(d) / name), size)
            except OSError:
                continue
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size)
    except TypeError:        # Pillow < 10.1
        return ImageFont.load_default()


def wrap(draw, text: str, font, width: int, max_lines: int) -> list:
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = f"{line} {w}".strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + " …", font=font) > width:
            last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
        lines[-1] = last.rstrip(" ,.;:–-") + " …"
    return lines


def render(report: dict):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)

    label = load_font(SANS_BOLD, 24, weight=600)
    small = load_font(SANS, 26, weight=400)
    big = load_font(SERIF, 150, weight=500)
    title_font = load_font(SERIF, 56, weight=500)

    # Accent bar along the top.
    draw.rectangle([0, 0, WIDTH, 10], fill=ACCENT)

    # Header: name and date on the left.
    draw.text((MARGIN, 58), "HOTMONITOR", font=label, fill=ACCENT)
    draw.text((MARGIN, 92), swedish_date(report["date"]), font=small, fill=TEXT)

    # The index, right-aligned, with its label above.
    idx = format_index(report.get("threat_index"))
    right = WIDTH - MARGIN
    draw.text((right, 58), "HOTINDEX", font=label, fill=MUTED, anchor="ra")
    draw.text((right, 88), idx, font=big, fill=ACCENT, anchor="ra")

    # The most important event.
    top = top_event(report)
    y = 270
    if top:
        draw.text((MARGIN, y), "VIKTIGAST I DAG", font=label, fill=MUTED)
        y += 44
        for line in wrap(draw, top, title_font, WIDTH - 2 * MARGIN, 3):
            draw.text((MARGIN, y), line, font=title_font, fill=TEXT)
            y += 68

    # Footer.
    fy = HEIGHT - 76
    draw.line([MARGIN, fy - 26, WIDTH - MARGIN, fy - 26], fill=ACCENT, width=2)
    draw.text((MARGIN, fy), FOOTER, font=small, fill=TEXT)
    return img


def newest_report():
    files = sorted(REPORTS_DIR.glob("*_report_data.json"))
    return files[-1] if files else None


def write(report: dict, out_dir: Path = None) -> list:
    out_dir = out_dir or OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    img = render(report)
    paths = [out_dir / f"{report['date']}.png", out_dir / "latest.png"]
    for p in paths:
        img.save(p, "PNG", optimize=True)
    return paths


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    path = Path(argv[0]) if argv else newest_report()
    if not path or not path.exists():
        print(f"! og_image: no report found ({path or REPORTS_DIR})")
        return 1
    if importlib.util.find_spec("PIL") is None:
        print("! og_image: Pillow is not installed (pip install Pillow)")
        return 1
    report = json.loads(path.read_text(encoding="utf-8"))
    if not report.get("date"):
        report["date"] = path.name.split("_", 1)[0]
    for p in write(report):
        print(f"Share image: {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
