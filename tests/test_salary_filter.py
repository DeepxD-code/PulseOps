"""Tests for the stated-salary floor (10k INR per month)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))

from pulseops_eval.salary_filter import (  # noqa: E402
    DEFAULT_MIN_MONTHLY_INR,
    monthly_inr_from_text,
    stated_salary_too_low,
)

BELOW = [
    "Salary: Rs 8,000 per month",
    "₹6,000/month for interns",
    "Pay is INR 9000 per month",
    "₹0.8 LPA per annum",
    "₹1,00,000 p.a",
    " stipend of 5k monthly",
    "₹9,999 per month",
]

ABOVE_OR_EQUAL = [
    "₹15,000 per month",
    "Rs 1,000,000 per annum",
    "₹12 LPA",
    "₹18,00,000 p.a",
    "40k pm",
    "salary: ₹3,00,000 per month",
    # Exactly at the floor is not "less than" the floor, so it is kept.
    "Compensation 10k pm",
]

UNSTATED = [
    "Great backend role, competitive salary",
    "Backend Engineer at Acme",
    "We offer equity and great learning",
    "",
    None,
]


@pytest.mark.parametrize("text", BELOW)
def test_low_stated_salaries_are_skipped(text):
    skip, monthly = stated_salary_too_low(text)
    assert skip is True, text
    assert monthly is not None
    assert monthly < DEFAULT_MIN_MONTHLY_INR


@pytest.mark.parametrize("text", ABOVE_OR_EQUAL)
def test_acceptable_stated_salaries_are_kept(text):
    skip, monthly = stated_salary_too_low(text)
    assert skip is False, (text, monthly)
    assert monthly is not None


@pytest.mark.parametrize("text", UNSTATED)
def test_unstated_salary_is_never_a_reason_to_skip(text):
    # Never invent a threshold for a role that did not disclose pay.
    assert stated_salary_too_low(text) == (False, None)


def test_range_uses_the_lower_bound():
    # 8-12 LPA: the floor is 1.2 LPA, so this is comfortably above it.
    assert monthly_inr_from_text("₹8 - 12 LPA") == pytest.approx(8 * 100000 / 12)
    # A range that dips below the floor must be treated as risky.
    skip, _ = stated_salary_too_low("₹0.5 - 12 LPA")
    assert skip is True


def test_indian_lakh_notation_is_understood():
    assert monthly_inr_from_text("₹1,20,000 per annum") == pytest.approx(10000.0)
    assert monthly_inr_from_text("₹15,00,000 p.a") == pytest.approx(125000.0)


def test_kilo_suffix_is_handled():
    assert monthly_inr_from_text("10k pm") == pytest.approx(10000.0)
    assert monthly_inr_from_text("₹8k per month") == pytest.approx(8000.0)
