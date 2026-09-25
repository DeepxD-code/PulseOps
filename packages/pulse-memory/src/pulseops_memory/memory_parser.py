"""
memory/memory_parser.py — LLM → typed ParsedMemory (PulseOps Phase 8)

Uses the same Gemini→Groq cascade as the evaluator, with a much smaller
token budget (≤500 tokens per spec).  Simulation / no-key mode falls back
to a keyword classifier that produces a reasonable ParsedMemory without any
LLM call.

Raises MemoryParseError on total failure (all engines + fallback failed).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from pulseops_core.exceptions import MemoryParseError

try:
    from pulseops_config.paths import PROMPTS_DIR, repo_root

    ROOT = repo_root()
    PROMPT_PATH = PROMPTS_DIR / "memory_parser.txt"
except ImportError:
    ROOT = Path(__file__).resolve().parent.parent
    PROMPT_PATH = ROOT / "prompts" / "memory_parser.txt"

# The valid action values (spec)
VALID_ACTIONS = frozenset(
    ["add_to_blacklist", "add_cooldown", "flag_cv_candidate", "deferred", "none"]
)
VALID_CATEGORIES = frozenset(
    ["callback", "feedback", "project", "skill", "preference", "note"]
)

_DEFAULT: dict[str, Any] = {
    "category":    "note",
    "company":     "",
    "action":      "none",
    "summary":     "",
    "skills":      [],
    "sentiment":   "neutral",
    "stage":       "",
    "cv_candidate": False,
}


def _load_prompt(raw_text: str) -> str:
    if PROMPT_PATH.exists():
        template = PROMPT_PATH.read_text(encoding="utf-8")
    else:
        template = (
            'Parse this memory note into JSON with keys: '
            'category, company, action, summary, skills, sentiment, stage, cv_candidate.\n'
            'Note: "{raw_text}"\nReturn ONLY JSON.'
        )
    return template.replace("{raw_text}", raw_text.replace('"', '\\"'))


def _clean_json(text: str) -> dict:
    """Strip markdown fences and parse JSON; raise ValueError on failure."""
    text = re.sub(r"```(?:json)?", "", text).replace("```", "").strip()
    return json.loads(text)


def _validate(parsed: dict) -> dict:
    """Apply defaults for missing/invalid fields."""
    out = dict(_DEFAULT)
    out.update({k: v for k, v in parsed.items() if k in _DEFAULT})
    if out["category"] not in VALID_CATEGORIES:
        out["category"] = "note"
    if out["action"] not in VALID_ACTIONS:
        out["action"] = "none"
    if not isinstance(out["skills"], list):
        out["skills"] = []
    out["cv_candidate"] = bool(out.get("cv_candidate"))
    return out


# ── Keyword fallback (simulation / no LLM keys) ──────────────────────────────

_BLACKLIST_KW  = re.compile(r'\b(avoid|never|blacklist|block|skip|do not contact)\b', re.I)
_CALLBACK_KW   = re.compile(r'\b(callback|called back|interview|got a reply|reached out|heard back|scheduled)\b', re.I)
_REJECT_KW     = re.compile(r'\b(reject\w*|fail\w*|didn.t pass|no offer|withdrew|ghosted)\b', re.I)
_PROJECT_KW    = re.compile(r'\b(built|created|developed|launched|shipped|wrote|engineered|implemented)\b', re.I)
_SKILL_KW      = re.compile(r'\b(learned|studying|practicing|picked up|now know|completed course|certified)\b', re.I)
_STAGE_MAP     = {
    "phone screen": "phone_screen", "phone_screen": "phone_screen",
    "technical round": "technical", "tech round": "technical",
    "final round": "final", "offer": "offer", "rejected": "rejected",
    "accepted": "accepted",
}


def _keyword_fallback(raw_text: str) -> dict:
    text_l = raw_text.lower()
    out    = dict(_DEFAULT)
    out["summary"] = raw_text[:120].strip()

    # Category
    if _CALLBACK_KW.search(text_l):
        out["category"] = "callback"
        out["sentiment"] = "positive"
    elif _REJECT_KW.search(text_l):
        out["category"] = "feedback"
        out["sentiment"] = "negative"
        out["action"]   = "add_cooldown"
    elif _PROJECT_KW.search(text_l):
        out["category"]    = "project"
        out["action"]      = "flag_cv_candidate"
        out["cv_candidate"] = True
    elif _SKILL_KW.search(text_l):
        out["category"]    = "skill"
        out["cv_candidate"] = True
    elif _BLACKLIST_KW.search(text_l):
        out["category"] = "preference"
        out["action"]   = "add_to_blacklist"
        out["sentiment"] = "negative"

    # Company (heuristic: capitalised word(s) that looks like a proper noun company name)
    # Skip common sentence-start words and short words
    _SKIP_WORDS = frozenset(['Got', 'Built', 'Just', 'Learned', 'Did', 'Had', 'Been',
                              'Avoid', 'Failed', 'Received', 'Applied', 'Rejected',
                              'The', 'This', 'My', 'Our', 'Your', 'Their'])
    for m in re.finditer(r'(?<!\. )\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b', raw_text):
        candidate = m.group(1)
        # Must be >3 chars, not a skip word, not a stage name
        if (len(candidate) > 3
                and candidate.split()[0] not in _SKIP_WORDS
                and candidate.lower() not in ('phone', 'final', 'technical')):
            out["company"] = candidate
            break

    # Stage
    for phrase, stage in _STAGE_MAP.items():
        if phrase in text_l:
            out["stage"] = stage
            break

    # Skills
    skill_m = re.findall(
        r'\b(Java|Python|Go|C\+\+|Golang|Spring Boot|gRPC|Kafka|Redis|Kubernetes|Docker|'
        r'PostgreSQL|AWS|Terraform|GraphQL|Rust|TypeScript|Node\.js)\b', raw_text
    )
    out["skills"] = list(dict.fromkeys(skill_m))  # deduplicate, preserve order

    # If company mentioned and rejected → deferred context for next eval
    if out["company"] and out["category"] == "feedback" and out["sentiment"] == "negative":
        out["action"] = "add_cooldown"

    return out


# ── LLM query helpers ─────────────────────────────────────────────────────────

def _query_gemini(prompt: str) -> dict:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    for attempt in range(2):
        try:
            resp = client.models.generate_content(
                model="gemini-flash-lite-latest",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.2,
                    max_output_tokens=300,
                ),
            )
            return _clean_json(resp.text or "")
        except Exception as e:
            if attempt == 0 and ("429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)):
                time.sleep(4)
            else:
                raise
    raise RuntimeError("Gemini failed after retries")


def _query_groq(prompt: str) -> dict:
    from groq import Groq
    client = Groq(api_key=os.environ["GROQ_API_KEY"])
    resp = client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
        response_format={"type": "json_object"},
        timeout=15,
        max_tokens=300,
    )
    return _clean_json(resp.choices[0].message.content or "")


# ── Public API ───────────────────────────────────────────────────────────────

def parse_memory(raw_text: str, simulate: bool = False) -> dict:
    """
    Parse a raw memory string into a typed dict.

    Returns a validated dict matching _DEFAULT schema.
    Falls back through: Gemini → Groq → keyword classifier.
    Raises MemoryParseError only if ALL three fail.
    """
    if not raw_text or not raw_text.strip():
        raise MemoryParseError("Empty raw_text provided to parse_memory")

    prompt = _load_prompt(raw_text.strip())

    # Simulate / no keys → keyword fallback
    if simulate or (not os.getenv("GEMINI_API_KEY") and not os.getenv("GROQ_API_KEY")):
        return _validate(_keyword_fallback(raw_text))

    errors = []

    # Gemini
    if os.getenv("GEMINI_API_KEY"):
        try:
            return _validate(_query_gemini(prompt))
        except Exception as e:
            errors.append(f"gemini: {e}")

    # Groq
    if os.getenv("GROQ_API_KEY"):
        try:
            return _validate(_query_groq(prompt))
        except Exception as e:
            errors.append(f"groq: {e}")

    # Keyword fallback
    print(f"  [MemoryParser] LLM failed ({'; '.join(errors)}) — using keyword fallback")
    return _validate(_keyword_fallback(raw_text))
