"""Focused, offline checks for workflow state and liveness safety."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "weekly-scan" / "src"))

from pulseops_weekly import main_weekly as weekly  # noqa: E402


WORKFLOW_NAMES = ("daily", "weekly", "watcher")
LIVE_GUARDS = {"daily": "simulate", "weekly": "simulate", "watcher": "dry_run"}
WORKFLOWS = {
    name: (ROOT / ".github" / "workflows" / f"{name}.yml").read_text(encoding="utf-8")
    for name in WORKFLOW_NAMES
}


def _step_containing(text: str, needle: str) -> str:
    """Return one workflow step without requiring a YAML parser."""
    marker = text.index(needle)
    start = text.rfind("\n      -", 0, marker)
    if start < 0:
        start = 0
    else:
        start += 1
    end = text.find("\n      -", marker)
    return text[start:] if end < 0 else text[start:end]


def _concurrency_block(text: str) -> str:
    start = text.index("\nconcurrency:\n") + len("\nconcurrency:\n")
    end = text.index("\njobs:\n", start)
    return text[start:end]


def _state_steps(text: str) -> dict[str, str]:
    return {
        "checkout": _step_containing(text, "Checkout persistent state (pulseops-state branch)"),
        "capture": _step_containing(text, "Capture exact state commit for the save lease"),
        "restore": _step_containing(text, "Restore DB + logs + memory from state branch"),
        "save": _step_containing(text, "Commit state back to pulseops-state branch"),
    }


def test_all_workflows_share_one_non_canceling_state_concurrency_group():
    blocks = [_concurrency_block(WORKFLOWS[name]) for name in WORKFLOW_NAMES]
    groups = []
    for block in blocks:
        match = re.search(r"^  group:\s*(\S+)\s*$", block, re.MULTILINE)
        assert match is not None
        groups.append(match.group(1))
        assert re.search(r"^  cancel-in-progress:\s*false\s*$", block, re.MULTILINE)

    # Literal shared membership also places simulations/dry runs in the lock;
    # separate GitHub concurrency groups would still be allowed to overlap.
    assert len(set(groups)) == 1


@pytest.mark.parametrize("name", WORKFLOW_NAMES)
def test_state_restore_and_save_select_encryption_or_plaintext(name):
    text = WORKFLOWS[name]
    steps = _state_steps(text)
    restore = steps["restore"]
    save = steps["save"]

    # Both sides of the persistence contract use the same secret switch.
    assert 'STATE_KEY: ${{ secrets.STATE_KEY }}' in restore
    assert 'STATE_KEY: ${{ secrets.STATE_KEY }}' in save
    assert "id: state_checkout" in steps["checkout"]
    assert "set -euo pipefail" in restore
    assert "set -euo pipefail" in save
    assert "git -C .state rev-parse --verify HEAD" in restore
    assert "state checkout is unavailable; refusing to bootstrap" in restore

    encrypted = restore.index("if [ -f .state/pulseops.db.enc ]; then")
    missing_key = restore.index('if [ -z "${STATE_KEY:-}" ]; then')
    decrypt = restore.index("openssl enc -d")
    missing_artifact = restore.index('elif [ -n "${STATE_KEY:-}" ]; then')
    plaintext = restore.index("cp .state/pulseops.db pulseops.db")
    bootstrap = restore.index("successful state checkout contains no prior DB")
    assert encrypted < missing_key < decrypt < missing_artifact < plaintext < bootstrap
    assert "encrypted state exists but STATE_KEY is empty" in restore
    assert "STATE_KEY is configured but no encrypted state artifact exists" in restore
    assert "pulseops.db.enc" in save
    assert "openssl enc -aes-256-cbc" in save
    assert 'if [ -n "${STATE_KEY:-}" ]; then' in save
    assert "cp pulseops.db .state/pulseops.db" in save

    # A configured key must never silently downgrade to plaintext on an
    # encryption/decryption error.
    assert "|| cp pulseops.db .state/pulseops.db" not in save
    assert "refusing plaintext fallback" in save
    assert "refusing to continue" in restore


@pytest.mark.parametrize("name", WORKFLOW_NAMES)
def test_live_state_checkout_is_mandatory_and_save_reuses_its_exact_sha(name):
    text = WORKFLOWS[name]
    steps = _state_steps(text)
    checkout = steps["checkout"]
    capture = steps["capture"]
    restore = steps["restore"]
    save = steps["save"]

    # A missing or unavailable state branch fails the live run. The capture and
    # restore steps are explicitly downstream of a successful checkout.
    assert "continue-on-error" not in checkout
    assert "ref: pulseops-state" in checkout
    assert "path: .state" in checkout
    assert "steps.state_checkout.outcome == 'success'" in capture
    assert "steps.state_checkout.outcome == 'success'" in restore
    assert "steps.state_base.outcome == 'success'" in restore
    assert text.index("Checkout persistent state") < text.index("Capture exact state commit")
    assert text.index("Capture exact state commit") < text.index("Restore DB + logs")

    # Capture one immutable value during checkout; never derive a lease from a
    # new remote observation during save.
    assert "git -C .state rev-parse --verify 'HEAD^{commit}'" in capture
    assert 'echo "base_sha=${STATE_BASE_SHA}" >> "$GITHUB_OUTPUT"' in capture
    assert "STATE_BASE_SHA: ${{ steps.state_base.outputs.base_sha }}" in save
    for outcome in ("state_checkout", "state_base", "state_restore"):
        assert f"steps.{outcome}.outcome == 'success'" in save
    assert "git fetch" not in save
    assert "git ls-remote" not in save
    assert "refs/remotes/origin/pulseops-state" not in save
    assert "LEASE=" not in save

    assert save.count("git push") == 1
    assert '--force-with-lease="refs/heads/pulseops-state:${STATE_BASE_SHA}"' in save
    assert not re.search(r"--force(?!-with-lease)", save)
    assert '--force-with-lease="refs/heads/pulseops-state:"' not in save
    assert "no prior state branch" not in save


def test_all_three_workflows_have_identical_state_semantics():
    for name in WORKFLOW_NAMES:
        text = WORKFLOWS[name]
        steps = _state_steps(text)
        assert "continue-on-error" not in steps["checkout"]
        assert "id: state_checkout" in steps["checkout"]
        assert "Capture exact state commit" in steps["capture"]
        assert "GITHUB_OUTPUT" in steps["capture"]
        assert "STATE_BASE_SHA" in steps["save"]
        assert '--force-with-lease="refs/heads/pulseops-state:${STATE_BASE_SHA}"' in steps["save"]
        assert "git fetch" not in steps["save"]
        assert "encrypted state exists but STATE_KEY is empty" in steps["restore"]


@pytest.mark.parametrize("name", ["daily", "weekly"])
def test_simulation_has_no_secret_install_or_doctor_sync(name):
    text = WORKFLOWS[name]
    simulation = _step_containing(text, "Prepare simulation environment (no secrets)")
    live_secrets = _step_containing(text, "Write secrets to disk (per-secret, no ENV_FILE blob)")
    sync = _step_containing(text, "Sync profile.yml from cv.md if changed")

    assert "if: ${{ inputs.simulate != true }}" in live_secrets
    assert "if: ${{ inputs.simulate == true }}" in simulation
    assert "${{ secrets." not in simulation
    for forbidden in (
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "SEARCHAPI_API_KEY",
        "THEIRSTACK_API_KEY",
        "SMTP_PASSWORD",
        "CV_MD",
        "doctor --init",
        "doctor --sync",
    ):
        assert forbidden not in simulation

    assert "inputs.simulate != true" in sync
    assert "doctor --init" in sync
    assert "doctor --sync-profile" in sync

    # A simulation must not check out, capture, restore, or push live state.
    steps = _state_steps(text)
    for step in steps.values():
        assert "inputs.simulate != true" in step
    assert "always() && inputs.simulate != true" in steps["save"]


def test_daily_live_state_keeps_deferred_queue_and_review_webhook():
    text = WORKFLOWS["daily"]
    restore = _step_containing(text, "Restore DB + logs + memory from state branch")
    live_secrets = _step_containing(text, "Write secrets to disk (per-secret, no ENV_FILE blob)")
    assert "UPDATE send_queue" not in restore
    assert "DISCORD_REVIEW_WEBHOOK_URL: ${{ secrets.DISCORD_REVIEW_WEBHOOK_URL }}" in live_secrets
    assert 'echo "DISCORD_REVIEW_WEBHOOK_URL=' in live_secrets


def test_watcher_dry_run_does_not_install_credentials_or_save_live_state():
    text = WORKFLOWS["watcher"]
    dry_run = _step_containing(text, "Prepare dry-run environment (no credentials)")
    live_secrets = _step_containing(text, "Write live watcher secrets to disk")
    save = _step_containing(text, "Commit state back to pulseops-state branch")

    assert "if: ${{ inputs.dry_run == true }}" in dry_run
    assert "${{ secrets." not in dry_run
    assert "SMTP_PASSWORD" not in dry_run
    assert "if: ${{ inputs.dry_run != true }}" in live_secrets
    assert "always() && inputs.dry_run != true" in save


def test_weekly_live_env_explicitly_contains_smtp_and_existing_keys():
    text = WORKFLOWS["weekly"]
    live = _step_containing(text, "Write secrets to disk (per-secret, no ENV_FILE blob)")
    for key in ("AUTO_SEND_EMAILS", "SMTP_HOST", "SMTP_PORT", "SMTP_EMAIL", "SMTP_PASSWORD"):
        assert f"{key}: ${{{{ secrets.{key} }}}}" in live
        assert f'echo "{key}=' in live

    for key in (
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "SEARCHAPI_API_KEY",
        "THEIRSTACK_API_KEY",
        "DISCORD_WEBHOOK_URL",
        "DISCORD_REVIEW_WEBHOOK_URL",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID",
    ):
        assert f"{key}: ${{{{ secrets.{key} }}}}" in live
        assert f'echo "{key}=' in live


def test_liveness_dead_portals_are_data_not_tool_failure(monkeypatch):
    payload = {
        "results": [
            {
                "name": "dead-live",
                "url": "https://dead.example",
                "enabled": True,
                "requires_auth": False,
                "ok": False,
            },
            {
                "name": "healthy",
                "url": "https://healthy.example",
                "enabled": True,
                "requires_auth": False,
                "ok": True,
            },
            {
                "name": "disabled-dead",
                "url": "https://disabled.example",
                "enabled": False,
                "requires_auth": False,
                "ok": False,
            },
            {
                "name": "auth-dead",
                "url": "https://auth.example",
                "enabled": True,
                "requires_auth": True,
                "ok": False,
            },
        ],
        "dead_count": 1,
    }
    monkeypatch.setattr(
        weekly.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps(payload),
            stderr="",
        ),
    )

    dead = weekly._run_liveness_check()
    assert dead == [payload["results"][0]]


def test_liveness_tool_failure_is_not_interpreted_as_dead_portals(monkeypatch):
    monkeypatch.setattr(
        weekly.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=2,
            stdout=json.dumps({"results": []}),
            stderr="tool failed",
        ),
    )

    assert weekly._run_liveness_check() is None


def test_scan_passes_only_reported_dead_portals_to_scanner(tmp_path, monkeypatch):
    output = tmp_path / "temp_portal_jobs.json"
    monkeypatch.setattr(weekly, "TEMP_PORTAL_JSON", output)
    commands: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        commands.append(list(cmd))
        output.write_text(json.dumps({"jobs": [], "skipped": [], "failed": []}), encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(weekly.subprocess, "run", fake_run)
    weekly._run_scan(
        simulate=False,
        dead_portals=[{"name": "dead-live", "url": "https://dead.example", "engine": "greenhouse"}],
    )

    assert commands
    assert "--skip-portal=https://dead.example" in commands[0]
    assert "--skip-portal=dead-live" not in commands[0]
    assert "--skip-portal=greenhouse" not in commands[0]
    assert not any("healthy" in arg for arg in commands[0])


def test_check_liveness_source_exits_zero_for_completed_report():
    source = (ROOT / "apps" / "weekly-scan" / "check_liveness.mjs").read_text(encoding="utf-8")
    assert "process.exit(dead.length > 0 ? 1 : 0)" not in source
    assert "process.exitCode = 0" in source
    assert "process.exitCode = 1" in source
