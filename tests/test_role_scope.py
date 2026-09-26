"""Tests for the candidate's strict target-role boundary."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))

from pulseops_eval.domain_filter import hard_filter, is_strict_target_role  # noqa: E402


@pytest.mark.parametrize(
    "title",
    [
        "Full Stack Developer Intern",
        "Frontend Engineer",
        "Laravel Developer",
        "Android Engineer",
        "Embedded Systems Engineer Intern",
        "Software Engineer Intern",
    ],
)
def test_out_of_scope_titles_are_rejected(title):
    assert is_strict_target_role(title) is False
    result = hard_filter({"title": title, "description": ""}, {})
    assert result.passed is False
    assert result.stage == 1


@pytest.mark.parametrize(
    "title",
    [
        "Backend Engineer",
        "Machine Learning Engineer",
        "AI/ML Engineer",
        "Java Backend Engineer",
        "C++ Software Engineer",
        "GenAI Engineer",
    ],
)
def test_allowed_titles_pass_strict_gate(title):
    assert is_strict_target_role(title) is True
    assert hard_filter({"title": title, "description": ""}, {}).passed is True
