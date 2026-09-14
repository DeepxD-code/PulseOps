"""
outreach/hunter.py — Hunter.io verified email lookup (PulseOps)

Implements the Council Session 1 outreach priority order:
  1. JD extraction (contact_email from LLM) — always tried first, zero cost
  2. Hunter.io lookup — this module, free tier 25 req/month
  3. LinkedIn DM packet only (no email)
  4. Domain inference — last resort, low-confidence, flagged

Free tier limitations:
  - 25 lookups/month (email-finder requests)
  - /v2/domain-search does NOT count against the email-finder quota
    and is the safer option when we don't have a recruiter name

Non-negotiable: NEVER auto-send to a low-confidence or unverified address.
Hunter.io returns a score (0-100) and a verification status. We only use
results where:
  - score >= 90  AND  status == "deliverable"     → safe to auto-send
  - score 70-89  OR  status == "risky"            → LinkedIn DM only
  - score < 70   OR  status in (unknown, invalid) → skip email, use DM

Results are cached in the recruiter_profiles table (14-day TTL) so a
single company is never hit twice in the same job-search cycle.

Environment variables:
  HUNTER_API_KEY     Your Hunter.io API key (free tier works)

Usage (called by send_engine.py before G10):
  from pulseops_outreach.hunter import lookup_email
  result = lookup_email(domain="stripe.com", company="Stripe",
                        recruiter_name="Sarah Chen")  # name optional
  if result.email and result.sendable:
      # proceed with verified email
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent

# Minimum Hunter score to consider an address verified (free tier is 25/month —
# we'd rather burn a lookup and get a confident result than waste it on risky ones).
_SCORE_SEND_THRESHOLD = 90
_SCORE_DM_THRESHOLD   = 70    # below this we skip email entirely

_BASE = "https://api.hunter.io/v2"
_TIMEOUT = 10
_RETRY_DELAYS = (2, 5)


@dataclass
class HunterResult:
    email: str = ""
    score: int = 0
    status: str = ""          # deliverable | risky | unknown | invalid
    source: str = ""          # email-finder | domain-search | cached | none
    sendable: bool = False    # score >= 90 AND status == deliverable
    dm_only: bool = False     # score 70-89 OR status risky
    raw: dict = field(default_factory=dict)

    @classmethod
    def empty(cls, reason: str = "") -> "HunterResult":
        return cls(source="none", raw={"reason": reason})


def _api_key() -> str:
    return os.getenv("HUNTER_API_KEY", "").strip()


def _get(endpoint: str, params: dict) -> dict:
    """Single GET with simple retry on transient network errors."""
    url = f"{_BASE}/{endpoint}"
    params["api_key"] = _api_key()
    last_exc: Exception | None = None
    for attempt, delay in enumerate([0] + list(_RETRY_DELAYS)):
        if delay:
            time.sleep(delay)
        try:
            resp = requests.get(url, params=params, timeout=_TIMEOUT)
            if resp.status_code == 429:
                print(f"  [Hunter] Rate limited (attempt {attempt+1})")
                continue
            if resp.status_code == 401:
                print("  [Hunter] Invalid API key — check HUNTER_API_KEY in .env")
                return {}
            if resp.status_code == 400:
                data = resp.json()
                # 400 with "No results" is not an error — it means Hunter has no data
                return data
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            print(f"  [Hunter] Request failed (attempt {attempt+1}): {e}")
            last_exc = e
    raise RuntimeError(f"Hunter.io request failed after retries: {last_exc}")


def _parse_result(data: dict, source: str) -> HunterResult:
    """Normalise a Hunter.io API response into a HunterResult."""
    d = data.get("data", {}) or {}
    email   = (d.get("email") or "").strip()
    score   = int(d.get("score", 0) or 0)
    verif   = d.get("verification") or {}
    status  = (verif.get("status") or d.get("status") or "unknown").lower()

    if not email or "@" not in email:
        return HunterResult(source=source, raw=data)

    sendable = score >= _SCORE_SEND_THRESHOLD and status == "deliverable"
    dm_only  = (not sendable) and (score >= _SCORE_DM_THRESHOLD or status == "risky")

    return HunterResult(
        email=email, score=score, status=status, source=source,
        sendable=sendable, dm_only=dm_only, raw=data,
    )


def _extract_name_from_email_draft(email_draft: str) -> tuple[str, str]:
    """
    Best-effort first/last name extraction from the LLM-generated cold email
    draft. The LLM typically addresses the recruiter by name in the opening
    line ("Hi Sarah," / "Dear Ms. Chen,"). Returns ("", "") if no name found.
    """
    if not email_draft:
        return ("", "")

    # Words that look like names but aren't — 'there' from "Hi there", etc.
    _FILLERS = {"there", "all", "team", "sir", "madam", "hiring", "manager",
                "recruiter", "hr", "hello", "folks", "everyone"}

    for line in email_draft.splitlines()[:5]:
        line = line.strip()
        m = re.match(
            r"(?:hi|hello|dear|hey)\s+(?:mr\.?|ms\.?|mrs\.?|dr\.?)?\s*([A-Z][a-z]+)"
            r"(?:\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?))?\s*[,!]?",
            line, re.IGNORECASE,
        )
        if m:
            first = m.group(1) or ""
            last  = m.group(2) or ""
            if first.lower() in _FILLERS:
                continue
            return (first, last)
    return ("", "")


def _cache_result(company: str, result: HunterResult) -> None:
    """Store a successful lookup in the recruiter_profiles cache (14-day TTL)."""
    if not result.email:
        return
    try:
        from pulseops_store.db_manager import cache_recruiter_profiles
        cache_recruiter_profiles(company, [{
            "name": "",
            "title": "HR/Recruiting (Hunter.io)",
            "link": result.email,      # abuse the link field to store email
            "score": result.score,
            "status": result.status,
            "source": result.source,
        }])
    except Exception as e:
        print(f"  [Hunter] Cache write failed (non-fatal): {e}")


def _check_cache(company: str, domain: str) -> HunterResult | None:
    """Return a cached result if one exists within the 14-day TTL."""
    try:
        from pulseops_store.db_manager import get_cached_recruiter_profiles
        cached = get_cached_recruiter_profiles(company, ttl_days=14)
        if not cached:
            return None
        for row in cached:
            link = row.get("link", "")
            if "@" in link and domain in link:
                score  = int(row.get("score", 0) or 0)
                status = (row.get("status") or "unknown").lower()
                sendable = score >= _SCORE_SEND_THRESHOLD and status == "deliverable"
                dm_only  = (not sendable) and score >= _SCORE_DM_THRESHOLD
                return HunterResult(
                    email=link, score=score, status=status, source="cached",
                    sendable=sendable, dm_only=dm_only,
                )
    except Exception:
        pass
    return None


def lookup_email(
    domain: str,
    company: str,
    recruiter_name: str = "",
    email_draft: str = "",
    simulate: bool = False,
) -> HunterResult:
    """
    Look up a verified recruiter email for `domain`.

    Strategy (in order, stops at first usable result):
      1. Check local 14-day cache (zero API quota)
      2. /v2/email-finder with recruiter name (if available)
      3. /v2/domain-search → pick the highest-scoring deliverable address
         with a recruiting-adjacent title

    Returns HunterResult with .sendable=True only if score≥90 AND deliverable.
    NEVER returns a result that should trigger an auto-send on low confidence.
    """
    if not domain or "." not in domain:
        return HunterResult.empty("no valid domain")

    api_key = _api_key()

    if simulate or not api_key:
        reason = "simulation mode" if simulate else "HUNTER_API_KEY not set"
        print(f"  [Hunter] Skipping lookup ({reason})")
        return HunterResult.empty(reason)

    # 1. Check cache first
    cached = _check_cache(company, domain)
    if cached:
        print(f"  [Hunter] Cache hit for {domain}: {cached.email} (score {cached.score})")
        return cached

    # 2. Try /v2/email-finder if we have a name
    first_name = last_name = ""

    if recruiter_name and " " in recruiter_name.strip():
        parts = recruiter_name.strip().split(None, 1)
        first_name, last_name = parts[0], parts[1]
    elif not recruiter_name and email_draft:
        first_name, last_name = _extract_name_from_email_draft(email_draft)

    if first_name and last_name:
        print(f"  [Hunter] email-finder: {first_name} {last_name} @ {domain}")
        try:
            data = _get("email-finder", {
                "domain": domain,
                "first_name": first_name,
                "last_name": last_name,
            })
            result = _parse_result(data, "email-finder")
            if result.email:
                print(f"  [Hunter] Found: {result.email} "
                      f"(score {result.score}, {result.status})")
                _cache_result(company, result)
                return result
        except Exception as e:
            print(f"  [Hunter] email-finder failed: {e}")

    # 3. Fall back to /v2/domain-search
    print(f"  [Hunter] domain-search: {domain}")
    try:
        data = _get("domain-search", {"domain": domain, "limit": 10, "type": "personal"})
        emails = (data.get("data") or {}).get("emails", []) or []

        # Prioritise by: title match → score → deliverable status
        _RECRUITING_KEYWORDS = {
            "recruit", "talent", "hr", "hiring", "people", "career",
            "personnel", "human resource", "staffing", "sourcer",
        }
        def _priority(e: dict) -> tuple:
            title = (e.get("value") or e.get("position") or "").lower()
            score = int(e.get("confidence", 0) or 0)
            status = (e.get("verification", {}).get("status") or "unknown").lower()
            is_recruiting = any(kw in title for kw in _RECRUITING_KEYWORDS)
            is_deliverable = status == "deliverable"
            return (not is_recruiting, not is_deliverable, -score)

        emails_sorted = sorted(emails, key=_priority)

        for candidate in emails_sorted:
            email   = (candidate.get("value") or "").strip()
            score   = int(candidate.get("confidence", 0) or 0)
            status_str = (
                (candidate.get("verification") or {}).get("status") or "unknown"
            ).lower()
            if not email or "@" not in email:
                continue
            if score < _SCORE_DM_THRESHOLD:
                continue  # skip unconfident addresses entirely

            result = HunterResult(
                email=email, score=score, status=status_str, source="domain-search",
                sendable=score >= _SCORE_SEND_THRESHOLD and status_str == "deliverable",
                dm_only=score >= _SCORE_DM_THRESHOLD and not (
                    score >= _SCORE_SEND_THRESHOLD and status_str == "deliverable"
                ),
                raw=data,
            )
            print(f"  [Hunter] domain-search hit: {email} "
                  f"(score {score}, {status_str})")
            _cache_result(company, result)
            return result

        print(f"  [Hunter] domain-search: no usable address for {domain}")
        return HunterResult.empty(f"no deliverable address found for {domain}")

    except Exception as e:
        print(f"  [Hunter] domain-search failed: {e}")
        return HunterResult.empty(f"domain-search error: {e}")


def quota_remaining() -> int | None:
    """
    Returns the number of Hunter.io requests remaining this month,
    or None if the API key is not set or the call fails.
    Used by doctor.py --check to surface quota burn rate.
    """
    api_key = _api_key()
    if not api_key:
        return None
    try:
        data = _get("account", {})
        requests_info = (data.get("data") or {}).get("requests", {}) or {}
        remaining = requests_info.get("searches", {}).get("available", None)
        return int(remaining) if remaining is not None else None
    except Exception:
        return None
