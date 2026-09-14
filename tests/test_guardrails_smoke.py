"""Smoke: G1/G7/G8/G10 fail-closed (boss round-2 order 9)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_g1_blocks_low_score():
    from pulseops_outreach.send_engine import decide_send
    r = decide_send(1, {"company": "Acme", "title": "Backend Intern"}, {"match_percentage": 10}, {"scoring": {"send_threshold": 70}, "guardrails": {}}, run_id="t", simulate=True)
    assert r["action"] == "SKIP" and r["guardrail"] == "G1"


def test_g10_no_unverified_fallback():
    from pulseops_store import db_manager as db
    db.init_db()  # creates local pulseops.db (gitignored)
    from pulseops_outreach.send_engine import decide_send
    r = decide_send(1, {"company": "NoMailCo", "title": "Backend Intern"}, {"match_percentage": 99}, {"scoring": {"send_threshold": 70}, "guardrails": {"company_cooldown_days": 0, "daily_send_cap": 10, "domain_daily_limit": 10, "send_window_start": "00:00", "send_window_end": "23:59", "send_timezone": "Asia/Kolkata", "bounce_pause_threshold": 99, "min_send_gap_minutes": 0}}, run_id="t", simulate=True)
    assert r["action"] == "SKIP" and r["guardrail"] == "G10", r
