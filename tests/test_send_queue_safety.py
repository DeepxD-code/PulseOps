"""Safety tests for deferred G7/G8 queue consumption."""
from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-store" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "pulse-outreach" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    from pulseops_store import db_manager as db

    old_path = db.DB_PATH
    db.DB_PATH = tmp_path / "send-queue-safety.db"
    db.init_db()
    try:
        yield db
    finally:
        db.DB_PATH = old_path


def _queued_job(db, title: str, score: int) -> int:
    job_id = db.save_job(
        title=title,
        company=f"{title} Company",
        link=f"https://jobs.example.com/{title.lower()}",
        source="Test",
        status="EmailQueued",
        score=score,
    )
    db.enqueue_send(job_id, score, "G8 test")
    return job_id


def test_atomic_queue_claim_never_returns_same_item_to_two_workers(temp_db):
    _queued_job(temp_db, "Alpha", 90)
    _queued_job(temp_db, "Beta", 80)

    def claim_once(_index):
        return temp_db.claim_pending_queue_item()

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(claim_once, range(8)))

    claimed_ids = [int(row["id"]) for row in rows if row]
    assert len(claimed_ids) == 2
    assert len(set(claimed_ids)) == 2
    assert temp_db.claim_pending_queue_item() is None
    assert temp_db.get_pending_queue_items() == []


def test_queue_drain_defers_temporary_and_resolves_human_review(temp_db, monkeypatch):
    from pulseops_outreach import send_engine as engine

    first_job = _queued_job(temp_db, "Deferred", 90)
    second_job = _queued_job(temp_db, "Review", 80)

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {
            "action": "QUEUE",
            "reason": "outside send window",
            "guardrail": "G8",
        },
    )
    first = engine.process_pending_send_queue({}, run_id="queue-test", limit=1)
    assert first["deferred"] == 1
    assert temp_db.get_job(first_job)["status"] == "EmailQueued"
    first_queue = temp_db.get_pending_queue_items()[0]
    assert int(first_queue["job_id"]) == first_job
    assert first_queue["status"] == "pending"

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {
            "action": "SKIP",
            "reason": "G10: no verified email",
            "guardrail": "G10",
        },
    )
    second = engine.process_pending_send_queue({}, run_id="queue-test", limit=10)
    assert second["skipped"] == 2
    assert temp_db.get_job(first_job)["status"] == "NeedsReview"
    assert temp_db.get_job(second_job)["status"] == "NeedsReview"
    assert temp_db.get_pending_queue_items() == []


def test_a_deferral_records_the_reason_it_is_deferring_for(temp_db, monkeypatch):
    """The stored reason has to describe the latest attempt, not the first one.

    Twenty-four rows deferred by the 09:00-18:00 send window still read
    "current time 00:05 IST is outside send window" eighteen days later, because
    the reason was written once at queue time and never refreshed. Read on its
    own that says the drain is broken; what it actually said was the hour the
    job happened to be first queued at.
    """
    from pulseops_outreach import send_engine as engine

    job_id = _queued_job(temp_db, "NightQueued", 90)
    assert temp_db.get_pending_queue_items()[0]["reason"] == "G8 test"

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {
            "action": "QUEUE",
            "reason": "current time 00:05 IST is outside send window 09:00-18:00",
            "guardrail": "G8",
        },
    )
    engine.process_pending_send_queue({}, run_id="queue-test", limit=1)
    rows = temp_db.get_pending_queue_items()
    assert len(rows) == 1
    assert int(rows[0]["job_id"]) == job_id
    assert "00:05" in rows[0]["reason"]

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {
            "action": "QUEUE",
            "reason": "current time 18:00 IST is outside send window 09:00-18:00",
            "guardrail": "G8",
        },
    )
    engine.process_pending_send_queue({}, run_id="queue-test", limit=1)
    refreshed = temp_db.get_pending_queue_items()
    assert "18:00" in refreshed[0]["reason"]
    assert "00:05" not in refreshed[0]["reason"]
    # Still pending and still the same job: the refresh must not consume it.
    assert int(refreshed[0]["job_id"]) == job_id
    assert temp_db.get_job(job_id)["status"] == "EmailQueued"


def test_queue_send_and_transport_uncertainty_are_not_retried(temp_db, monkeypatch):
    from pulseops_outreach import send_engine as engine

    sent_job = _queued_job(temp_db, "Sent", 90)
    uncertain_job = _queued_job(temp_db, "Uncertain", 80)

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {"action": "SEND", "reason": "sent", "guardrail": None},
    )
    sent = engine.process_pending_send_queue({}, run_id="queue-test", limit=1)
    assert sent["sent"] == 1
    assert temp_db.get_job(sent_job)["status"] == "Sent"

    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: {
            "action": "SKIP",
            "reason": "SMTP failure: connection reset",
            "guardrail": None,
        },
    )
    uncertain = engine.process_pending_send_queue({}, run_id="queue-test", limit=1)
    assert uncertain["uncertain"] == 1
    assert temp_db.get_job(uncertain_job)["status"] == "NeedsVerification"
    assert temp_db.get_pending_queue_items() == []


def test_queue_drain_cleans_duplicate_for_already_resolved_job(temp_db, monkeypatch):
    from pulseops_outreach import send_engine as engine

    job_id = temp_db.save_job(
        title="Already Applied",
        company="Applied Company",
        link="https://jobs.example.com/applied",
        source="Test",
        status="Applied",
        score=95,
    )
    temp_db.enqueue_send(job_id, 95, "duplicate legacy queue")
    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("resolved job reached send decision")
        ),
    )
    result = engine.process_pending_send_queue({}, run_id="queue-test", limit=5)
    assert result["skipped"] == 1
    assert temp_db.get_job(job_id)["status"] == "Applied"
    assert temp_db.get_pending_queue_items() == []


def test_queue_claim_prefers_india_board_even_at_a_lower_score(temp_db):
    # The daily cap (ten sends) is the scarce resource, and score alone spent it
    # on US ATS rows: Databricks 95, MongoDB 92 and Scale AI 88 drained first
    # while the India roles that are winnable from Greater Noida sat behind them.
    # India-native boards now rank first; the score still orders within a market.
    us_job = temp_db.save_job(
        title="Software Engineering Intern (2027)",
        company="databricks",
        link="https://databricks.com/jobs/2027",
        source="Databricks",
        status="EmailQueued",
        score=95,
    )
    temp_db.enqueue_send(us_job, 95, "G8 us")
    india_job = temp_db.save_job(
        title="Backend Engineer",
        company="Astra",
        link="https://wellfound.com/company/astra/jobs/backend",
        source="Wellfound India (Backend)",
        status="EmailQueued",
        score=78,
    )
    temp_db.enqueue_send(india_job, 78, "G8 india")

    claimed = temp_db.claim_pending_queue_item()
    assert claimed is not None
    assert int(claimed["job_id"]) == india_job
    # And the US row is still reachable afterwards - nothing was dropped.
    second = temp_db.claim_pending_queue_item()
    assert second is not None
    assert int(second["job_id"]) == us_job


def test_stale_processing_claim_is_resolved_without_retry(temp_db, monkeypatch):
    from pulseops_outreach import send_engine as engine
    from datetime import datetime, timedelta

    job_id = _queued_job(temp_db, "Stale", 90)
    claimed = temp_db.claim_pending_queue_item()
    assert claimed is not None
    conn = temp_db.get_connection()
    conn.execute(
        "UPDATE send_queue SET processed_at=? WHERE id=?",
        ((datetime.now() - timedelta(hours=2)).isoformat(), claimed["id"]),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(
        engine,
        "decide_send",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("stale ambiguous queue claim was retried")
        ),
    )
    result = engine.process_pending_send_queue({}, run_id="queue-test", limit=5)
    assert result["uncertain"] == 1
    assert result["claimed"] == 0
    assert temp_db.get_job(job_id)["status"] == "NeedsVerification"
    assert temp_db.get_pending_queue_items() == []


def test_live_decide_send_pause_fails_closed_before_other_guards(monkeypatch):
    from pulseops_outreach import send_engine as engine
    from pulseops_store import db_manager as db

    monkeypatch.setattr(db, "get_send_paused", lambda: True)
    monkeypatch.setattr(
        engine,
        "_check_g1_score",
        lambda *args: (_ for _ in ()).throw(AssertionError("G1 ran before pause")),
    )
    result = engine.decide_send(
        job_id=1,
        job={"company": "Acme", "title": "Backend"},
        eval_result={"match_percentage": 1},
        settings={},
        run_id="pause-test",
        simulate=False,
    )
    assert result["action"] == "QUEUE"
    assert result["guardrail"] == "PAUSE"
