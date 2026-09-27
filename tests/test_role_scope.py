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


@pytest.mark.parametrize(
    "title",
    [
        "Python Developer",
        "Python Backend Engineer",
        "Senior Python Developer",
        "Machine Learning Engineer (Python)",
        "Java Backend Developer",
        "C++ Systems Engineer Intern",
        "Backend Engineer",
    ],
)
def test_python_and_the_rest_of_the_target_stack_are_accepted(title):
    assert is_strict_target_role(title) is True, title
    assert is_hard_excluded_role(title) is False, title


@pytest.mark.parametrize(
    "title",
    [
        "Node.js Backend Engineer",
        "JavaScript Developer",
        "Backend Developer (NodeJS)",
        "MongoDB Engineer",
        "Django Back-End Development Intern",
        "Frontend Engineer",
        "UI/UX Designer",
        "Product Designer",
        "Figma Designer",
        "Full Stack Engineer (Next.js)",
    ],
)
def test_node_js_mongo_django_frontend_and_design_roles_are_rejected(title):
    assert is_strict_target_role(title) is False, title
    assert is_hard_excluded_role(title) is True, title
    assert hard_filter({"title": title, "description": ""}, {}).passed is False, title


def test_python_is_allowed_even_though_django_is_not():
    # Both are Python, but Django is explicitly out of scope.
    assert is_strict_target_role("Python Developer") is True
    assert is_strict_target_role("Django Developer") is False


@pytest.mark.parametrize(
    "title",
    [
        "Backend Developer Intern | Entry Level | Fresher | Node.js, Python",
        "Node.js Backend Engineer",
        "Backend Developer (NodeJS)",
        "Full Stack Engineer (Next.js)",
    ],
)
def test_node_js_web_stack_is_rejected_even_when_the_title_says_backend(title):
    # Regression: Node.js roles were passing because the title also contained
    # "Backend", but Node/JS is outside the candidate's language set.
    assert is_strict_target_role(title) is False
    assert is_hard_excluded_role(title) is True
    assert hard_filter({"title": title, "description": ""}, {}).passed is False


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


@pytest.mark.parametrize(
    "title",
    [
        "RationalFirst Zero-human Accounting FirmMachine Learning Researcher Full-time",
        "Research Engineer, Chip Design RL (Reinforcement Learning)San Francisco, CA",
    ],
)
def test_scraped_titles_with_company_joined_to_role_still_match(title):
    # Regression: scraped titles concatenate company and role, so
    # "FirmMachine Learning Researcher" has no word boundary before
    # "machine" and the strict gate used to drop real ML roles.
    assert is_strict_target_role(title) is True


def test_research_titles_without_an_in_domain_keyword_are_deferred_not_dropped():
    # "Production Model Post-Training" says nothing about the domain in the
    # title, so Stage 1 must defer it to the Stage 2 model rather than drop it.
    title = "Research Engineer, Production Model Post-TrainingSan Francisco, CA"
    assert is_strict_target_role(title) is False
    assert is_hard_excluded_role(title) is False
    assert hard_filter({"title": title, "description": ""}, {}).passed is True


def test_strict_gate_stays_narrow_for_browser_apply():
    # Browser apply sends PII, so it must not act on a merely ambiguous title.
    assert is_strict_target_role("Research Engineer, Pretraining") is False
    assert is_strict_target_role("Tech Intern") is False
    assert is_strict_target_role("Backend Engineer") is True
    assert is_strict_target_role("Python Developer") is True
