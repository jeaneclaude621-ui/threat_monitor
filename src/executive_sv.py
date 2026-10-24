"""
"Svensk Super Executive": a one-screen Swedish summary of the daily
report - every heading and topic from the deck, one short sentence
each - shown at the top of the morning email.

Gemini returns it as structured JSON (headings -> label/sentence rows)
rather than prose, so mailer.py can lay it out as plain inline-styled
HTML that reads well on an iPhone, and nothing in it is interpreted as
markup.

    python3 src/executive_sv.py                # today's report
    python3 src/executive_sv.py 2026-09-28     # a specific date

Best-effort: if it fails, the email goes out without it.
"""
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ask_model_json, OUTPUT_DIR

SYSTEM = """Du är en svensk underrättelseanalytiker som skriver en
superkort ledningsbrief. Du svarar med enbart giltig JSON."""

HEADINGS = [
    "Hotbedömning", "Prognosfaktorer", "Senaste dygnets händelser",
    "Nyckelsignaler", "Trend", "Narrativ stabilitet", "Källor",
    "Desinformationsbevakning", "Metod", "Självkontroll",
]

PROMPT = """Här är dagens rapportdata som JSON:

{payload}

Skriv en superkort brief på svenska som täcker ALLA rubriker och ämnen
i rapporten, men med bara EN kort mening per punkt.

Svara med JSON i exakt denna form:
{{
  "index_line": "En mening med båda hotindexen, t.ex. 'Hotindex 6,5 i dag (stabilt); 30-dagarsprognos 7,0 – förkris.'",
  "top": "En mening om dagens viktigaste utveckling.",
  "sections": [
    {{"heading": "<rubrik>", "items": [{{"label": "<kort etikett>", "text": "<en kort mening>"}}]}}
  ]
}}

Regler:
- Använd exakt dessa rubriker i denna ordning: {headings}.
- Hotbedömning: två punkter, "Nu (x,x)" och "30 dagar (x,x)".
- Prognosfaktorer: en punkt per faktor; etiketten börjar med ↑ eller ↓
  (riktning) följt av datum, t.ex. "↑ 18 okt".
- Senaste dygnets händelser: en punkt per händelse; etiketten är ett
  kort ämne med poängen, t.ex. "EU-krisprotokoll (9/10)".
- Narrativ stabilitet: en punkt per tråd, etiketten är trådens namn.
- Trend: beskriv utvecklingen i indexhistoriken i en mening.
- Etiketter får vara tomma ("") där de inte behövs.
- Skriv aldrig "Band x" - beskriv nivån i ord (t.ex. "förkris").
- Naturlig svenska, inte översatt engelska: "anfall", inte "strejker".
- Decimaltal med kommatecken. Svensk text, inga källhänvisningar i
  meningarna, ingen markdown.
- Varje "text" är högst cirka 15 ord - hellre för kort än för lång.
- Citat översätts till idiomatisk svenska ("intercept" = "bekämpa")."""


def build_executive(report_data: dict) -> dict:
    """The brief as {index_line, top, sections}. Raises on failure."""
    slim = dict(report_data)
    slim["threat_index_history"] = slim.get("threat_index_history", [])[-10:]
    prompt = PROMPT.format(payload=json.dumps(slim, ensure_ascii=False, indent=1),
                           headings=", ".join(HEADINGS))
    brief = ask_model_json(prompt, system=SYSTEM, max_tokens=4000)
    if not isinstance(brief, dict) or not brief.get("sections"):
        raise ValueError("no sections in response")
    return brief


def build_executive_safe(report_data: dict):
    """build_executive, saved next to the deck. Returns the brief or None;
    never raises - a failure here must not stop the email going out."""
    day = report_data.get("date", date.today().isoformat())
    try:
        brief = build_executive(report_data)
    except Exception as e:
        print(f"  ! Svensk Super Executive failed: {e}")
        return None
    path = OUTPUT_DIR / f"{day}_executive_sv.json"
    path.write_text(json.dumps(brief, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Svensk Super Executive: {path.name}")
    return brief


if __name__ == "__main__":
    day = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
    data = json.load(open(OUTPUT_DIR / f"{day}_report_data.json", encoding="utf-8"))
    print(json.dumps(build_executive_safe(data), indent=2, ensure_ascii=False))
