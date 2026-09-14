"""
evaluation/analyzer.py — Full 6-block LLM evaluation engine (PulseOps Phase 5)

Pipeline:
  1. Non-negotiable #8: Stage 1 + Stage 2 domain filter must have already passed.
  2. Load memory context (deferred memories for this company).
  3. Load feedback loop bullets (phone_screen+ only — non-negotiable #10).
  4. Call LLM cascade: Gemini 2.5-flash-lite → Groq llama-3.3-70b → OpenAI gpt-4o-mini.
  5. Validate against schema, return typed dict.

Circuit breaker: each engine is disabled per-run after a daily quota error.
Temperature: 0.2 across all engines (spec).
Token budget: ≤2500 (spec).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from pulseops_core.exceptions import AllEnginesFailedError, EvaluationError, PreFilterRejectedError

ROOT        = Path(__file__).resolve().parent.parent
PROMPT_PATH = ROOT / "prompts" / "full_evaluation.txt"

# ── Circuit breaker ───────────────────────────────────────────────────────────

_disabled_engines: set[str] = set()


def disable_engine(name: str, reason: str) -> None:
    _disabled_engines.add(name)
    print(f"  [CircuitBreaker] '{name}' disabled for this run: {reason}")


def reset_circuit_breakers() -> None:
    _disabled_engines.clear()


def is_engine_disabled(name: str) -> bool:
    return name in _disabled_engines


# ── Prompt builder ────────────────────────────────────────────────────────────

def _load_prompt_template() -> str:
    if PROMPT_PATH.exists():
        return PROMPT_PATH.read_text(encoding="utf-8")
    raise EvaluationError(f"Prompt template not found: {PROMPT_PATH}")


def _build_prompt(job: dict, cv_data, memory_context: str,
                   profile: dict, settings: dict) -> str:
    template = _load_prompt_template()

    # Resume text
    resume_text = cv_data.raw_text[:3000] if cv_data and cv_data.raw_text else ""

    # Extract bullets from cv_data for grounding
    all_bullets: list[str] = []
    if cv_data:
        for exp in cv_data.experience:
            all_bullets.extend(exp.bullets)
        for proj in cv_data.projects:
            all_bullets.extend(proj.bullets)
    bullets_text = "\n".join(f"- {b}" for b in all_bullets) if all_bullets else "(none)"

    # Feedback loop context (non-negotiable #10: phone_screen+ only)
    feedback_context = ""
    try:
        from pulseops_store.db_manager import get_successful_bullets
        prev_bullets = get_successful_bullets()
        if prev_bullets:
            seen, uniq = set(), []
            for b in prev_bullets[:10]:
                key = (b.get("original", ""), b.get("tailored", ""))
                if key not in seen:
                    seen.add(key)
                    uniq.append(b)
            examples = "\n".join(
                f"Original: {b['original']}\nTailored: {b['tailored']}"
                for b in uniq
            )
            feedback_context = (
                f"--- SUCCESSFUL BULLET REWRITES (from past phone_screen+ jobs) ---\n"
                f"{examples}\n"
                f"--- Use these as style references for bullet adjustments ---"
            )
    except Exception:
        pass

    return (
        template
        .replace("{memory_context}", memory_context or "")
        .replace("{resume_text}", resume_text)
        .replace("{bullets_text}", bullets_text)
        .replace("{feedback_context}", feedback_context)
        .replace("{job_description}", (job.get("description") or "")[:2000])
    )


# ── Schema validation ─────────────────────────────────────────────────────────

_REQUIRED_FIELDS = [
    "match_percentage", "letter_grade", "text_summary", "bullet_adjustments",
    "skill_gap", "tailored_skills", "recruiter_message", "recruiter_email",
    "contact_email", "inferred_domain", "domain_confidence", "level_strategy",
    "comp_research", "star_stories", "negotiation_notes", "email_variant_used",
]


def _validate(raw: dict, engine: str, start_ms: int) -> dict:
    """Ensure all required fields present; fill defaults for missing optional ones."""
    for field in _REQUIRED_FIELDS:
        if field not in raw:
            raw[field] = [] if field in ("bullet_adjustments", "skill_gap",
                                          "tailored_skills", "star_stories") else ""

    score = raw.get("match_percentage", 0)
    if not isinstance(score, int):
        try:
            score = int(score)
        except (TypeError, ValueError):
            score = 0
    raw["match_percentage"] = max(0, min(100, score))

    if not raw.get("letter_grade"):
        s = raw["match_percentage"]
        raw["letter_grade"] = "A" if s >= 90 else "B" if s >= 80 else "C" if s >= 70 else "D" if s >= 60 else "F"

    raw["engine"]          = engine
    raw["tokens_used"]     = raw.get("tokens_used", 0)
    raw["eval_duration_ms"] = int(time.time() * 1000) - start_ms

    return raw


def _parse_json(text: str) -> dict:
    text = re.sub(r"```(?:json)?", "", text).replace("```", "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try extracting the first {...} block
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise


def _is_daily_quota(msg: str) -> bool:
    signals = ["per day", "per_day", "daily limit", "PerDayPerProject",
                "FreeTier", "insufficient_quota", "quota exceeded"]
    return any(s.lower() in msg.lower() for s in signals)


# ── Engine queries ────────────────────────────────────────────────────────────

def _query_gemini(prompt: str) -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    for attempt in range(3):
        try:
            resp = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.2,
                    max_output_tokens=2000,
                ),
            )
            return _parse_json(resp.text or "")
        except Exception as e:
            msg = str(e)
            if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                if _is_daily_quota(msg):
                    disable_engine("gemini", "daily quota exhausted")
                    raise
                if attempt < 2:
                    wait = 4 * (2 ** attempt)
                    print(f"  [Gemini] Rate-limited, retry in {wait}s…")
                    time.sleep(wait)
                else:
                    raise
            else:
                raise
    raise RuntimeError("Gemini exhausted retries")


def _query_groq(prompt: str) -> dict:
    from groq import Groq

    client = Groq(api_key=os.environ["GROQ_API_KEY"])
    models = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]

    for model in models:
        for attempt in range(2):
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.2,
                    response_format={"type": "json_object"},
                    timeout=30,
                    max_tokens=2000,
                )
                return _parse_json(resp.choices[0].message.content or "")
            except Exception as e:
                msg = str(e).lower()
                if any(x in msg for x in ["429", "rate limit", "daily limit"]):
                    if _is_daily_quota(msg):
                        if model == models[-1]:
                            disable_engine("groq", "daily quota exhausted")
                            raise
                        break  # try next model
                    if attempt < 1:
                        time.sleep(6)
                    else:
                        break
                else:
                    raise
    raise RuntimeError("All Groq models failed")


def _query_openai(prompt: str) -> dict:
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    for attempt in range(2):
        try:
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                response_format={"type": "json_object"},
                timeout=30,
                max_tokens=2000,
            )
            return _parse_json(resp.choices[0].message.content or "")
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "insufficient_quota" in msg:
                if _is_daily_quota(msg):
                    disable_engine("openai", "quota exhausted")
                    raise
                if attempt < 1:
                    time.sleep(8)
                else:
                    raise
            else:
                raise
    raise RuntimeError("OpenAI exhausted retries")


# ── Main evaluate function ────────────────────────────────────────────────────

def evaluate_job(
    job: dict,
    cv_data,
    memory_context: str = "",
    profile: dict | None = None,
    settings: dict | None = None,
) -> dict:
    """
    Full 6-block evaluation via LLM cascade.
    Returns typed eval dict. Raises AllEnginesFailedError if all engines fail.

    Non-negotiable #8: caller must have already run Stage 1 + Stage 2 filter.
    """
    if profile is None:
        profile = {}
    if settings is None:
        settings = {}

    preferred = (settings.get("llm") or {}).get("preferred", "gemini").lower()
    start_ms  = int(time.time() * 1000)

    prompt = _build_prompt(job, cv_data, memory_context, profile, settings)

    # Cascade order
    order = ["gemini", "groq", "openai"]
    if preferred == "openai":
        order = ["openai", "gemini", "groq"]
    elif preferred in ("groq", "grok"):
        order = ["groq", "openai", "gemini"]

    errors = []
    for engine in order:
        if is_engine_disabled(engine):
            errors.append(f"{engine}: circuit-broken")
            continue

        key_map = {"gemini": "GEMINI_API_KEY", "groq": "GROQ_API_KEY", "openai": "OPENAI_API_KEY"}
        if not os.getenv(key_map.get(engine, "")):
            continue

        try:
            print(f"  [Eval] Querying {engine}…")
            if engine == "gemini":
                raw = _query_gemini(prompt)
            elif engine == "groq":
                raw = _query_groq(prompt)
            else:
                raw = _query_openai(prompt)

            return _validate(raw, engine, start_ms)

        except AllEnginesFailedError:
            raise
        except Exception as e:
            print(f"  [Eval] {engine} failed: {str(e)[:120]}")
            errors.append(f"{engine}: {e}")

    raise AllEnginesFailedError(
        f"All engines failed for '{job.get('title')}' @ '{job.get('company')}': "
        f"{'; '.join(errors)}"
    )
