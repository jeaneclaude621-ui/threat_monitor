"""
The intelligence operator's assessments ("operatörsbedömning") and how
they weigh into the daily analysis - high weight, never decisive.

The operator swipes each article in the web app: +2 mycket trovärdig,
+1 trovärdig, -1 tveksam, -2 inte trovärdig, 0 withdrawn. Rows are
append-only (a change supersedes the earlier row), synced to
data/operator_assessments.jsonl by app_sync.py before each run.

Caps are enforced here in code, never left to the model:
- a verdict's weight halves every 30 days;
- a verdict on the same article counts in full; a verdict on the same
  outlet (another article) counts at 35 %;
- an event's score moves at most +/-1 from the model's own score;
- the index moves at most +/-0.3 for operator reasons, and never out of
  its anchor band.
Every effect is recorded in a trace with the assessment ids behind it,
so the app can show why a score is what it is.
"""
import json
from datetime import datetime, timezone

from common import DATA_DIR
from app_data import canonical_outlet

ASSESSMENTS_PATH = DATA_DIR / "operator_assessments.jsonl"

HALF_LIFE_DAYS = 30
OUTLET_WEIGHT = 0.35
MAX_EVENT_DELTA = 1.0
MAX_INDEX_DELTA = 0.3
DIVERGENCE = 0.5          # operator signal (-1..1) this far against the model = divergent

LABELS_SV = {2: "Mycket trovärdig", 1: "Trovärdig", -1: "Tveksam", -2: "Inte trovärdig", 0: "Återkallad"}


def load_rows() -> list:
    if not ASSESSMENTS_PATH.exists():
        return []
    rows = []
    for line in ASSESSMENTS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                print("  ! Skipping unreadable line in operator_assessments.jsonl")
    return rows


def current_verdicts(rows: list) -> list:
    """The latest row per (operator, article); withdrawn ones dropped.
    A superseded row is never current, whatever its timestamp."""
    superseded = {r.get("supersedes") for r in rows if r.get("supersedes")}
    latest = {}
    for r in sorted(rows, key=lambda r: r.get("ts", "")):
        if r["id"] in superseded:
            continue
        latest[(r.get("operator"), r.get("article_id"))] = r
    return [r for r in latest.values() if r.get("value")]


def _decay(ts: str, now: datetime) -> float:
    try:
        then = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return 0.0
    age_days = max(0.0, (now - then).total_seconds() / 86400)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def _norm_outlet(name: str) -> str:
    # Verdicts made before outlet names were merged still match.
    return canonical_outlet(name).lower()


def apply_to_events(events: list, rows: list = None, now: datetime = None) -> list:
    """Adds `operator` {delta, divergent, trace} to each event and moves
    `score` from `model_score` by at most MAX_EVENT_DELTA. Returns every
    trace entry used, for the report-level trace."""
    now = now or datetime.now(timezone.utc)
    verdicts = current_verdicts(load_rows() if rows is None else rows)
    by_article, by_outlet = {}, {}
    for v in verdicts:
        by_article.setdefault(v.get("article_id"), []).append(v)
        by_outlet.setdefault(_norm_outlet(v.get("outlet")), []).append(v)

    all_trace = []
    for ev in events:
        model = ev.get("model_score", ev.get("score"))
        trace, total, n = [], 0.0, 0
        for art in ev.get("articles", []):
            direct = by_article.get(art["id"], [])
            used = [(v, 1.0) for v in direct]
            if not direct:
                used = [(v, OUTLET_WEIGHT) for v in by_outlet.get(_norm_outlet(art["outlet"]), [])]
            if not used:
                continue
            n += 1
            art_effects = []
            for v, kind_weight in used:
                weight = round(kind_weight * _decay(v.get("ts"), now), 3)
                effect = v["value"] / 2 * weight          # -1..1 per verdict
                art_effects.append(effect)
                trace.append({
                    "assessment_id": v["id"], "article_id": v.get("article_id"),
                    "outlet": v.get("outlet"), "value": v["value"],
                    "date": (v.get("ts") or "")[:10], "weight": weight,
                    "effect": round(effect, 3), "operator": v.get("operator"),
                    "same_article": kind_weight == 1.0,
                })
            total += sum(art_effects) / len(art_effects)

        signal = total / n if n else 0.0                  # -1..1
        delta = max(-MAX_EVENT_DELTA, min(MAX_EVENT_DELTA, signal))
        divergent = isinstance(model, (int, float)) and (
            (model >= 7 and signal <= -DIVERGENCE) or (model <= 4 and signal >= DIVERGENCE))
        if isinstance(model, (int, float)):
            ev["score"] = int(max(1, min(10, round(model + delta))))
        ev["operator"] = {"delta": round(delta, 2), "signal": round(signal, 2),
                          "divergent": bool(divergent), "trace": trace}
        all_trace.extend(trace)
    return all_trace


def prompt_block(rows: list = None, now: datetime = None, limit: int = 40) -> str:
    """The operator's current verdicts, newest first, for the sweep prompt."""
    now = now or datetime.now(timezone.utc)
    verdicts = sorted(current_verdicts(load_rows() if rows is None else rows),
                      key=lambda v: v.get("ts", ""), reverse=True)[:limit]
    if not verdicts:
        return "(no operator assessments yet)"
    lines = []
    for v in verdicts:
        lines.append(f"- [{v['id'][:8]}] {v.get('ts', '')[:10]} {v.get('outlet')}: "
                     f"{v['value']:+d} ({LABELS_SV.get(v['value'])}), weight now "
                     f"{_decay(v.get('ts'), now):.2f}, event {v.get('event_id')}")
    return "\n".join(lines)


def cap_index_effect(result: dict, trace: list) -> dict:
    """The model reports how far operator input moved the general index
    (operator_effect_on_index). Hold that to +/-MAX_INDEX_DELTA and to
    the anchor band, and return the report's operator_influence block."""
    try:
        claimed = float(result.get("operator_effect_on_index") or 0)
    except (TypeError, ValueError):
        claimed = 0.0
    allowed = max(-MAX_INDEX_DELTA, min(MAX_INDEX_DELTA, claimed))
    if allowed != claimed and result.get("threat_index") is not None:
        result["threat_index"] = round(result["threat_index"] - (claimed - allowed), 1)
        print(f"  ! Operator effect on index {claimed:+.2f} capped to {allowed:+.2f}")
    band = result.get("index_band")
    if band and result.get("threat_index") is not None:
        result["threat_index"] = round(max(band - 0.5, min(band + 0.5, result["threat_index"])), 1)
    note = result.get("operator_effect_reason_sv") or (
        "Operatörens bedömningar påverkade inte indexet i dag." if not allowed else "")
    return {"index_delta": round(allowed, 2), "note_sv": note, "trace": trace}


def track_record(outcomes: dict, rows: list = None) -> dict:
    """How often each operator's current verdicts matched what later
    reporting showed: a positive verdict on an event later CONFIRMED, or
    a negative one on an event later CONTRADICTED, counts as agreed.
    UNRESOLVED events and events not yet re-checked are left out.
    Shown in the app; not used as weight."""
    stats = {}
    for v in current_verdicts(load_rows() if rows is None else rows):
        outcome = outcomes.get(v.get("event_id"))
        if outcome not in ("CONFIRMED", "CONTRADICTED"):
            continue
        s = stats.setdefault(v.get("operator"), {"evaluated": 0, "agreed": 0})
        s["evaluated"] += 1
        if (v["value"] > 0) == (outcome == "CONFIRMED"):
            s["agreed"] += 1
    for s in stats.values():
        s["rate"] = round(s["agreed"] / s["evaluated"], 2) if s["evaluated"] else None
    return stats
