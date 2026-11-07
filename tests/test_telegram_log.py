"""The Telegram channel log: parsing a t.me/s page, keeping views by age,
and the per-channel figures (copied text, strikes matched)."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import telegram_log as T

PAGE = """
<div class="tgme_channel_info_counter"><span class="counter_value">1.2M</span> <span class="counter_type">subscribers</span></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="rybar/100">
<div class="tgme_widget_message_forwarded_from accent_color">Forwarded from <a class="tgme_widget_message_forwarded_from_name" href="https://t.me/mod_russia/55"><span>Минобороны</span></a></div>
<div class="tgme_widget_message_text js-message_text" dir="auto">Сбили БПЛА над <b>Брянской</b> областью<br/>подробности</div>
<span class="tgme_widget_message_views">12.5K</span><time datetime="2026-11-07T01:10:00+00:00" class="time">01:10</time></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="rybar/101">
<a class="tgme_widget_message_photo_wrap" href="#"></a>
<div class="tgme_widget_message_text js-message_text" dir="auto">Обзор дня</div>
<span class="tgme_widget_message_views">900</span><time datetime="2026-11-07T05:00:00+00:00" class="time">05:00</time></div></div>
"""


def test_parse_page():
    subs, posts = T.parse_page(PAGE)
    assert subs == 1_200_000
    a, b = posts
    assert a["id"] == "rybar/100" and a["views"] == 12_500 and a["fwd_from"] == "mod_russia"
    assert "Брянской" in a["text"] and "\n" in a["text"]
    assert b["photo"] and not b["fwd_from"] and b["views"] == 900


def test_views_kept_by_age():
    now = datetime(2026, 11, 7, 3, 0, tzinfo=timezone.utc)
    _, posts = T.parse_page(PAGE)
    rec = T.merge(None, posts[0], "rybar", now)            # 1.8 h old
    assert rec["views_at"] == {"1": 12_500} and rec["first_views"][1] == 12_500
    later = dict(posts[0], views=40_000)
    rec = T.merge(rec, later, "rybar", now + timedelta(hours=30))
    assert rec["views_at"]["24"] == 40_000 and rec["views_at"]["1"] == 12_500


def test_places():
    assert T.places_in("Удар по Сумам, сумма ущерба") == {"sumy"}
    assert T.places_in("В Нижнем Новгороде пожар") == {"nizhny novgorod"}
    assert T.place_key("Saratovs oljeraffinaderi, Saratov oblast") == "saratov"
    assert T.place_key("Orjol") == "oryol"


def test_stats_copies_and_strikes(tmp_path, monkeypatch):
    monkeypatch.setattr(T, "DATA_DIR", tmp_path)
    monkeypatch.setattr(T, "TG_DIR", tmp_path / "telegram")
    monkeypatch.setattr(T, "POSTS_DIR", tmp_path / "telegram" / "posts")
    monkeypatch.setattr(T, "CHANNELS_PATH", tmp_path / "telegram" / "channels.json")
    monkeypatch.setattr(T, "STATS_PATH", tmp_path / "telegram" / "stats.json")
    monkeypatch.setattr(T, "CHANNELS", {"a": "milblogg", "b": "propaganda"})
    (tmp_path / "forces.json").write_text(json.dumps({"bases": [], "nights": [{"date": "2026-11-07", "attacks": [],
        "other": [{"date": "2026-11-07", "search_name": "Bryansk Oblast", "place": "Brjansk oblast"}]}]}))
    long = "Это длинный текст о том что произошло сегодня ночью в регионе и что говорят местные жители об этом"
    posts = {
        "a/1": {"id": "a/1", "channel": "a", "published": "2026-11-07T00:30:00Z", "text": "Взрывы в Брянске, сбиты дроны",
                "video": True, "photo": False, "fwd_from": None, "views": 100, "views_at": {}},
        "b/1": {"id": "b/1", "channel": "b", "published": "2026-11-07T02:00:00Z", "text": "Атака БПЛА на Брянск отражена",
                "photo": False, "video": False, "fwd_from": None, "views": 100, "views_at": {}},
        "b/2": {"id": "b/2", "channel": "b", "published": "2026-11-07T03:00:00Z", "text": "Удар по Воронежу",
                "photo": False, "video": False, "fwd_from": None, "views": 100, "views_at": {}},
        "a/2": {"id": "a/2", "channel": "a", "published": "2026-11-07T04:00:00Z", "text": long, "views": 5, "views_at": {}},
        "b/3": {"id": "b/3", "channel": "b", "published": "2026-11-07T05:00:00Z", "text": long + "!", "views": 5, "views_at": {}},
    }
    T.save_days(posts, ["2026-11-07"])
    r = T.stats(datetime(2026, 11, 8, 4, 0, tzinfo=timezone.utc))
    a, b = r["channels"]["a"], r["channels"]["b"]
    assert r["strikes_mentioned"] == 1
    assert a["strikes_first"] == 1 and a["strikes_own_media"] == 1 and b["strikes_first"] == 0
    assert b["median_lead_min"] == 90
    assert b["strike_posts"] == 2 and b["strike_posts_matched"] == 1       # Voronezh: no known strike
    assert b["copied"] == 1 and a["origin_of_copies"] == 1
