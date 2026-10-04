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

from pulseops_core.exceptions import AllEnginesFailedError, EvaluationError
from google import genai
from google.genai import types


# --- shared, bounded Gemini client -------------------------------------------
# One client for the process, built on first use, with an explicit HTTP timeout.
#
# Previously each call site did `client = genai.Client(api_key=...)` inside the
# per-job loop. That is two defects at once:
#
#   - no default request timeout, so one unresponsive provider call blocked the
#     whole weekly pipeline indefinitely. Observed 2026-10-04: 69 minutes of wall
#     time at 6 seconds of CPU, which is a process parked on a socket. The only
#     timeout in the codebase was on the Groq fallback, so the primary path -
#     the one that actually hangs - had none.
#   - a fresh connection pool per call, never closed. That process held ten
#     sockets in CLOSE_WAIT against Google's endpoints: the remote end gone, the
#     local end never released.
#
# A reused client reuses its pool, which is also faster per call.
_GEMINI_CLIENT = None


def _gemini_client():
    global _GEMINI_CLIENT
    if _GEMINI_CLIENT is None:
        _GEMINI_CLIENT = genai.Client(
            api_key=os.environ["GEMINI_API_KEY"],
            http_options=types.HttpOptions(timeout=60000),
        )
    return _GEMINI_CLIENT


try:
    from pulseops_config.paths import PROMPTS_DIR, repo_root

    ROOT = repo_root()
    PROMPT_PATH = PROMPTS_DIR / "full_evaluation.txt"
except ImportError:  # source-tree fallback without installed packages
    ROOT = Path(__file__).resolve().parent.parent
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


def _is_malformed_json(msg: str) -> bool:
    """True when the model replied with truncated or malformed JSON.

    Distinct from a rate limit: the request succeeded, the payload is unusable.
    Retrying the same prompt usually gets a complete object back, because the
    truncation comes from hitting ``max_output_tokens`` mid-serialisation.
    Sixteen jobs in one run died on this with no retry at all, and each was
    discarded rather than re-evaluated.
    """
    low = msg.lower()
    # Matched on the decoder's own wording rather than on the word "JSON",
    # which the real messages do not contain. Every marker below is something
    # json.loads raises and nothing else does, so this cannot fire on a quota,
    # auth or validation error.
    return any(
        marker in low
        for marker in (
            "expecting ',' delimiter",
            "expecting property name enclosed in double quotes",
            "expecting value",
            "expecting ':' delimiter",
            "unterminated string",
            "extra data",
            "invalid \\escape",
            "invalid control character",
            "invalid \\\\u",
        )
    )


def _is_transient_network(msg: str) -> bool:
    """DNS resets and aborted sockets, which are momentary rather than fatal.

    The SDKs do not surface the underlying cause: a Groq or OpenAI SDK call that
    failed DNS reports only "Connection error." with the real reason buried in
    __cause__. Matching the stringified exception alone therefore missed every
    DNS failure on those two engines - which is exactly the outage observed on
    2026-10-01 - so the exception chain is walked as well. A bare
    "connection error" is treated as transient because that is all the SDK
    offers, and retrying a transport fault three times is cheap next to losing
    the rest of the cascade.
    """
    low = str(msg or "").lower()
    if (
        "[errno 11001]" in low
        or "getaddrinfo failed" in low
        or "[winerror 10053]" in low
        or "[winerror 10054]" in low
        or "connection aborted" in low
        or "connection reset" in low
        or "connection refused" in low
        or "temporary failure in name resolution" in low
        or "name or service not known" in low
        or "nodename nor servname" in low
        or "ssl syscall" in low
    ):
        return True
    # Walk the cause chain: openai/groq wrap the socket error one level down, so
    # a DNS failure arrives as a bare "Connection error." string. The cause is
    # what actually decides it - a bare message is never trusted on its own,
    # because that would also retry the SDK's own request-construction errors.
    seen = 0
    cause = getattr(msg, "__cause__", None) or getattr(msg, "__context__", None)
    while cause is not None and seen < 5:
        text = str(cause).lower()
        if any(
            token in text
            for token in (
                "getaddrinfo",
                "11001",
                "10053",
                "10054",
                "connection reset",
                "connection refused",
                "connection aborted",
                "name or service not known",
                "temporary failure",
                "timed out",
                "ssl syscall",
                "broken pipe",
            )
        ):
            return True
        cause = getattr(cause, "__cause__", None) or getattr(cause, "__context__", None)
        seen += 1
    return False


def _is_daily_quota(msg: str) -> bool:
    """True only for DAILY exhaustion. Per-minute 429s carry RetryInfo /
    PerMinute quotaIds and must NOT disable the engine — the caller retries
    after the advised delay. (Misclassifying this zeroed a whole 43-job run
    on 2026-09-21: one per-minute 429 disabled gemini for everything.)"""
    low = msg.lower()
    if "perminute" in low or "per-minute" in low:
        return False
    signals = ["per day", "per_day", "perday", "daily limit",
               "requests per day", "daily quota", "perdayperproject"]
    return any(s in low for s in signals)


def _retry_delay_seconds(msg: str, default: int) -> int:
    """Honor the server's RetryInfo when present ('retry in 17.5s', retryDelay)."""
    import re as _re
    m = _re.search(r"retry in ([\d.]+)s", msg)
    if m:
        try:
            return min(120, int(float(m.group(1))) + 2)
        except ValueError:
            pass
    return default


# ── Free-tier pacing (15 RPM shared across soft-filter + eval calls) ─────────

_last_call_ts = 0.0
_MIN_CALL_GAP = 5.0


def pace_llm_call() -> None:
    """Sleep so consecutive Gemini calls stay ~12 RPM, under the 15 RPM
    free-tier limit. Call at the top of every Gemini query path."""
    global _last_call_ts
    dt = time.time() - _last_call_ts
    if dt < _MIN_CALL_GAP:
        time.sleep(_MIN_CALL_GAP - dt)
    _last_call_ts = time.time()


# ── Engine queries ────────────────────────────────────────────────────────────

def _query_gemini(prompt: str) -> dict:
    from google import genai
    from google.genai import types

    client = _gemini_client()
    for attempt in range(4):
        try:
            pace_llm_call()
            resp = client.models.generate_content(
                model="gemini-flash-lite-latest",
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
                if attempt < 3:
                    wait = _retry_delay_seconds(msg, 4 * (2 ** attempt))
                    print(f"  [Gemini] Rate-limited, retry in {wait}s…")
                    time.sleep(wait)
                else:
                    raise
            elif _is_malformed_json(msg) or _is_transient_network(msg):
                # Neither is a quota problem, so the engine stays enabled. These
                # were killing whole jobs with no second attempt, which is how a
                # 141-role run lost 16 to truncated JSON and 8 to a DNS blip.
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    kind = "truncated JSON" if _is_malformed_json(msg) else "network"
                    print(f"  [Gemini] {kind}, retry {attempt + 1}/3…")
                    continue
                raise
            else:
                raise
    raise RuntimeError("Gemini exhausted retries")


def _retry_after_seconds(err: Exception) -> float:
    """Seconds the provider asked us to wait, if it said.

    Groq sends `retry-after` on a per-minute throttle. Using it is better than
    guessing: the provider knows its own budget, and a guessed delay either
    wastes time or retries straight into the same limit.
    """
    headers = getattr(err, "headers", None)
    if not headers:
        return 0.0
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
        return float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _query_groq(prompt: str) -> dict:
    from groq import Groq

    client = Groq(api_key=os.environ["GROQ_API_KEY"])
    # gpt-oss-20b first. gpt-oss-120b is deliberately last: on this account it
    # answers HTTP 200 with an EMPTY body every time, so leading with it spends a
    # request from the rate limit on a model that cannot reply. Over a 20-job
    # batch that is 20 wasted requests, which is enough on its own to trip the
    # per-minute limit and take the working model down with it - observed as
    # `scored=0 failed=20`, every failure a 429 that a healthy first choice would
    # never have caused. It stays in the list in case the account changes.
    models = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]

    for model in models:
        for attempt in range(4):
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.2,
                    # No response_format. Groq's json_object mode rejects a
                    # prompt that enumerates many required fields - reproduced
                    # minimally: two named fields succeed, the same request plus
                    # eight more returns `400 Failed to validate JSON`. This
                    # prompt needs nine, so strict mode failed on roughly half of
                    # all evaluations while reading like a model fault.
                    #
                    # _parse_json below already tolerates markdown fences and
                    # surrounding prose, so strict mode bought nothing here.
                    timeout=30,
                    max_tokens=4000,
                    # 4000, not 2000. A real evaluation prompt produces about
                    # 3500 characters of JSON; at 2000 tokens the completion is
                    # cut off mid-object and Groq reports that as
                    # `400 Failed to validate JSON`, which is indistinguishable
                    # from the model returning prose. Verified directly: the same
                    # prompt on the same client returns valid JSON with
                    # finish_reason=stop once the budget allows it. Truncation is a
                    # budget problem, so the fix is budget.
                )
                content = (resp.choices[0].message.content or "").strip()
                # An empty completion is not a success. gpt-oss-120b answers
                # HTTP 200 with an empty body on this account, so parsing its
                # result raised `Expecting value: line 1 column 1 (char 0)`, which
                # matched no retry condition and ended the engine - so the second
                # model in the list, which does answer, was never tried.
                if not content:
                    if model == models[-1]:
                        raise RuntimeError("every groq model returned an empty completion")
                    break  # next model
                return _parse_json(content)
            except Exception as e:
                msg = str(e).lower()
                # A JSON-validation refusal with no strict mode requested means
                # the model returned something the parser may still recover.
                # Retry once with a blunter instruction before giving up on the
                # engine entirely.
                if "json" in msg and attempt < 1:
                    prompt = prompt + (
                        "\n\nIMPORTANT: respond with a single raw JSON object and "
                        "no other text, no markdown fences, no commentary."
                    )
                    continue
                if any(x in msg for x in ["429", "rate limit", "daily limit"]):
                    if _is_daily_quota(msg):
                        if model == models[-1]:
                            disable_engine("groq", "daily quota exhausted")
                            raise
                        break  # try next model
                    # A per-minute throttle, not a dead key. A single Groq call
                    # takes ~44s on this account - ten sequential calls took
                    # 438s - so a batch overruns the per-minute budget and every
                    # job after the first few is throttled. Sleeping 6s and then
                    # giving up turned a throttle into a failed job, which is how
                    # a batch reported `scored=0 failed=20` while the same model
                    # answered fine when called once.
                    #
                    # Honour Retry-After when present, otherwise back off
                    # exponentially with jitter so retries do not re-synchronise.
                    if attempt < 3:
                        delay = _retry_after_seconds(e) or min(2 ** attempt * 8, 90)
                        time.sleep(delay + (attempt * 1.7))
                        continue
                    else:
                        break
                    continue
                # Retry a transient transport failure before giving up. Groq had
                # no retry at all, so a machine-wide DNS outage (observed
                # 2026-10-01 as "getaddrinfo failed", which also killed SMTP and
                # the git push in the same run) killed every job the moment the
                # cascade fell through to it, defeating the point of having a
                # fallback engine at all.
                if _is_transient_network(str(e)) and attempt < 2:
                    print(f"  [Groq] network error on {model}, retry {attempt + 1}/3…")
                    time.sleep(3 * (attempt + 1))
                    continue
                raise
    raise RuntimeError("All Groq models failed")


def _query_openai(prompt: str) -> dict:
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    for attempt in range(3):
        try:
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                response_format={"type": "json_object"},
                timeout=30,
                # 4000, not 2000. The evaluation prompt was expanded to score
                # role fit at career stage, so the completion genuinely grew and
                # 2000 truncated it mid-object - which Groq reports as
                # 400 Failed to validate JSON, indistinguishable from the model
                # returning prose. Truncation is a budget problem, so the fix is
                # budget.
                max_tokens=4000,
            )
            return _parse_json(resp.choices[0].message.content or "")
        except Exception as e:
            msg = str(e).lower()
            if "insufficient_quota" in msg:
                disable_engine("openai", "billing quota exhausted")
                raise
            if "429" in msg:
                if _is_daily_quota(msg):
                    disable_engine("openai", "quota exhausted")
                    raise
                if attempt < 2:
                    time.sleep(8)
                    continue
                raise
            # Same reasoning as the Groq path: a transient network fault must not
                # consume the last engine in the cascade on its first error.
                if _is_transient_network(str(e)) and attempt < 2:
                    print(f"  [OpenAI] network error, retry {attempt + 1}/3…")
                    time.sleep(3 * (attempt + 1))
                    continue
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

    preferred = os.getenv(
        "PREFERRED_LLM", (settings.get("llm") or {}).get("preferred", "gemini")
    ).strip().lower()
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
