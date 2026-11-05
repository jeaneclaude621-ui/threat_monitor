"""
Measured precision (review docs/review/1-traffsakerhet.md, #10).

Once a week a random sample of the last seven days' events is written to
data/precision_sample_<date>.json. The owner or a reviewer opens the file
and sets each item's "stamp" to one of

    stämmer       the event is right, and its sources say so
    delvis        partly right: a detail, the date or the scale is wrong
    fel           wrong
    källa saknas  no source given supports it (missing or dead link,
                  or the article says something else)

and may add a "note". `summary` then counts every labelled item in every
sample into data/precision.json: precision overall, per model (the
report's generated_by.models, "okänd" for reports without it), per source
tier (the best tier among the event's articles) and per topic.

Precision is "stämmer" / labelled items; "precision_incl_partial" also
counts "delvis" as right. Unlabelled items are left out of both.

    python3 src/precision.py sample [--n 10] [--days 7] [--force]
    python3 src/precision.py summary
"""
import argparse
import json
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS_DIR = ROOT / "reports"
DATA_DIR = ROOT / "data"
SUMMARY_PATH = DATA_DIR / "precision.json"

STAMPS = ("stämmer", "delvis", "fel", "källa saknas")
SAMPLE_SIZE = 10
WINDOW_DAYS = 7
UNKNOWN = "okänd"
NO_TOPIC = "inget ämne"


def sample_path(day: date, data_dir: Path = None) -> Path:
    return (data_dir or DATA_DIR) / f"precision_sample_{day.isoformat()}.json"


def report_model(report: dict) -> str:
    """The model(s) that wrote the report, from generated_by.models (a list,
    a dict of role -> model, or a string); generated_by.model as a fallback."""
    gb = report.get("generated_by")
    if not isinstance(gb, dict):
        return UNKNOWN
    models = gb.get("models", gb.get("model"))
    if isinstance(models, dict):
        models = list(models.values())
    if isinstance(models, str):
        models = [models]
    if not isinstance(models, list):
        return UNKNOWN
    names = sorted({m.strip() for m in models if isinstance(m, str) and m.strip()})
    if not names:
        return UNKNOWN
    label = " + ".join(names)
    if gb.get("fallback_used"):
        label += " (reserv)"
    return label


def best_tier(event: dict):
    tiers = [a.get("tier") for a in event.get("articles") or []
             if isinstance(a.get("tier"), int) and 1 <= a["tier"] <= 4]
    return min(tiers) if tiers else None


def tier_label(tier) -> str:
    return f"nivå {tier}" if tier else UNKNOWN


def load_reports(days: int, today: date, reports_dir: Path = None) -> list:
    """[(date, report_data)] for the `days` days up to and including today."""
    out = []
    for back in range(days):
        d = today - timedelta(days=back)
        path = (reports_dir or REPORTS_DIR) / f"{d.isoformat()}_report_data.json"
        try:
            out.append((d, json.loads(path.read_text(encoding="utf-8"))))
        except FileNotFoundError:
            continue
        except ValueError as e:
            print(f"  ! {path.name} could not be read ({e})")
    return out


def _item(day: date, report: dict, index: int, ev: dict) -> dict:
    return {
        "report_date": day.isoformat(),
        "event_id": ev.get("id") or f"{day.isoformat()}-e{index}",
        "title_sv": ev.get("title_sv") or ev.get("title") or "",
        "summary_sv": ev.get("summary_sv") or "",
        "score": ev.get("score"),
        "model": report_model(report),
        "tier": best_tier(ev),
        "topics": [t for t in ev.get("topics") or [] if isinstance(t, str)],
        "articles": [{"outlet": a.get("outlet"), "url": a.get("url"), "tier": a.get("tier")}
                     for a in ev.get("articles") or []],
        "stamp": None,
        "note": "",
    }


def make_sample(today: date = None, n: int = SAMPLE_SIZE, days: int = WINDOW_DAYS,
                seed=None, reports_dir: Path = None) -> dict:
    """A random sample of up to `n` events from the last `days` days' reports.
    The seed defaults to the date, so a rerun on the same day picks the same."""
    today = today or date.today()
    pool = [_item(d, r, i, ev)
            for d, r in load_reports(days, today, reports_dir)
            for i, ev in enumerate(r.get("events") or [], start=1) if isinstance(ev, dict)]
    rng = random.Random(seed if seed is not None else today.isoformat())
    picked = rng.sample(pool, min(n, len(pool)))
    picked.sort(key=lambda it: (it["report_date"], it["event_id"]))
    return {
        "date": today.isoformat(),
        "window": [(today - timedelta(days=days - 1)).isoformat(), today.isoformat()],
        "events_in_window": len(pool),
        "instructions": "Sätt 'stamp' på varje händelse till en av: " + ", ".join(STAMPS)
                        + ". Kontrollera mot källorna. 'note' är fritt.",
        "allowed_stamps": list(STAMPS),
        "items": picked,
    }


def recent_sample(today: date, days: int, data_dir: Path = None):
    """The newest sample made within the last `days` days, if any."""
    for back in range(days):
        p = sample_path(today - timedelta(days=back), data_dir)
        if p.exists():
            return p
    return None


def write_sample(today: date = None, n: int = SAMPLE_SIZE, days: int = WINDOW_DAYS, force: bool = False,
                 data_dir: Path = None, reports_dir: Path = None):
    """Writes this week's sample. Never overwrites a sample (it may already
    be labelled); without --force it also skips when one was made in the
    last `days` days, so a daily trigger still gives one sample a week."""
    today = today or date.today()
    data_dir = data_dir or DATA_DIR
    existing = recent_sample(today, days, data_dir)
    if existing and (not force or existing == sample_path(today, data_dir)):
        print(f"Precision sample: {existing.name} already exists - nothing new")
        return None
    sample = make_sample(today, n, days, reports_dir=reports_dir)
    if not sample["items"]:
        print(f"! Precision sample: no events in the reports of the last {days} days")
        return None
    data_dir.mkdir(parents=True, exist_ok=True)
    path = sample_path(today, data_dir)
    path.write_text(json.dumps(sample, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Precision sample: {len(sample['items'])} of {sample['events_in_window']} events -> {path.name}")
    return path


def _norm_stamp(value):
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    aliases = {"stammer": "stämmer", "kalla saknas": "källa saknas", "källan saknas": "källa saknas"}
    v = aliases.get(v, v)
    return v if v in STAMPS else None


def _bucket():
    return {"labelled": 0, **{s: 0 for s in STAMPS}}


def _finish(b: dict) -> dict:
    n = b["labelled"]
    return dict(b, precision=round(b["stämmer"] / n, 3) if n else None,
                precision_incl_partial=round((b["stämmer"] + b["delvis"]) / n, 3) if n else None)


def summarize(data_dir: Path = None) -> dict:
    """Counts every labelled item in every sample file."""
    data_dir = data_dir or DATA_DIR
    total, by_model, by_tier, by_topic = _bucket(), {}, {}, {}
    samples, unlabelled, seen = [], 0, set()
    for path in sorted(data_dir.glob("precision_sample_*.json")):
        try:
            sample = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as e:
            print(f"  ! {path.name} could not be read ({e}) - left out")
            continue
        samples.append(path.name)
        for it in sample.get("items") or []:
            stamp = _norm_stamp(it.get("stamp"))
            if stamp is None:
                unlabelled += 1
                continue
            # The same event drawn in two samples counts once (the later label).
            key = (it.get("report_date"), it.get("event_id"))
            if key in seen:
                continue
            seen.add(key)
            buckets = [total,
                       by_model.setdefault(it.get("model") or UNKNOWN, _bucket()),
                       by_tier.setdefault(tier_label(it.get("tier")), _bucket())]
            buckets += [by_topic.setdefault(t, _bucket()) for t in (it.get("topics") or [NO_TOPIC])]
            for b in buckets:
                b["labelled"] += 1
                b[stamp] += 1
    return {
        "updated": datetime.now().isoformat(timespec="seconds"),
        "definition": "precision = stämmer / märkta; precision_incl_partial = (stämmer + delvis) / märkta",
        "samples": samples,
        "unlabelled": unlabelled,
        "total": _finish(total),
        "by_model": {k: _finish(v) for k, v in sorted(by_model.items())},
        "by_tier": {k: _finish(v) for k, v in sorted(by_tier.items())},
        "by_topic": {k: _finish(v) for k, v in sorted(by_topic.items())},
    }


def write_summary(data_dir: Path = None) -> dict:
    data_dir = data_dir or DATA_DIR
    summary = summarize(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / SUMMARY_PATH.name).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
                                             encoding="utf-8")
    t = summary["total"]
    print(f"Precision: {t['precision']} over {t['labelled']} labelled events "
          f"({summary['unlabelled']} not yet labelled) -> {SUMMARY_PATH.name}")
    return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Precision sample and summary")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample", help="write this week's sample (and refresh the summary)")
    s.add_argument("--n", type=int, default=SAMPLE_SIZE)
    s.add_argument("--days", type=int, default=WINDOW_DAYS)
    s.add_argument("--force", action="store_true", help="sample even if one was made this week")
    sub.add_parser("summary", help="count the labelled samples into data/precision.json")
    args = ap.parse_args(argv)
    if args.cmd == "sample":
        write_sample(n=args.n, days=args.days, force=args.force)
    write_summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
