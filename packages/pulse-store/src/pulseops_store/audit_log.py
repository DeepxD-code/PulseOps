"""
persistence/audit_log.py — Append-only JSONL audit log.

Non-negotiable #3: Every autonomous action logged to append-only audit log.
Files: logs/audit_YYYY-MM.jsonl — rotated monthly, NEVER truncated, NEVER rewritten.
"""

import json
import uuid
from datetime import datetime
from pathlib import Path

from pulseops_core.exceptions import AuditLogError

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"


def _log_path() -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    month = datetime.now().strftime("%Y-%m")
    return LOG_DIR / f"audit_{month}.jsonl"


def generate_run_id() -> str:
    """8-char UUID prefix used as run_id across jobs/run_stats/source_health."""
    return uuid.uuid4().hex[:8]


def write(action: str, run_id: str = "", extra: dict | None = None) -> None:
    """
    Append one JSON line. AuditLogError is non-fatal — callers should catch
    it and continue the pipeline (per exceptions.py docstring), but the
    failure itself is always surfaced to stdout first.
    """
    entry = {"ts": datetime.now().isoformat(), "run_id": run_id, "action": action}
    if extra:
        entry.update(extra)
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, default=str, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"  [AuditLog] WARNING write failed: {e}")
        raise AuditLogError(f"Failed to write audit entry '{action}': {e}") from e


# ── Typed convenience writers (one per pipeline event) ─────────────────────

def write_run_start(run_id: str, run_type: str = "daily") -> None:
    write("RUN_START", run_id, {"run_type": run_type})


def write_run_end(run_id: str, stats: dict) -> None:
    write("RUN_END", run_id, {"stats": stats})


def write_source_health(run_id: str, source_name: str, jobs_found: int, consecutive_zeros: int) -> None:
    write("SOURCE_HEALTH", run_id, {
        "source": source_name, "jobs_found": jobs_found, "consecutive_zeros": consecutive_zeros,
    })


def write_filter_reject(run_id: str, company: str, title: str, stage: int, reason: str) -> None:
    write("FILTER_REJECT", run_id, {
        "company": company, "title": title, "stage": stage, "reason": reason,
    })


def write_eval(run_id: str, company: str, title: str, score: int, grade: str,
               engine: str, tokens: int, duration_ms: int) -> None:
    write("EVALUATION", run_id, {
        "company": company, "title": title, "score": score, "grade": grade,
        "engine": engine, "tokens": tokens, "duration_ms": duration_ms,
    })


def write_send_decision(run_id: str, company: str, title: str, action: str, reason: str = "") -> None:
    write("SEND_DECISION", run_id, {
        "company": company, "title": title, "action": action, "reason": reason,
    })


def write_followup(run_id: str, company: str, title: str, action: str, reason: str = "") -> None:
    write("FOLLOWUP", run_id, {
        "company": company, "title": title, "action": action, "reason": reason,
    })


def write_reply_detected(run_id: str, sender_email: str, subject: str, job_id: int | None = None) -> None:
    write("REPLY_DETECTED", run_id, {
        "sender_email": sender_email, "subject": subject, "job_id": job_id,
    })


def write_outcome(run_id: str, company: str, title: str, stage: str) -> None:
    write("OUTCOME_RECORDED", run_id, {"company": company, "title": title, "stage": stage})


def write_prep_pack_sent(run_id: str, company: str, title: str) -> None:
    write("PREP_PACK_SENT", run_id, {"company": company, "title": title})


def write_memory(run_id: str, category: str, action: str, summary: str = "") -> None:
    write("MEMORY_RECORDED", run_id, {"category": category, "action": action, "summary": summary})


def write_telegram_message(run_id: str, kind: str, ok: bool, detail: str = "") -> None:
    write("TELEGRAM_MESSAGE", run_id, {"kind": kind, "ok": ok, "detail": detail})


def write_discord_message(run_id: str, kind: str, ok: bool, detail: str = "") -> None:
    write("DISCORD_MESSAGE", run_id, {"kind": kind, "ok": ok, "detail": detail})


def write_pause_state(run_id: str, paused: bool) -> None:
    write("SEND_PAUSE_STATE", run_id, {"paused": paused})


def write_digest_sent(run_id: str, ok: bool) -> None:
    write("WEEKLY_DIGEST", run_id, {"ok": ok})


def write_tsv_export(run_id: str, files: list[str]) -> None:
    write("TSV_EXPORT", run_id, {"files": files})
