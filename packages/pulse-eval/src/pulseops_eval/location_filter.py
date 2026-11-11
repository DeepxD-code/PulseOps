"""
evaluation/location_filter.py — Location / remote preference filter (PulseOps Phase 3)

Reads preferred_cities and remote_preference from settings.
Resolves job location_raw against preferred cities.
Remote jobs always pass if remote_preference=true.
"""

from __future__ import annotations

import re

# Canonical city name → aliases for fuzzy matching
_CITY_ALIASES: dict[str, list[str]] = {
    "bangalore":  ["bangalore", "bengaluru", "blr", "karnataka"],
    "hyderabad":  ["hyderabad", "hyd", "telangana", "secunderabad"],
    "pune":       ["pune", "pimpri", "pcmc", "maharashtra"],
    "chennai":    ["chennai", "madras", "tamil nadu", "tn"],
    "mumbai":     ["mumbai", "bombay", "navi mumbai"],
    "delhi":      ["delhi", "ncr", "gurgaon", "gurugram", "noida", "faridabad"],
    "remote":     ["remote", "work from home", "wfh", "anywhere", "globally"],
}

_REMOTE_KEYWORDS = re.compile(
    r'\b(remote|work.?from.?home|wfh|anywhere|globally|distributed)\b', re.IGNORECASE
)

# A stated place that is not India is a rejection, not missing data.
#
# Treating an empty location as "possible remote" let through every Wellfound
# role that named a foreign site, because the scraper was not capturing the
# place at all: 548 of 601 pending rows had no India signal. Their own boards
# then refused them - "not accepting applications from your current location"
# with the submit button disabled - so those visits could never produce an
# application. Checked before the remote rule, because "Remote - United States"
# matches both and only one of them is true for this candidate.
_INDIA_PLACES = re.compile(
    r"\bindia\b|\bbangalore\b|\bbengaluru\b|\bhyderabad\b|\bpune\b|\bchennai\b"
    r"|\bmumbai\b|\bnoida\b|\bgurgaon\b|\bgurugram\b|\bdelhi\b|\bkolkata\b"
    r"|\bahmedabad\b|\bjaipur\b|\bkochi\b|\bcoimbatore\b|\bindore\b"
    r"|\bchandigarh\b|\btrivandrum\b|\bthiruvananthapuram\b|\bncr\b",
    re.IGNORECASE,
)

_FOREIGN_PLACES = re.compile(
    r"\bunited states\b|\bu\.s\.a?\b|\busa\b|\bus only\b|\bus[- ]based\b"
    r"|\bcanada\b|\btoronto\b|\bvancouver\b|\bunited kingdom\b|\buk\b"
    r"|\blondon\b|\bmanchester\b|\bgermany\b|\bberlin\b|\bmunich\b"
    r"|\bnetherlands\b|\bamsterdam\b|\bfrance\b|\bparis\b|\bireland\b|\bdublin\b"
    r"|\bspain\b|\bportugal\b|\bpoland\b|\bsweden\b|\bswitzerland\b"
    r"|\bsingapore\b|\baustralia\b|\bsydney\b|\bnew zealand\b|\bjapan\b|\btokyo\b"
    r"|\bdubai\b|\buae\b|\bisrael\b|\btel aviv\b|\bbrazil\b"
    r"|\bsan francisco\b|\bnew york\b|\bseattle\b|\baustin\b|\bboston\b"
    r"|\bredwood city\b|\bpalo alto\b|\bmountain view\b|\bchicago\b|\bdenver\b"
    r"|\blos angeles\b|\batlanta\b|\bremote \(us\)\b|\bus remote\b"
    r"|\bcalifornia\b|\btexas\b|\bnew jersey\b|\bmassachusetts\b|\bwashington\b",
    re.IGNORECASE,
)


def _is_remote(location_raw: str) -> bool:
    return bool(_REMOTE_KEYWORDS.search(location_raw or ""))


def _city_match(location_raw: str, city: str) -> bool:
    loc = (location_raw or "").lower()
    city_lower = city.lower()
    aliases = _CITY_ALIASES.get(city_lower, [city_lower])
    return any(alias in loc for alias in aliases)


def _strip_provenance(text: str) -> str:
    """Drop the scraper's own header from a description before reading it.

    Cards that carry no location are stored with a provenance preamble -
    "Salary: not stated Source: Wellfound India (Backend). Card text: Backend
    Engineer" - and reading that as the employer's location made 109 of 292
    queued rows look India-located when the board had said nothing at all
    (measured 2026-11-11). The preamble is our note about the row, not a fact
    about the job.
    """
    head, sep, tail = (text or "").partition("Card text:")
    if sep and "Source:" in head and len(head) < 200:
        return tail
    return text or ""


def _resolve_location(job: dict, preferred_cities: list[str]) -> str:
    """Returns the matched preferred city, 'remote', 'foreign', or '' if unknown."""
    location_raw = job.get("location_raw", "") or _strip_provenance(job.get("description", ""))[:100]
    if _INDIA_PLACES.search(location_raw or ""):
        for city in preferred_cities:
            if _city_match(location_raw, city):
                return city.lower()
        return "india"
    if _FOREIGN_PLACES.search(location_raw or ""):
        return "foreign"
    if _is_remote(location_raw):
        return "remote"
    for city in preferred_cities:
        if _city_match(location_raw, city):
            return city.lower()
    # Also check job description for location hints
    desc_snippet = _strip_provenance(job.get("description") or "")[:300].lower()
    for city in preferred_cities:
        aliases = _CITY_ALIASES.get(city.lower(), [city.lower()])
        if any(a in desc_snippet for a in aliases):
            return city.lower()
    return ""


def filter_by_location(jobs: list[dict], sourcing_config: dict,
                        run_id: str = "") -> list[dict]:
    """
    Filter jobs by preferred_cities + remote_preference.
    If location is completely unknown (empty) AND remote_preference=True,
    the job passes (could be remote, don't reject on missing data).
    """
    preferred_cities = sourcing_config.get("preferred_cities", [
        "Bangalore", "Hyderabad", "Pune", "Chennai", "Remote"
    ])
    remote_ok     = sourcing_config.get("remote_preference", True)
    # Normalise to lowercase for matching
    pref_lower    = [c.lower() for c in preferred_cities]
    includes_remote = remote_ok or "remote" in pref_lower

    result = []
    for job in jobs:
        resolved = _resolve_location(job, preferred_cities)

        # A named foreign site cannot be worked from here. The posting says so
        # itself once the apply modal opens, so the row is dropped now instead of
        # costing a browser visit later.
        if resolved == "foreign":
            job["location_resolved"] = "foreign"
            continue

        if resolved == "remote" and includes_remote:
            job["location_resolved"] = "remote"
            result.append(job)
            continue

        if resolved == "india":
            job["location_resolved"] = "india"
            result.append(job)
            continue

        if resolved and resolved != "remote":
            job["location_resolved"] = resolved
            result.append(job)
            continue

        # Unknown location — pass-through if remote is acceptable
        # (don't reject a valid backend role just because location is missing)
        if not resolved and includes_remote:
            job["location_resolved"] = "unknown/possible-remote"
            result.append(job)
            continue

    return result
