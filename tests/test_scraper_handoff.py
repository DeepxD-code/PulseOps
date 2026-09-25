"""LinkedIn bridge hand-off safety tests (no network or browser)."""
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
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_core.exceptions import LinkedInBridgeError  # noqa: E402
from pulseops_core import scraper as scraper_module  # noqa: E402


def _configure_paths(tmp_path, monkeypatch):
    tier2_dir = tmp_path / "apps" / "weekly-scan"
    tier2_dir.mkdir(parents=True)
    bridge = tier2_dir / "linkedin_bridge.js"
    tier2 = tier2_dir / "temp_linkedin_jobs.json"
    legacy = tmp_path / "temp_linkedin_jobs.json"
    bridge.write_text("// test bridge\n", encoding="utf-8")
    monkeypatch.setattr(scraper_module, "LINKEDIN_BRIDGE", bridge)
    monkeypatch.setattr(scraper_module, "LINKEDIN_TEMP_JSON", tier2)
    monkeypatch.setattr(scraper_module, "LEGACY_LINKEDIN_TEMP_JSON", legacy)
    monkeypatch.setattr(scraper_module, "_BRIDGE_CANDIDATES", [bridge])
    monkeypatch.setattr(scraper_module, "_TEMP_CANDIDATES", [tier2, legacy])
    return bridge, tier2, legacy


def test_linkedin_reads_only_fresh_tier2_handoff(tmp_path, monkeypatch):
    _bridge, tier2, legacy = _configure_paths(tmp_path, monkeypatch)
    stale = [{"position": "stale root", "company": "Old Co", "jobUrl": "https://www.linkedin.com/jobs/view/stale"}]
    legacy.write_text(json.dumps(stale), encoding="utf-8")
    old = time.time() - 60
    os.utime(legacy, (old, old))

    def fake_run(*args, **kwargs):
        # The pre-launch cleanup must remove both known hand-off locations.
        assert not legacy.exists()
        assert not tier2.exists()
        tier2.write_text(
            json.dumps([
                {
                    "position": "Fresh Backend Intern",
                    "company": "Acme",
                    "location": "India",
                    "jobUrl": "https://www.linkedin.com/jobs/view/fresh",
                }
            ]),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(scraper_module.subprocess, "run", fake_run)
    jobs = scraper_module.PulseOpsScraper().fetch_linkedin()

    assert [job["title"] for job in jobs] == ["Fresh Backend Intern"]
    assert not tier2.exists()
    assert not legacy.exists()


def test_linkedin_rejects_exit_zero_with_stale_tier2_mtime(tmp_path, monkeypatch):
    _bridge, tier2, legacy = _configure_paths(tmp_path, monkeypatch)

    def fake_run(*args, **kwargs):
        tier2.write_text(
            json.dumps([{"position": "stale", "jobUrl": "https://www.linkedin.com/jobs/view/stale"}]),
            encoding="utf-8",
        )
        old = time.time() - 60
        os.utime(tier2, (old, old))
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(scraper_module.subprocess, "run", fake_run)
    with pytest.raises(LinkedInBridgeError, match="stale"):
        scraper_module.PulseOpsScraper().fetch_linkedin()
    assert not tier2.exists()
    assert not legacy.exists()


def test_linkedin_never_reuses_stale_files_on_failed_or_timed_out_bridge(tmp_path, monkeypatch):
    _bridge, tier2, legacy = _configure_paths(tmp_path, monkeypatch)
    stale = [{"position": "stale", "jobUrl": "https://www.linkedin.com/jobs/view/stale"}]
    tier2.write_text(json.dumps(stale), encoding="utf-8")
    legacy.write_text(json.dumps(stale), encoding="utf-8")
    old = time.time() - 60
    os.utime(tier2, (old, old))
    os.utime(legacy, (old, old))

    monkeypatch.setattr(
        scraper_module.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr="bridge failed"),
    )
    with pytest.raises(LinkedInBridgeError):
        scraper_module.PulseOpsScraper().fetch_linkedin()
    assert not tier2.exists()
    assert not legacy.exists()

    # Recreate stale files and verify timeout is fail-closed as well.
    tier2.write_text(json.dumps(stale), encoding="utf-8")
    legacy.write_text(json.dumps(stale), encoding="utf-8")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="node", timeout=1)

    monkeypatch.setattr(scraper_module.subprocess, "run", timeout)
    with pytest.raises(LinkedInBridgeError, match="timed out"):
        scraper_module.PulseOpsScraper().fetch_linkedin()
    assert not tier2.exists()
    assert not legacy.exists()
