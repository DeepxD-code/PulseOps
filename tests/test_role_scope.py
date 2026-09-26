"""Tests for the candidate's strict target-role boundary.

Stage 1 only rejects unambiguous out-of-scope families and defers ambiguous
titles to the Stage 2 model. The strict title gate is still used where PII is
involved (browser apply), so it stays narrow.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))

from pulseops_eval.domain_filter import (  # noqa: E402
    hard_filter,
    is_hard_excluded_role,
    is_strict_target_role,
)

EXCLUDED = [
    "Full Stack Developer Intern",
    "AI/ML Full Stack Developer Intern",
    "Frontend Engineer",
    "Laravel Developer",
    "Android Engineer",
    "Embedded Systems Engineer Intern",
]

AMBIGUOUS_BUT_POTENTIALLY_ON_TARGET = [
    "Research Engineer, Pretraining",
    "Research Engineer, Computer Use",
    "Research Engineer, Production Model Post-Training",
    "Software Engineer Intern",
    "Python Developer",
]

EXPLICITLY_ON_TARGET = [
    "Backend Engineer",
    "Machine Learning Engineer",
    "AI/ML Engineer",
    "Java Backend Engineer",
    "C++ Software Engineer",
    "GenAI Engineer",
]


@pytest.mark.parametrize("title", EXCLUDED)
def test_excluded_families_are_rejected_at_stage_1(title):
    assert is_hard_excluded_role(title) is True
    result = hard_filter({"title": title, "description": ""}, {})
    assert result.passed is False
    assert result.stage == 1


@pytest.mark.parametrize("title", AMBIGUOUS_BUT_POTENTIALLY_ON_TARGET)
def test_ambiguous_titles_reach_stage_2_instead_of_being_dropped(title):
    # Regression: dropping every unkeyworded title silently discarded real
    # ML/AI roles such as "Research Engineer, Pretraining".
    assert is_hard_excluded_role(title) is False
    assert hard_filter({"title": title, "description": ""}, {}).passed is True


@pytest.mark.parametrize("title", EXPLICITLY_ON_TARGET)
def test_on_target_titles_pass_the_strict_gate(title):
    assert is_strict_target_role(title) is True
    assert is_hard_excluded_role(title) is False
    assert hard_filter({"title": title, "description": ""}, {}).passed is True


def test_strict_gate_stays_narrow_for_browser_apply():
    # Browser apply sends PII, so it must not act on a merely ambiguous title.
    assert is_strict_target_role("Research Engineer, Pretraining") is False
    assert is_strict_target_role("Python Developer") is False
    assert is_strict_target_role("Backend Engineer") is True
