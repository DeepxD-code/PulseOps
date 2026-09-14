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


def _is_remote(location_raw: str) -> bool:
    return bool(_REMOTE_KEYWORDS.search(location_raw or ""))


def _city_match(location_raw: str, city: str) -> bool:
    loc = (location_raw or "").lower()
    city_lower = city.lower()
    aliases = _CITY_ALIASES.get(city_lower, [city_lower])
    return any(alias in loc for alias in aliases)


def _resolve_location(job: dict, preferred_cities: list[str]) -> str:
    """Returns the matched preferred city, 'remote', or '' if no match."""
    location_raw = job.get("location_raw", "") or job.get("description", "")[:100]
    if _is_remote(location_raw):
        return "remote"
    for city in preferred_cities:
        if _city_match(location_raw, city):
            return city.lower()
    # Also check job description for location hints
    desc_snippet = (job.get("description") or "")[:300].lower()
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

        if resolved == "remote" and includes_remote:
            job["location_resolved"] = "remote"
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
