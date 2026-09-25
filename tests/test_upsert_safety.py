"""Regression tests for job upsert status protection."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages" / "pulse-store" / "src"))

from pulseops_store import db_manager as db  # noqa: E402


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    old_path = db.DB_PATH
    db.DB_PATH = tmp_path / "upsert-safety.db"
    db.init_db()
    try:
        yield db
    finally:
        db.DB_PATH = old_path


@pytest.mark.parametrize(
    "status",
    [
        "Applied", "Sent", "FollowupSent", "Verified", "NeedsReview",
        "NeedsVerification", "Expired", "Skipped", "Simulated", "SendPaused",
        "EmailQueued", "Applying", "Replied", "phone_screen", "technical",
        "final", "offer", "accepted", "rejected",
    ],
)
def test_force_upsert_never_downgrades_protected_status(temp_db, status):
    link = "https://www.linkedin.com/jobs/view/protected"
    original_id = temp_db.save_job(
        title="Backend Intern", company="Acme", link=link,
        source="LinkedIn", status=status, score=55,
    )

    same_id = temp_db.save_job(
        title="Backend Intern (new title)", company="Acme", link=link,
        source="re-evaluation", status="Evaluated", score=99,
    )

    row = temp_db.get_job(original_id)
    assert same_id == original_id
    assert row["status"] == status
    assert row["title"] == "Backend Intern"
    assert row["link"] == link


def test_exact_link_collision_cannot_replace_terminal_identity(temp_db):
    link = "https://boards.greenhouse.io/acme/jobs/42"
    original_id = temp_db.save_job(
        title="Original Role", company="Acme", link=link,
        source="Greenhouse", status="Applied", score=91,
    )

    collision_id = temp_db.save_job(
        title="Different Role", company="Other Tenant", link=link,
        source="Untrusted Scraper", status="Evaluated", score=10,
    )

    row = temp_db.get_job(original_id)
    assert collision_id == original_id
    assert row["status"] == "Applied"
    assert row["title"] == "Original Role"
    assert row["company"] == "Acme"
    assert row["link"] == link


def test_explicit_status_transition_remains_available(temp_db):
    job_id = temp_db.save_job(title="Role", company="Acme", status="Evaluated")
    temp_db.update_job_status(job_id, "Applied")
    assert temp_db.get_job(job_id)["status"] == "Applied"
