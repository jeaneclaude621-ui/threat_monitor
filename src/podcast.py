"""
Turns the finished daily report into a spoken Swedish briefing - a
~4 minute "podcast" version for listening to on the way to work.

Two steps: Claude rewrites the report data as a spoken-word script in
Swedish (conclusions only - no outlet names, no source references, no
scores read aloud), then macOS renders it with the built-in Swedish
voice Alva and converts it to .m4a, which plays natively in Apple Mail
on an iPhone.

    python3 src/podcast.py                 # today's report
    python3 src/podcast.py 2026-09-21      # a specific date
    python3 src/podcast.py --script-only   # skip the audio rendering

Everything here is best-effort: if the script or the audio fails, the
daily report still goes out without it.
"""
import json
import re
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ask_claude, OUTPUT_DIR

VOICE = "Alva"          # the only sv_SE voice macOS ships
TARGET_WORDS = 600      # ~4 minutes at Swedish speaking pace

SYSTEM = """Du är en svensk underrättelseanalytiker som spelar in en kort
muntlig morgonbriefing. Du talar, du skriver inte. Svara med enbart
manustexten - inga rubriker, ingen punktlista, inga regianvisningar."""

PROMPT = """Här är dagens rapportdata som JSON:

{payload}

Skriv ett talmanus på svenska för en muntlig briefing på cirka {words}
ord (ungefär fyra minuter).

Krav:
- ENDAST resultat och slutsatser. Nämn aldrig källor, tidningar,
  nyhetsbyråer eller varifrån en uppgift kommer. Inga uttryck som
  "enligt", "rapporterar" eller "uppges".
- Läs inte upp siffror som poäng eller listor. Det finns två hotindex:
  det generella (läget i dag) och en prognos för de kommande 30 dagarna.
  Nämn båda en gång i klartext, till exempel "hotnivån ligger på sex
  komma tre av tio, och för den kommande månaden bedöms den till sju",
  och säg kort vad som driver prognosen.
- Täck: läget och riktningen, trettiodagarsprognosen, den viktigaste utvecklingen, de övriga
  händelserna under dygnet, mönstren i den ryska informationspåverkan,
  och till sist det metodförslag som väntar på besked.
- Skrivet för örat: korta meningar, talspråkliga övergångar som "det
  som sticker ut i dag är", "samtidigt", "och till sist". Inga
  förkortningar som läses fel, skriv ut dem.
- Börja med "God morgon." och en mening om vilken dag det gäller.
  Avsluta med en kort mening om att den fullständiga rapporten finns
  bifogad.

Svara med enbart manustexten."""


def build_script(report_data: dict, words: int = TARGET_WORDS) -> str:
    """Spoken Swedish script for this report. Raises on failure."""
    slim = {k: v for k, v in report_data.items()
            if k not in ("tiers", "threat_index_history", "narrative_stability")}
    prompt = PROMPT.format(payload=json.dumps(slim, ensure_ascii=False, indent=1), words=words)
    return _for_speech(ask_claude(prompt, system=SYSTEM, max_tokens=2000, use_search=False))


def _for_speech(text: str) -> str:
    """Soft hyphens and zero-width characters make `say` mispronounce or
    break a word in two, and markdown emphasis gets read as punctuation."""
    text = re.sub(r"[\u00ad\u200b\u2060\ufeff]", "", text)
    text = re.sub(r"[*_#`]+", "", text)
    return text.strip()


def render_audio(script: str, out_path: Path) -> bool:
    """Speak the script to an .m4a via macOS `say` + `afconvert`.
    Returns True on success; never raises."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            txt = Path(tmp) / "script.txt"
            aiff = Path(tmp) / "speech.aiff"
            txt.write_text(script, encoding="utf-8")
            subprocess.run(["say", "-v", VOICE, "-f", str(txt), "-o", str(aiff)],
                           check=True, capture_output=True)
            subprocess.run(["afconvert", str(aiff), str(out_path),
                            "-d", "aac", "-f", "m4af", "-b", "64000"],
                           check=True, capture_output=True)
        return True
    except FileNotFoundError as e:
        print(f"  ! Podcast audio skipped - {e.filename} not available on this machine")
    except subprocess.CalledProcessError as e:
        print(f"  ! Podcast audio failed: {e.stderr.decode('utf-8', 'replace')[:200]}")
    except Exception as e:
        print(f"  ! Podcast audio failed: {e}")
    return False


def build_podcast(report_data: dict, script_only: bool = False):
    """Returns (script_path, audio_path); either may be None. Never raises -
    a podcast problem must not stop the daily report going out."""
    day = report_data.get("date", date.today().isoformat())
    script_path = OUTPUT_DIR / f"{day}_briefing_sv.txt"
    audio_path = OUTPUT_DIR / f"{day}_briefing_sv.m4a"
    try:
        script = build_script(report_data)
    except Exception as e:
        print(f"  ! Podcast script failed: {e}")
        return None, None

    script_path.write_text(script, encoding="utf-8")
    print(f"  Podcast script: {script_path.name} ({len(script.split())} ord)")
    if script_only:
        return script_path, None
    if render_audio(script, audio_path):
        mb = audio_path.stat().st_size / 1_000_000
        print(f"  Podcast audio:  {audio_path.name} ({mb:.1f} MB)")
        return script_path, audio_path
    return script_path, None


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    day = args[0] if args else date.today().isoformat()
    data = json.load(open(OUTPUT_DIR / f"{day}_report_data.json", encoding="utf-8"))
    build_podcast(data, script_only="--script-only" in sys.argv)
