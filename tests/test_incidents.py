"""Version 3.48: the incident log."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import incidents as I

TODAY = date.today().isoformat()
REFS = {"A1": {"title": "Fire at warehouse", "source": "Reuters", "url": "https://www.reuters.com/a"},
        "A2": {"title": "Arson suspected", "source": "BBC", "url": "https://www.bbc.com/b"}}


def raw(**kw):
    r = {"date": TODAY, "cat": "sabotage", "country": "PL", "place": "Warsaw", "title_sv": "Brand i lager",
         "summary_sv": "Ett lager brann.", "attribution": "misstänkt", "refs": ["A1"]}
    r.update(kw)
    return r


def test_clean_keeps_a_good_incident_and_finds_the_place():
    c = I.clean(raw(), REFS, "svep", TODAY)
    assert c and c["precision"] == "ort" and c["place"] in ("Warsaw", "Warszawa") and c["sources"][0]["outlet"] == "Reuters"


def test_clean_drops_russia_belarus_unknown_kinds_and_unsourced():
    assert I.clean(raw(country="RU"), REFS, "svep", TODAY) is None
    assert I.clean(raw(country="BY"), REFS, "svep", TODAY) is None
    assert I.clean(raw(cat="uttalande"), REFS, "svep", TODAY) is None
    assert I.clean(raw(refs=["A9"]), REFS, "svep", TODAY) is None
    assert I.clean(raw(country="US"), REFS, "svep", TODAY) is None


def test_unknown_place_falls_back_to_the_country():
    c = I.clean(raw(place="Nowhereville"), REFS, "svep", TODAY)
    assert c["precision"] == "land" and c["place"] is None and c["place_named"] == "Nowhereville"


def test_future_date_becomes_today_and_bad_attribution_unclear():
    c = I.clean(raw(date="2099-01-01", attribution="kanske"), REFS, "svep", TODAY)
    assert c["date"] == TODAY and c["attribution"] == "oklar"


def test_merge_joins_the_same_incident_and_upgrades_it():
    st = {"incidents": []}
    a = I.clean(raw(), REFS, "svep", TODAY)
    b = I.clean(raw(refs=["A2"], attribution="bekräftad"), REFS, "svep", TODAY)
    assert I.merge(st, [a]) == (1, 0)
    assert I.merge(st, [b]) == (0, 1)
    assert len(st["incidents"]) == 1 and len(st["incidents"][0]["sources"]) == 2
    assert st["incidents"][0]["attribution"] == "bekräftad"


def test_merge_keeps_different_kinds_and_far_dates_apart():
    st = {"incidents": []}
    I.merge(st, [I.clean(raw(), REFS, "svep", TODAY)])
    I.merge(st, [I.clean(raw(cat="dronare"), REFS, "svep", TODAY)])
    I.merge(st, [I.clean(raw(date="2026-01-01"), REFS, "svep", TODAY)])
    assert len(st["incidents"]) == 3


def test_history_seeds_once_and_has_sources():
    st = {"incidents": []}
    n = I.seed_history(st)
    assert n >= 20 and I.seed_history(st) == 0
    assert all(i["sources"] and i["country"] not in ("RU", "BY") for i in st["incidents"])


def test_prefilter_finds_incidents_and_skips_the_rest():
    items = [{"title": "Drone sighting closes Copenhagen airport", "summary": ""},
             {"title": "EU leaders meet to discuss budget", "summary": ""},
             {"title": "Polen: sabotaż na torach", "summary": ""}]
    got = I.incident_like(items)
    assert len(got) == 2


def test_pool_articles_with_link_are_sources():
    """20 Nov 2026: the backfill kept 0 of 35 - pool articles carry "link", not "url"."""
    refs = {"A1": {"title": "Fire", "source": "Reuters", "link": "https://www.reuters.com/x"}}
    c = I.clean(raw(), refs, "svep", TODAY)
    assert c and c["sources"][0]["url"] == "https://www.reuters.com/x"
