"""Focused regression tests for persisted pause and job-claim state."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-store" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_core.exceptions import DatabaseError  # noqa: E402
from pulseops_store import db_manager as db  # noqa: E402


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    old_path = db.DB_PATH
    db.DB_PATH = tmp_path / "db-state-semantics.db"
    db.init_db()
    try:
        yield db
    finally:
        db.DB_PATH = old_path


@pytest.mark.parametrize(
    "raw",
    ["1", "true", "TRUE", "TrUe", "yes", "YES", "on", "ON", " true "],
)
def test_get_send_paused_accepts_true_variants(temp_db, raw):
    temp_db.set_setting("send_paused", raw)
    assert temp_db.get_send_paused() is True


@pytest.mark.parametrize(
    "raw",
    ["0", "false", "FALSE", "FaLsE", "no", "NO", "off", "OFF", "", "   "],
)
def test_get_send_paused_accepts_false_variants(temp_db, raw):
    temp_db.set_setting("send_paused", raw)
    assert temp_db.get_send_paused() is False


@pytest.mark.parametrize("raw", ["maybe", "2", "enabled", "truthy"])
def test_get_send_paused_rejects_malformed_values(temp_db, raw):
    temp_db.set_setting("send_paused", raw)
    with pytest.raises(DatabaseError, match="send_paused"):
        temp_db.get_send_paused()


def test_save_job_preserves_applying_claim_marker_and_timestamp(temp_db):
    link = "https://jobs.lever.co/acme/backend/1"
    job_id = temp_db.save_job(
        title="Backend Intern",
        company="Acme",
        link=link,
        source="LinkedIn",
        status="Applying",
        score=91,
    )
    marker = "browser-apply-claim|2026-09-25T12:34:56.123Z|owner-A"
    conn = temp_db.get_connection()
    try:
        conn.execute("UPDATE jobs SET processed_at=? WHERE id=?", (marker, job_id))
        conn.commit()
    finally:
        conn.close()

    same_id = temp_db.save_job(
        title="Backend Intern (force re-evaluation)",
        company="Acme",
        link=link,
        source="re-evaluation",
        status="Evaluated",
        score=99,
    )

    row = temp_db.get_job(job_id)
    assert same_id == job_id
    assert row["status"] == "Applying"
    assert row["processed_at"] == marker
    assert row["title"] == "Backend Intern"
    assert row["score"] == 99
