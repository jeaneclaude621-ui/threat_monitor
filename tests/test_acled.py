import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import acled


def ev(**k):
    base = {"event_id_cnty": "POL1234", "event_date": "2025-09-10", "event_type": "Strategic developments",
            "sub_event_type": "Other", "iso": 616, "location": "Wyryki", "latitude": "51.6", "longitude": "23.5",
            "geo_precision": "1", "source": "PAP", "notes": "Russian drones entered Polish airspace; one hit a house.",
            "tags": ""}
    base.update(k)
    return base


def test_drone_event_is_kept_and_marked():
    i = acled.to_incident(ev())
    assert i["cat"] == "dronare" and i["country"] == "PL" and i["origin"] == "acled"
    assert i["attribution"] == "misstänkt" and i["precision"] == "ort"
    assert i["sources"][0]["url"].startswith("https://acleddata.com")
    assert "Russian" not in i["title_sv"] and i["summary_sv"] == ""   # no ACLED notes text


def test_off_topic_and_excluded_countries_are_dropped():
    assert acled.to_incident(ev(notes="Unknown gang detonated an explosive at a bar.")) is None
    assert acled.to_incident(ev(iso=804)) is None          # Ukraine
    assert acled.to_incident(ev(iso=643)) is None          # Russia
    assert acled.to_incident(ev(event_type="Protests")) is None


def test_categories():
    assert acled.category("arson attack on a warehouse linked to Russia", "Looting/property destruction") == "sabotage"
    assert acled.category("undersea cable damaged", "Other") == "kabel"
    assert acled.category("man arrested for espionage", "Arrests") == "spionage"
    assert acled.category("GPS jamming affected flights", "Other") == "gps"


def test_fetch_merges_and_skips_seen(tmp_path, monkeypatch):
    import incidents
    monkeypatch.setattr(incidents, "PATH", tmp_path / "incidents.json")
    monkeypatch.setattr(acled, "STATE", tmp_path / "acled.json")
    monkeypatch.setattr(incidents, "push", lambda st: True)
    monkeypatch.setattr(acled.incidents, "save", incidents.save)
    rows = [ev(), ev(event_id_cnty="POL1235", notes="Football fans clashed.")]
    r = acled.fetch("2025-01-01", "2025-12-31", "t", get=lambda url: {"data": rows})
    assert r["rows"] == 2 and r["kept"] == 1 and r["added"] == 1
    r2 = acled.fetch("2025-01-01", "2025-12-31", "t", get=lambda url: {"data": rows})
    assert r2["kept"] == 0
