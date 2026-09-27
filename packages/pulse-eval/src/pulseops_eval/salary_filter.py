"""Salary floor for applications.

Only acts on postings that *state* a salary. Anything without a stated figure
is left alone, because inventing a threshold for a role that never disclosed
pay would silently drop good applications.

Compares everything in INR per month, which is the only common unit across the
formats seen in the wild: "Rs 8,000 per month", "10k pm", "₹6 LPA",
"₹1,20,000 p.a", "between 8 and 12 lakhs".
"""
from __future__ import annotations

import re

# 10k INR per month == 1.2 LPA per annum.
DEFAULT_MIN_MONTHLY_INR = 10_000

_NUM = r"(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_CR = r"(?:₹|rs\.?|inr)"

_MONTHLY = re.compile(
    rf"{_CR}?\s*{_NUM}\s*(?:k\s*)?(?:per\s*month|/\s*month|/\s*mo\b|p\.?m\.?\b|monthly|pm\b|a\s*month)",
    re.IGNORECASE,
)
_HOURLY = re.compile(
    rf"{_CR}?\s*{_NUM}\s*(?:k\s*)?(?:per\s*hour|/\s*hour|/\s*hr\b|hourly)",
    re.IGNORECASE,
)
_ANNUAL_LPA = re.compile(
    rf"{_CR}?\s*{_NUM}\s*(?:-\s*{_NUM}\s*)?(?:lpa|lakhs?(?:\s*(?:per\s* annum|pa|p\.?a\.?))?)",
    re.IGNORECASE,
)
_ANNUAL_PLAIN = re.compile(
    rf"{_CR}?\s*{_NUM}(?:,\d{{2,3}})*(?:\s*-\s*{_NUM}(?:,\d{{2,3}})*)?\s*(?:per\s*annum|annually|pa|p\.?a\.?\b|a\s*year)",
    re.IGNORECASE,
)


def _num(value: str) -> float:
    """Parse a possibly comma-grouped figure. Indian lakh grouping strips
    cleanly, so 1,20,000 and 8,000 both need nothing more than that."""
    return float(str(value).replace(",", "").strip())


def _k(value: str) -> float:
    return _num(value) * 1000.0


def monthly_inr_from_text(text: str) -> float | None:
    """Best-effort INR-per-month figure from free job text, or None."""
    if not text:
        return None
    blob = str(text)

    match = _MONTHLY.search(blob)
    if match:
        raw = match.group(1)
        # "10k pm" -> the k suffix multiplies by 1000.
        has_k = bool(re.search(r"k\s*(?:per\s*month|/\s*month|p\.?m\.?\b|monthly|pm\b)", match.group(0), re.I))
        return _k(raw) if has_k else _num(raw)

    match = _HOURLY.search(blob)
    if match:
        raw = match.group(1)
        has_k = bool(re.search(r"k\s*(?:per\s*hour|/\s*hour|/\s*hr\b|hourly)", match.group(0), re.I))
        hourly = _k(raw) if has_k else _num(raw)
        return hourly * 22 * 12  # ~22 working days a month

    match = _ANNUAL_LPA.search(blob)
    if match:
        # Use the lower bound: a range that dips below the floor is a risk.
        return _num(match.group(1)) * 100_000.0 / 12.0

    match = _ANNUAL_PLAIN.search(blob)
    if match:
        digits = re.findall(r"[\d,]+", match.group(0).replace("₹", " "))
        if digits:
            return _num(digits[0]) / 12.0
    return None


def stated_salary_too_low(
    text: str,
    minimum_monthly_inr: int = DEFAULT_MIN_MONTHLY_INR,
) -> tuple[bool, float | None]:
    """Return (should_skip, detected_monthly_inr).

    should_skip is True only when a salary is stated AND it is below the floor.
    """
    monthly = monthly_inr_from_text(text)
    if monthly is None:
        return False, None
    return monthly < minimum_monthly_inr, monthly
