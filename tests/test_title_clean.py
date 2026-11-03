"""Title cleaning and role-scope decisions (PulseOps domain filter).

Every case here is a real string observed in a scan on 2026-11-02, or the exact
regression that made the old substring tests wrong.
"""

from __future__ import annotations

import pytest

from pulseops_eval.domain_filter import (
    hard_filter,
    is_hard_excluded_role,
    is_strict_target_role,
)
from pulseops_eval.title_clean import clean_title


# ── clean_title ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "raw, expected",
    [
        # Naukri: board chrome welded onto the role.
        ("Backend Developer Bangalore Founded in 2021 50-200 employees View job »", "Backend Developer"),
        # Instahyre: company + role + city + company blurb in one anchor. The
        # role and the chrome are clean_title's job; the employer prefix belongs
        # to the scanner's extractor (OBSCURA_EXTRACTORS.instahyre cuts at " - "),
        # and a blanket "X - " strip here would also eat a real qualifier such as
        # "SDE - Backend".
        (
            "EPAM Systems - Sr. / Lead Software Engineer Gurgaon Founded in 1993 1000+ employees View job »",
            "EPAM Systems - Sr. / Lead Software Engineer",
        ),
        # Hirist: opening count appended without a separator.
        ("Engineering Manager6", "Engineering Manager"),
        ("Backend Developer2", "Backend Developer"),
        # Wellfound: employment chip glued to the role.
        ("Software Engineer, Data SystemsFull-time · Remote (US)", "Software Engineer, Data Systems"),
        # Wellfound: work mode + salary chip.
        ("Senior Java Backend EngineerIn officeChennai L - 35L", "Senior Java Backend Engineer"),
        # Piped metadata.
        ("Backend Engineer | Bangalore", "Backend Engineer"),
        # Location appended as a trailing phrase.
        ("Backend Engineer, Bangalore, India", "Backend Engineer"),
        # Already clean: cleaning is idempotent.
        ("Backend Engineer", "Backend Engineer"),
        ("", ""),
    ],
)
def test_clean_title_strips_board_chrome(raw, expected):
    assert clean_title(raw) == expected


def test_clean_title_is_idempotent():
    once = clean_title("Backend Developer Bangalore Founded in 2021 50-200 employees View job »")
    assert clean_title(once) == once


def test_clean_title_drops_company_blurb_before_the_role():
    # YC cards have no separator between company, tagline and role. The role
    # phrase is the only reliable boundary, and keeping the blurb meant the
    # domain filter rejected the posting because the *company* sold marketing.
    raw = (
        "HiveMarketing automation for event promoters (email, sms, ads, CRM) "
        "Senior Software Engineer, Data SystemsFull-time · Remote (US)"
    )
    assert clean_title(raw) == "Senior Software Engineer, Data Systems"


def test_clean_title_drops_a_glued_yc_company_after_chrome_is_stripped():
    # The recovery used to be gated on `len(value) > 60`, and board chrome had
    # already removed "Full-time · <place>" by then, so a 41-character title
    # skipped the check and went to the email queue as
    # "PlutoLinkedIn for agents Founding Engineer" - the tagline quoted to the
    # recruiter in place of the role.
    assert (
        clean_title(
            "PlutoLinkedIn for agentsFounding EngineerFull-time · San Francisco, "
            "CA, US / New York, NY, US · $120K - $200K"
        )
        == "Founding Engineer"
    )
    # The Full-time marker is glued to the role on some cards, so it cannot be
    # matched with a leading \b.
    assert (
        clean_title(
            "AI DronesSoftware EngineerFull-time · San Francisco, CA, US · $110 - $160"
        )
        == "AI Drones Software Engineer"
    )
    # A normal title is untouched: the role already starts the string.
    assert clean_title("Backend EngineerFull-time · Remote") == "Backend Engineer"


# ── Role scope: word boundaries, not substrings ─────────────────────────────

@pytest.mark.parametrize(
    "title",
    [
        "Salesforce Developer",   # contains "sales"
        "Adios Engineer",         # contains "ios"
        "Reactive Systems Engineer",  # contains "react"
    ],
)
def test_names_that_merely_contain_an_exclude_marker_are_not_excluded(title):
    assert is_hard_excluded_role(title) is False


@pytest.mark.parametrize(
    "title",
    ["React Developer", "Full-Stack Engineer", "Fullstack Engineer", "UI/UX Designer"],
)
def test_real_excluded_roles_are_still_excluded(title):
    assert is_hard_excluded_role(title) is True


@pytest.mark.parametrize(
    "title",
    ["Backend Developer", "Machine Learning Engineer", "Golang Developer", "Java Developer (Spring Boot)"],
)
def test_in_scope_titles_pass_the_strict_gate(title):
    assert is_strict_target_role(title) is True


@pytest.mark.parametrize(
    "title",
    [
        "Solutions Architect, AI",          # pre-sales, not engineering
        "AI Deployment Specialist",         # delivery
        "Security Engineer, ML",            # different discipline
        "Product Manager",
        "Backend Engineer (Ruby)",          # off-stack
        "PHP Developer",
    ],
)
def test_out_of_scope_titles_fail_the_strict_gate(title):
    assert is_strict_target_role(title) is False


def test_hard_filter_rejects_seniority_but_keeps_the_intern_exception():
    profile = {
        "domain": {
            "hard_exclude": ["React"],
            "seniority": {"exclude": ["senior", "lead", "principal", "staff"]},
            "role_types": {"exclude": ["frontend"]},
            "core_skills": ["Python"],
        }
    }
    senior = hard_filter({"title": "Senior Backend Engineer", "description": ""}, profile)
    assert senior.passed is False
    assert "senior" in senior.reason

    intern = hard_filter({"title": "Backend Engineering Intern", "description": ""}, profile)
    assert intern.passed is True


def test_hard_filter_no_longer_rejects_on_a_description_mention():
    # A backend JD that mentions the frontend stack is still a backend role. The
    # old filter tested hard_exclude against the body and rejected it.
    profile = {"domain": {"hard_exclude": ["React", "CSS"], "core_skills": ["Python"]}}
    result = hard_filter(
        {
            "title": "Backend Engineer",
            "description": "Java services. You will occasionally touch React components and CSS for internal tools.",
        },
        profile,
    )
    assert result.passed is True
