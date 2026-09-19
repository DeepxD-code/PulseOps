"""Smoke: G1/G10 fail-closed (boss round-2 order 9)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OPEN_WINDOW = {
    "company_cooldown_days": 0,
    "daily_send_cap": 10,
    "domain_daily_limit": 10,
    "send_window_start": "00:00",
    "send_window_end": "23:59",
    "send_timezone": "Asia/Kolkata",
    "bounce_pause_threshold": 99,
    "min_send_gap_minutes": 0,
}


def test_g1_blocks_low_score():
    from pulseops_outreach.send_engine import decide_send

    job = {"company": "Acme", "title": "Backend Intern"}
    ev = {"match_percentage": 10}
    settings = {"scoring": {"send_threshold": 70}, "guardrails": {}}
    r = decide_send(1, job, ev, settings, run_id="t", simulate=True)
    assert r["action"] == "SKIP" and r["guardrail"] == "G1"


def test_searchapi_lookup_keeps_only_domain_matched(monkeypatch):
    import os
    from unittest.mock import MagicMock

    from pulseops_outreach import send_engine as se

    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "organic_results": [
            {"title": "Contact us", "snippet": "Mail us at careers@acme.com for jobs"},
            {"title": "Random", "snippet": "Write to boss@evil.com instead"},
        ]
    }
    monkeypatch.setenv("SEARCHAPI_API_KEY", "test-key")
    monkeypatch.setattr("requests.get", lambda *a, **k: resp)
    out = se._searchapi_company_emails("acme.com", "Acme")
    assert out == ["careers@acme.com"], out


def test_searchapi_lookup_no_key_returns_empty(monkeypatch):
    import os

    from pulseops_outreach import send_engine as se

    monkeypatch.delenv("SEARCHAPI_API_KEY", raising=False)
    assert se._searchapi_company_emails("acme.com", "Acme") == []


def test_domain_cache_hit_skips_lookup(monkeypatch):
    from pulseops_outreach import send_engine as se
    from pulseops_store import db_manager as db

    db.init_db()
    db.save_domain_contact("cached.com", "hr@cached.com", "site-scrape")
    monkeypatch.delenv("SEARCHAPI_API_KEY", raising=False)
    out = se._check_g10_contact("", "cached.com", "low", company="Cached")
    assert out == "hr@cached.com", out


def test_g10_no_unverified_fallback():
    from pulseops_outreach.send_engine import decide_send
    from pulseops_store import db_manager as db

    db.init_db()  # creates local pulseops.db (gitignored)
    job = {"company": "NoMailCo", "title": "Backend Intern"}
    ev = {"match_percentage": 99}
    settings = {"scoring": {"send_threshold": 70}, "guardrails": OPEN_WINDOW}
    r = decide_send(1, job, ev, settings, run_id="t", simulate=True)
    assert r["action"] == "SKIP" and r["guardrail"] == "G10", r
