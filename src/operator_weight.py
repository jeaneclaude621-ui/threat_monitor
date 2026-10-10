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
- a verdict counts once per event, even when the event has several
  articles from its outlet;
- an event's score moves at most +/-1 from the model's own score, kept
  to one decimal so that small effects (an outlet verdict, a +1) show;
- the index moves at most +/-0.3 for operator reasons, computed here
  from the events' signals, and never out of its anchor band.
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
        # Verdicts on the event's own articles first, so the same verdict
        # is not counted again as an outlet verdict on a sibling article.
        seen = {v["id"] for art in ev.get("articles", []) for v in by_article.get(art["id"], [])}
        for art in ev.get("articles", []):
            direct = by_article.get(art["id"], [])
            used = [(v, 1.0) for v in direct]
            if not direct:
                outlet = [v for v in by_outlet.get(_norm_outlet(art["outlet"]), []) if v["id"] not in seen]
                seen.update(v["id"] for v in outlet)
                used = [(v, OUTLET_WEIGHT) for v in outlet]
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
            score = round(max(1.0, min(10.0, model + delta)), 1)
            ev["score"] = int(score) if score.is_integer() else score   # 9, not 9.0, in deck and mail
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


def _fmt(x: float) -> str:
    return f"{x:+.2f}".replace(".", ",")


def apply_to_index(result: dict, trace: list) -> dict:
    """Moves the general index for operator input, computed here from the
    events' operator signals - the model scores the index on the evidence
    alone. An event the operator finds credible pushes the index its way
    (up for an escalating event, down for a de-escalating one); one the
    operator doubts pushes the other way. The mean over the directional
    events the operator assessed, times MAX_INDEX_DELTA, is the effect;
    the anchor band, and the placement rules within it, still hold.
    Returns the report's operator_influence block. Run after
    apply_to_events."""
    sign = {"escalating": 1, "de-escalating": -1}
    used = [(ev, sign[ev.get("direction")] * ev["operator"]["signal"])
            for ev in result.get("events", [])
            if ev.get("direction") in sign and (ev.get("operator") or {}).get("trace")]
    computed = MAX_INDEX_DELTA * sum(c for _, c in used) / len(used) if used else 0.0
    applied = 0.0
    idx, band = result.get("threat_index"), result.get("index_band")
    # The placement rules (daily_report.apply_index_rules) may have
    # narrowed the band's range; operator input stays inside it too.
    lo, hi = result.get("index_range") or ((band - 0.5, band + 0.5) if band else (1, 10))
    if idx is not None and computed:
        moved = max(lo, min(hi, idx + computed))
        result["threat_index"] = round(moved, 1)
        applied = round(result["threat_index"] - idx, 1)
    if not used:
        note = "Operatörens bedömningar berörde ingen eskalerande eller deeskalerande händelse i dag."
    else:
        parts = ", ".join(f"{ev['id'].rsplit('-', 1)[-1]} {_fmt(c)}" for ev, c in used)
        note = f"Beräknat från operatörens bedömningar av {len(used)} händelser ({parts}): {_fmt(computed)} på index"
        if round(computed, 1) != applied:
            note += f", begränsat av ankarbandet och reglerna för placering i bandet till {_fmt(applied)}."
        elif not applied:
            note += ", för lite för att flytta index (en decimal)."
        else:
            note += "."
    if computed:
        print(f"  Operator effect on index: computed {computed:+.2f}, applied {applied:+.1f}")
    return {"index_delta": applied, "computed_delta": round(computed, 2), "note_sv": note, "trace": trace}


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
