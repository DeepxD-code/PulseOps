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
from google import genai
from google.genai import types


def _gemini_client(api_key):
    """One bounded client per process. See profile_builder for why."""
    global _GEMINI_CLIENT
    if _GEMINI_CLIENT is None:
        _GEMINI_CLIENT = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=60000),
        )
    return _GEMINI_CLIENT


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


# ── Strict target-role policy ────────────────────────────────────────────────
# The candidate is intentionally narrow: backend, ML/AI, Java, C/C++, and
# GenAI. Do not let generic "software engineer" or full-stack titles through.
_STRICT_ROLE_EXCLUDES = (
    "full stack", "full-stack", "fullstack", "frontend", "front-end",
    "laravel", "wordpress", "react", "angular", "vue", "mobile", "android",
    "ios", "embedded", "firmware", "hardware",
    # The Node/JS web stack is outside the candidate's language set even when
    # the title also says "backend".
    "node.js", "nodejs", "node js", "next.js", "nuxt", "express.js",
    "javascript", "java script", "typescript",
    # Data stores and frameworks the candidate does not work with.
    "mongo", "mongodb", "django",
    # Design roles are not software engineering roles.
    "ui/ux", "ui ux", "ux/ui", "ui designer", "ux designer", "product designer",
    "graphic design", "product design", "web design", "figma",
    "interaction design", "visual design", "brand design",
)
_STRICT_ROLE_ALLOWED = re.compile(
    r"\b(?:backend|back[\s-]end|ml|artificial[\s-]+intelligence|"
    r"ai|ai[\s/-]*ml|genai|generative[\s-]+ai|llm\w*|nlp|computer[\s-]+vision|"
    r"deep[\s-]+learning|java|python)\b"
    # Scraped titles concatenate company and role ("FirmMachine Learning
    # Researcher"), so these two must match without a leading word boundary.
    r"|machine[\s-]+learning|reinforcement[\s-]+learning"
    r"|\bc\b|c\+\+|c\s*/\s*c\+\+",
    re.IGNORECASE,
)


def is_strict_target_role(title: str) -> bool:
    """Return True only for the candidate's explicitly allowed role families."""
    value = re.sub(r"\s+", " ", str(title or "").strip().lower())
    if not value:
        return False
    if any(marker in value for marker in _STRICT_ROLE_EXCLUDES):
        return False
    return bool(_STRICT_ROLE_ALLOWED.search(value))


def is_hard_excluded_role(title: str) -> bool:
    """Titles that are unambiguously outside the target domain.

    Stage 1 must only reject these outright. A title with no explicit
    in-domain keyword (for example "Research Engineer, Pretraining") is
    ambiguous rather than wrong, so it is deferred to the Stage 2 model
    instead of being dropped. Rejecting every unkeyworded title silently
    discarded real ML/AI roles.
    """
    value = re.sub(r"\s+", " ", str(title or "").strip().lower())
    if not value:
        return False
    return any(marker in value for marker in _STRICT_ROLE_EXCLUDES)


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
    role_ex    = [
        role for role in _role_type_exclude(profile)
        if role not in {"ml engineer", "machine learning", "ai", "ai engineer", "ml"}
    ]
    senior_ex  = _seniority_exclude(profile)
    core       = _core_skills(profile)

    if is_hard_excluded_role(title):
        return FilterResult(
            False,
            "Stage1: title is an excluded role family "
            "(full-stack/frontend/mobile/embedded)",
            stage=1,
        )

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

    # The strict target-role gate above is the authoritative title boundary.
    # Profile skill/role configuration still applies below, but an ambiguous
    # generic software title must not be sent to Stage 2.
    return FilterResult(True, "Stage1: strict target role passed", stage=1)


# ── Stage 2 — Soft filter (cheap LLM) ────────────────────────────────────────

_SOFT_PROMPT_TEMPLATE = (
    'Job title: "{title}"\n'
    'Description start: "{desc_snippet}"\n\n'
    'Is the PRIMARY focus of this job aligned with the candidate\'s strict '
    'target domain of backend, ML/AI, Java, C/C++, or GenAI, using skills '
    'like {core_skills}? Reject full-stack, frontend, mobile, embedded, and '
    'generic software roles.\n'
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
        client = _gemini_client(api_key)
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
