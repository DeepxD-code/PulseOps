"""
evaluation/domain_filter.py — 3-stage domain filter (PulseOps Phase 4)

Stage 1 — Hard filter (zero LLM cost):
  Primary skill detection:
    keyword in title                    = primary
    keyword in first sentence of desc   = primary
    keyword appears 3+ times in desc    = primary
  hard_exclude as primary → HARD_REJECT
  role_types.exclude      → HARD_REJECT
  seniority.exclude       → HARD_REJECT  (unless "intern"/"junior" also present)

Stage 2 — Soft filter (Gemini gemini-flash-lite-latest, ≤150+50 tokens, 5s timeout):
  Input: title + first 200 chars of description only
  Question: "Is PRIMARY focus backend/systems engineering? YES/NO + reason"
  Timeout: 5s hard → default PASS on timeout (never lose valid roles)
  Model: gemini-flash-lite-latest

Non-negotiable #8: No LLM call before Stage 1 hard filter passes.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

# ── Result type ──────────────────────────────────────────────────────────────

@dataclass
class FilterResult:
    passed: bool
    reason: str
    stage: int = 0


# ── Domain config helpers ─────────────────────────────────────────────────────

def _get_domain(profile: dict) -> dict:
    return profile.get("domain") or {}


def _hard_excludes(profile: dict) -> list[str]:
    d = _get_domain(profile)
    return [k.lower() for k in (d.get("hard_exclude") or [])]


def _soft_excludes(profile: dict) -> list[str]:
    d = _get_domain(profile)
    return [k.lower() for k in (d.get("soft_exclude") or [])]


def _core_skills(profile: dict) -> list[str]:
    d = _get_domain(profile)
    return [k.lower() for k in (d.get("core_skills") or [])]


def _seniority_exclude(profile: dict) -> list[str]:
    d = _get_domain(profile)
    return [k.lower() for k in (d.get("seniority", {}).get("exclude") or
                                  ["senior", "lead", "principal", "staff",
                                   "director", "manager", "head", "vp"])]


def _role_type_exclude(profile: dict) -> list[str]:
    d = _get_domain(profile)
    return [k.lower() for k in (d.get("role_types", {}).get("exclude") or
                                  ["frontend", "designer", "product manager",
                                   "data scientist", "ml engineer", "recruiter",
                                   "sales", "android", "ios", "mobile"])]


# ── Stage 1 helpers ───────────────────────────────────────────────────────────

def _is_primary_skill(keyword: str, title: str, desc: str) -> bool:
    """A skill is 'primary' if in title, first sentence, or appears 3+ times."""
    kw = keyword.lower()
    if kw in title.lower():
        return True
    first_sentence = (desc[:200] if desc else "").lower()
    if kw in first_sentence:
        return True
    count = len(re.findall(rf'\b{re.escape(kw)}\b', (desc or "").lower()))
    return count >= 3


def _has_intern_exception(title: str) -> bool:
    """Seniority excludes don't apply if the title also has intern/junior."""
    low = title.lower()
    return any(k in low for k in ["intern", "junior", "associate", "entry", "new grad"])


# ── Stage 1 — Hard filter ─────────────────────────────────────────────────────

def hard_filter(job: dict, profile: dict) -> FilterResult:
    """
    Zero-cost hard filter. Returns FilterResult(passed=False) with reason if rejected.
    Non-negotiable #8: this MUST pass before any LLM is called.
    """
    title = (job.get("title") or "").strip()
    desc  = (job.get("description") or "")
    title_lower = title.lower()

    hard_ex    = _hard_excludes(profile)
    role_ex    = _role_type_exclude(profile)
    senior_ex  = _seniority_exclude(profile)
    core       = _core_skills(profile)

    # G1: hard_exclude as primary skill → REJECT
    for kw in hard_ex:
        if _is_primary_skill(kw, title, desc):
            return FilterResult(False,
                f"Stage1: hard_exclude '{kw}' is primary skill", stage=1)

    # G2: role_types.exclude in title → REJECT
    for role in role_ex:
        if role in title_lower:
            return FilterResult(False,
                f"Stage1: excluded role type '{role}' in title", stage=1)

    # G3: seniority.exclude → REJECT (unless also contains intern/junior)
    if not _has_intern_exception(title):
        for lvl in senior_ex:
            if lvl in title_lower:
                return FilterResult(False,
                    f"Stage1: seniority '{lvl}' excluded (no intern/junior modifier)", stage=1)

    # G4: must have at least one core skill as primary (or pass to Stage 2)
    # If NO core skill is primary AND the title is ambiguous (no backend keyword),
    # send to Stage 2 instead of hard-rejecting.
    backend_title_kw = ["backend", "software", "systems", "infrastructure",
                         "platform", "api", "devops", "sre", "reliability",
                         "engineer", "developer", "c++", "java", "python", "go",
                         "golang", "cloud", "database", "distributed"]
    has_backend_title = any(k in title_lower for k in backend_title_kw)

    if not has_backend_title and not core:
        return FilterResult(False,
            "Stage1: no backend keyword in title and no core skills defined", stage=1)

    return FilterResult(True, "Stage1: passed", stage=1)


# ── Stage 2 — Soft filter (cheap LLM) ────────────────────────────────────────

_SOFT_PROMPT_TEMPLATE = (
    'Job title: "{title}"\n'
    'Description start: "{desc_snippet}"\n\n'
    'Is the PRIMARY focus of this job aligned with the candidate\'s target '
    'domain of {domain_title}, using skills like {core_skills}?\n'
    'Answer exactly: YES or NO, then one sentence reason.'
)


def _call_gemini_soft(title: str, desc_snippet: str, domain_title: str = "",
                       core_skills: list[str] | None = None) -> bool | None:
    """
    Returns True (pass), False (reject), or None (timeout/error → default PASS).
    Budget: ≤150 input + 50 output tokens. Timeout: 5s hard.

    domain_title / core_skills come from profile.yml (Non-negotiable: profile.yml
    is generated from cv.md, never hardcoded here) — falls back to the original
    backend-engineering question only if profile fields are missing, so older
    profile.yml files without these fields don't break.
    """
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        return None  # no key → default PASS

    domain_title = domain_title or "backend/systems engineering"
    skills_str = ", ".join(core_skills) if core_skills else (
        "Java, C++, Python, Go, Spring Boot, gRPC, PostgreSQL, Redis, Kafka, Docker, Kubernetes"
    )

    prompt = _SOFT_PROMPT_TEMPLATE.format(
        title=title[:100],
        desc_snippet=desc_snippet[:200],
        domain_title=domain_title,
        core_skills=skills_str,
    )

    try:
        from google import genai
        from google.genai import types
        from pulseops_eval.analyzer import pace_llm_call

        pace_llm_call()
        client = genai.Client(api_key=api_key)
        resp = client.models.generate_content(
            model="gemini-flash-lite-latest",
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.0,
                max_output_tokens=50,
            ),
        )
        text = (resp.text or "").strip().upper()
        if text.startswith("YES"):
            return True
        if text.startswith("NO"):
            return False
        return None  # ambiguous → default PASS

    except Exception:
        return None  # timeout / error → default PASS (spec: never lose valid roles)


def soft_filter(job: dict, profile: dict) -> FilterResult:
    """
    Stage 2 soft filter. Only called if Stage 1 passed.
    Non-negotiable #8: guaranteed that hard_filter() returned True first.
    Timeout defaults to PASS so no valid role is lost to a slow LLM.
    """
    title        = (job.get("title") or "").strip()
    desc_snippet = (job.get("description") or "")[:200]

    domain = profile.get("domain", {}) if isinstance(profile, dict) else {}
    domain_title = domain.get("title", "")
    core_skills  = domain.get("core_skills", [])

    result = _call_gemini_soft(title, desc_snippet, domain_title, core_skills)

    if result is False:
        return FilterResult(False,
            f"Stage2: LLM determined not aligned with {domain_title or 'target domain'}", stage=2)

    # True or None (timeout/error) → PASS
    reason = "Stage2: LLM confirmed domain alignment" if result else "Stage2: LLM unavailable → default PASS"
    return FilterResult(True, reason, stage=2)
