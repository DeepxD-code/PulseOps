"""Focused tests for the weekly scan hand-off and simulation marker."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "weekly-scan" / "src"))

from pulseops_weekly import main_weekly as weekly  # noqa: E402


def test_failed_scan_discards_stale_handoff(tmp_path, monkeypatch):
    output = tmp_path / "temp_portal_jobs.json"
    output.write_text(json.dumps({"jobs": [{"title": "stale"}]}), encoding="utf-8")
    old = time.time() - 30
    os.utime(output, (old, old))
    monkeypatch.setattr(weekly, "TEMP_PORTAL_JSON", output)

    monkeypatch.setattr(
        weekly.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr="failed"),
    )

    assert weekly._run_scan(simulate=False) == ([], [], [])
    assert not output.exists()


def test_timeout_never_returns_existing_jobs(tmp_path, monkeypatch):
    output = tmp_path / "temp_portal_jobs.json"
    output.write_text(json.dumps({"jobs": [{"title": "stale"}]}), encoding="utf-8")
    monkeypatch.setattr(weekly, "TEMP_PORTAL_JSON", output)

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="node", timeout=1)

    monkeypatch.setattr(weekly.subprocess, "run", timeout)

    assert weekly._run_scan(simulate=False) == ([], [], [])
    assert not output.exists()


def test_successful_mock_handoff_is_fresh_and_marked(tmp_path, monkeypatch):
    output = tmp_path / "temp_portal_jobs.json"
    monkeypatch.setattr(weekly, "TEMP_PORTAL_JSON", output)

    def succeed(*args, **kwargs):
        output.write_text(
            json.dumps({"jobs": [{"title": "Backend", "company": "Acme", "source": "Portal"}]}),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(weekly.subprocess, "run", succeed)

    jobs, skipped, failed = weekly._run_scan(simulate=True)

    assert (skipped, failed) == ([], [])
    assert jobs[0]["source"] == "SIMULATED:Portal"
    assert not output.exists()


def test_simulation_db_cannot_alias_live_db(tmp_path, monkeypatch):
    from pulseops_store import db_manager as db

    live = tmp_path / "live.db"
    monkeypatch.setenv("PULSEOPS_DB", str(live))
    monkeypatch.setenv("PULSEOPS_SIMULATION_DB", str(live))
    with pytest.raises(RuntimeError, match="must not point"):
        weekly._use_isolated_simulation_db()
    assert db.DB_PATH != live


def test_pending_email_rows_are_not_left_evaluated(monkeypatch):
    from pulseops_store import db_manager as db

    changes = []
    monkeypatch.setattr(
        db,
        "get_pending_queue_items",
        lambda limit: [{"job_id": 7}],
    )
    monkeypatch.setattr(db, "get_job", lambda job_id: {"id": job_id, "status": "Evaluated"})
    monkeypatch.setattr(
        db,
        "update_job_status",
        lambda job_id, status: changes.append((job_id, status)),
    )

    weekly._protect_pending_email_queue()

    assert changes == [(7, "EmailQueued")]


def test_ci_simulation_never_launches_browser_apply():
    workflow = (ROOT / ".github" / "workflows" / "daily.yml").read_text(encoding="utf-8")
    assert "Simulation safety validation (no browser, job network, or PII upload)" in workflow
    assert "if: ${{ always() && inputs.simulate == true }}" in workflow
    assert "if: ${{ always() && inputs.simulate != true }}" in workflow

    # The apply step must be guarded outside simulation.  A static --check is
    # fine; a --dry-run/--live invocation in the simulation path is not.
    browser_marker = "      - name: Browser auto-apply queued jobs (hands-off)"
    start = workflow.index(browser_marker)
    browser_step = workflow[start:]
    assert 'if: ${{ always() && inputs.simulate != true }}' in browser_step.split("run:", 1)[0]
    simulation_start = workflow.index("      - name: Simulation safety validation")
    browser_start = workflow.index(browser_marker)
    assert "apps/browser-apply/apply.mjs" not in workflow[simulation_start:browser_start]
    assert "node apps/browser-apply/apply.mjs --dry-run" not in workflow[simulation_start:browser_start]
    assert "node apps/browser-apply/apply.mjs --live" not in workflow[simulation_start:browser_start]


def test_root_scripts_use_real_app_paths():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    assert scripts["scan"] == "node apps/weekly-scan/scan.mjs"
    assert scripts["scan:mock"] == "node apps/weekly-scan/scan.mjs --mock"
    assert scripts["apply"] == "node apps/browser-apply/apply.mjs --dry-run"
    assert scripts["apply:live"] == "node apps/browser-apply/apply.mjs --live --headed"
