"""
core/profile_builder.py — CVData + LLM → config/profile.yml (PulseOps Phase 2)

Non-negotiable #7: profile.yml is generated, NEVER manually edited.
Non-negotiable #1: cv.md is the ONLY file a human edits.

Pipeline:
  CVData (from cv_parser) + optional CVDiff → Gemini→Groq cascade → profile.yml

In simulate / no-key mode: keyword-only extraction (no LLM) produces a
valid profile.yml from the CVData fields directly.

Token budget: ≤2000 tokens (spec).
Temperature: 0.2 (spec).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import yaml  # type: ignore

from exceptions import ProfileBuildError

ROOT         = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "config" / "profile.yml"
PROMPT_PATH  = ROOT / "prompts" / "profile_builder.txt"

# Hard-coded domain config (spec: candidate domain, pre-configured, do not change)
_DOMAIN_BASE = {
    "title": "Backend Engineer",
    "core_skills": ["Java", "C++", "Python", "Go", "Spring Boot", "gRPC",
                    "PostgreSQL", "Redis", "Kafka", "Docker", "Kubernetes"],
    "adjacent_skills": ["AWS", "Linux", "MongoDB", "RabbitMQ", "System Design",
                         "Microservices", "CI/CD", "Node.js"],
    "hard_exclude": ["React", "Angular", "Vue", "Figma", "CSS", "Flutter",
                      "Swift", "Android", "iOS"],
    "soft_exclude": ["TypeScript", "JavaScript", "Node.js", "Next.js"],
    "seniority": {
        "target": ["intern", "junior", "associate", "entry-level", "new grad"],
        "exclude": ["senior", "lead", "principal", "staff", "director",
                     "manager", "head of", "vp"],
    },
    "role_types": {
        "include": ["backend", "software engineer", "systems engineer",
                     "infrastructure", "platform engineer", "site reliability",
                     "devops", "api engineer"],
        "exclude": ["frontend", "designer", "product manager", "data scientist",
                     "ml engineer", "recruiter", "sales", "marketing",
                     "android", "ios", "mobile"],
    },
}


def _load_prompt_template() -> str:
    if PROMPT_PATH.exists():
        return PROMPT_PATH.read_text(encoding="utf-8")
    return (
        "You are a career-profile builder. Given the candidate's parsed CV data, "
        "generate a YAML profile.yml.\n\n"
        "CV Data:\n{cv_json}\n\n"
        "Rules:\n"
        "- Extract core_skills: skills appearing across 2+ roles/projects\n"
        "- Extract adjacent_skills: skills in limited context\n"
        "- Generate 5 search queries for job scraping (title + top skill + 'intern')\n"
        "- experience_years: integer, 0 if student/no full-time\n"
        "- Respond ONLY with valid YAML. No markdown fences.\n"
    )


def _cv_to_prompt_context(cv_data) -> str:
    """Serialise CVData to a compact JSON for the LLM prompt."""
    context = {
        "name": cv_data.name,
        "email": cv_data.email,
        "summary": cv_data.summary[:300] if cv_data.summary else "",
        "skills_flat": [item for items in cv_data.skills.values() for item in items],
        "experience": [
            {"title": e.title, "company": e.company,
             "bullets": e.bullets[:3]}
            for e in cv_data.experience
        ],
        "projects": [
            {"name": p.name, "tech": p.tech_stack, "bullets": p.bullets[:2]}
            for p in cv_data.projects
        ],
        "education": [
            {"degree": e.degree, "institution": e.institution,
             "year": e.graduation_year}
            for e in cv_data.education
        ],
    }
    return json.dumps(context, ensure_ascii=False, indent=2)


def _keyword_build(cv_data) -> dict:
    """
    Simulate/no-key mode: build profile.yml purely from CVData fields.
    No LLM required. Always works.
    """
    # Flatten all skills from cv.md
    all_skills = [item for items in cv_data.skills.values() for item in items]
    core        = [s for s in all_skills if s in _DOMAIN_BASE["core_skills"]]
    adjacent    = [s for s in all_skills if s in _DOMAIN_BASE["adjacent_skills"]]

    # If cv doesn't explicitly list them, use domain defaults
    if not core:
        core = _DOMAIN_BASE["core_skills"]
    if not adjacent:
        adjacent = _DOMAIN_BASE["adjacent_skills"]

    # Infer experience years from roles (rough heuristic)
    exp_years = len(cv_data.experience)

    # Generate search queries
    top_skills = (core[:3] if core else ["Java", "Python", "Go"])
    queries = [f"backend engineer intern {s}" for s in top_skills[:3]]
    queries += ["software engineer intern entry level", "backend developer intern new grad"]

    # Past employers
    past_employers = [e.company for e in cv_data.experience if e.company]

    candidate = {
        "name":             cv_data.name or "Candidate",
        "email":            cv_data.email or "",
        "linkedin":         cv_data.linkedin or "",
        "github":           cv_data.github or "",
        "portfolio":        cv_data.portfolio or "",
        "experience_years": exp_years,
        "education":        (f"{cv_data.education[0].degree}, "
                              f"{cv_data.education[0].graduation_year}"
                              if cv_data.education else ""),
    }

    return {
        "candidate":      candidate,
        "domain":         {
            **_DOMAIN_BASE,
            "core_skills":     core,
            "adjacent_skills": adjacent,
        },
        "past_employers": past_employers,
        "search": {
            "queries":      queries,
            "location":     "India",
            "max_age_days": 7,
        },
    }


def _parse_llm_yaml(text: str) -> dict:
    """Strip markdown fences and parse YAML; raise ProfileBuildError on failure."""
    text = re.sub(r"```(?:yaml)?", "", text).replace("```", "").strip()
    try:
        result = yaml.safe_load(text)
        if not isinstance(result, dict):
            raise ProfileBuildError("LLM returned non-dict YAML")
        return result
    except yaml.YAMLError as e:
        raise ProfileBuildError(f"YAML parse failed: {e}") from e


def _merge_with_domain_base(llm_profile: dict) -> dict:
    """
    Merge LLM output with domain base config.
    Domain hard_exclude/seniority/role_types are always spec values — never overridden by LLM.
    """
    domain = dict(_DOMAIN_BASE)
    if "domain" in llm_profile and isinstance(llm_profile["domain"], dict):
        # Only take skills from LLM; keep all other domain fields from spec
        llm_dom = llm_profile["domain"]
        if llm_dom.get("core_skills"):
            domain["core_skills"] = llm_dom["core_skills"]
        if llm_dom.get("adjacent_skills"):
            domain["adjacent_skills"] = llm_dom["adjacent_skills"]

    result = dict(llm_profile)
    result["domain"] = domain
    return result


def _query_gemini(prompt: str) -> dict:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    for attempt in range(2):
        try:
            resp = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    max_output_tokens=1500,
                ),
            )
            return _parse_llm_yaml(resp.text or "")
        except ProfileBuildError:
            raise
        except Exception as e:
            if attempt == 0 and ("429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)):
                time.sleep(5)
            else:
                raise
    raise RuntimeError("Gemini failed after retries")


def _query_groq(prompt: str) -> dict:
    from groq import Groq
    client = Groq(api_key=os.environ["GROQ_API_KEY"])
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
        timeout=30,
        max_tokens=1500,
    )
    return _parse_llm_yaml(resp.choices[0].message.content or "")


def build_profile(cv_data, cv_diff=None, simulate: bool = False) -> str:
    """
    Build config/profile.yml from CVData.
    Returns the path to the written profile.yml.
    Raises ProfileBuildError on total failure.
    """
    PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Simulate / no keys → keyword-only (always works)
    use_llm = (not simulate
                and (os.getenv("GEMINI_API_KEY") or os.getenv("GROQ_API_KEY")))

    if not use_llm:
        profile = _keyword_build(cv_data)
        _write_profile(profile)
        print(f"  [ProfileBuilder] Keyword-only mode → {PROFILE_PATH}")
        return str(PROFILE_PATH)

    template = _load_prompt_template()
    cv_json  = _cv_to_prompt_context(cv_data)

    # Add diff context if available
    diff_note = ""
    if cv_diff and cv_diff.has_changes:
        diff_note = (f"\n\nNOTE: cv.md recently changed. "
                      f"Summary: {cv_diff.summary()}. "
                      f"Focus on updating skills/search queries accordingly.")

    prompt = template.replace("{cv_json}", cv_json) + diff_note

    errors = []
    for engine, fn in [("gemini", _query_gemini), ("groq", _query_groq)]:
        key_env = "GEMINI_API_KEY" if engine == "gemini" else "GROQ_API_KEY"
        if not os.getenv(key_env):
            continue
        try:
            raw = fn(prompt)
            profile = _merge_with_domain_base(raw)
            _write_profile(profile)
            print(f"  [ProfileBuilder] {engine} → {PROFILE_PATH}")
            return str(PROFILE_PATH)
        except Exception as e:
            print(f"  [ProfileBuilder] {engine} failed: {e}")
            errors.append(f"{engine}: {e}")

    # Final fallback: keyword-only
    print(f"  [ProfileBuilder] LLM failed ({'; '.join(errors)}) — keyword fallback")
    profile = _keyword_build(cv_data)
    _write_profile(profile)
    return str(PROFILE_PATH)


def _write_profile(profile: dict) -> None:
    header = (
        "# PulseOps Profile — Auto-generated from cv.md\n"
        "# DO NOT EDIT MANUALLY — run: python doctor.py --sync-profile\n"
        "# This file is gitignored. profile.yml.example is committed.\n\n"
    )
    PROFILE_PATH.write_text(
        header + yaml.dump(profile, default_flow_style=False,
                            allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
