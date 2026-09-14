"""
memory/context_loader.py — Load memory context for evaluation prompts (Phase 8)

Injects deferred memories as a MEMORY CONTEXT block prepended to the
full_evaluation prompt.  Only 'deferred' action memories are injected;
immediate-action memories (add_to_blacklist, etc.) are already handled
at parse time.

Per spec: feedback loop queries phone_screen+ status jobs for bullet reuse
examples — that is handled in db_manager.get_successful_bullets(), which
is called by the analyzer separately.
"""

from __future__ import annotations

from pulseops_store import db_manager as db


def load_context(company: str = "", limit: int = 5) -> str:
    """
    Returns a formatted MEMORY CONTEXT string ready to prepend to an LLM prompt.

    Loads:
      - Active deferred memories for this company (most recent 5)
      - Active deferred memories with no company (general notes, recent 3)

    Returns empty string if no relevant memories found.
    """
    memories: list[dict] = []

    if company:
        company_mems = db.get_active_memories(company=company, limit=limit)
        memories.extend(m for m in company_mems if m.get("action") == "deferred")

    # General memories (no company filter)
    general = db.get_active_memories(limit=10)
    for m in general:
        if m.get("action") == "deferred" and not m.get("company"):
            memories.append(m)

    if not memories:
        return ""

    lines = ["--- MEMORY CONTEXT ---"]
    seen = set()
    for m in memories[:limit]:
        mid = m.get("id")
        if mid in seen:
            continue
        seen.add(mid)
        summary = m.get("parsed", {}).get("summary") or m.get("raw_text", "")
        category = m.get("category", "note")
        lines.append(f"[{category.upper()}] {summary[:200]}")

    lines.append("--- END MEMORY CONTEXT ---")
    return "\n".join(lines)


def load_cv_candidates() -> list[dict]:
    """Returns pending cv_candidate memories for doctor.py --apply-memories."""
    return db.get_cv_candidates()
