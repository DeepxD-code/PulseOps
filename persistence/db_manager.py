"""
persistence/db_manager.py — SQLite persistence layer (12-table schema)

Tables: jobs, outreach, send_queue, recruiter_replies, recruiter_profiles,
        memories, outcomes, email_variants, source_health, run_stats,
        migrations_applied, settings

Error handling contract:
  - Every write function returns its promised value OR raises DatabaseError.
  - No bare except. Every caught sqlite3.Error is printed before raising.
  - "Not found" lookups legitimately return None — that is a valid result,
    not a failure signal.
"""

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from exceptions import DatabaseError

ROOT       = Path(__file__).resolve().parent.parent
DB_PATH    = ROOT / "pulseops.db"
MIGRATIONS = ROOT / "migrations"

_IST = ZoneInfo("Asia/Kolkata")


def _today_ist() -> str:
    """Returns current date string in IST (YYYY-MM-DD).
    Using IST here ensures G6/G7 'today' caps reset at IST midnight,
    matching the send window (09:00-18:00 IST in G8) rather than
    resetting at UTC midnight which diverges by 5:30h."""
    return datetime.now(_IST).strftime("%Y-%m-%d")

# Feedback loop (non-negotiable #10): only these statuses count as
# "reached phone_screen or beyond" — NOT 'Sent' / 'Applied'.
INTERVIEW_STATUSES = ("phone_screen", "technical", "final", "offer", "accepted")


# ── Connection / init ───────────────────────────────────────────────────────

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL mode: readers never block writers and writers never block readers.
    # This is critical when the Flask dashboard or Go TUI polls the DB while
    # a live pipeline run is writing. timeout=30 above handles the remaining
    # writer-vs-writer contention with retries rather than immediate failures.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")  # safe with WAL, meaningfully faster than FULL
    return conn


def init_db() -> None:
    """Idempotent. Runs all pending migrations in numeric order."""
    _run_migrations()


def _run_migrations() -> None:
    conn = get_connection()
    try:
        cur = conn.cursor()
        # migrations_applied is created by 001 itself, so bootstrap it first
        cur.execute("""
            CREATE TABLE IF NOT EXISTS migrations_applied (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE NOT NULL,
                applied_at TEXT NOT NULL
            )
        """)
        applied = {r[0] for r in cur.execute("SELECT filename FROM migrations_applied").fetchall()}

        if not MIGRATIONS.exists():
            return

        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name in applied:
                continue
            sql = path.read_text(encoding="utf-8")
            try:
                cur.executescript(sql)
            except sqlite3.OperationalError as e:
                msg = str(e).lower()
                # These specific errors mean the schema change this migration
                # describes is already present — migrations_applied just wasn't
                # updated (e.g. a crash between executescript and the INSERT
                # below, or manual DB surgery). The correct response is to
                # record it as applied and move on, not to crash the whole
                # pipeline on every future run over a bookkeeping mismatch.
                if "duplicate column" in msg or "already exists" in msg:
                    print(f"  [Migration] {path.name}: schema already present "
                          f"({e}) — marking applied, continuing")
                else:
                    raise
            cur.execute(
                "INSERT OR IGNORE INTO migrations_applied (filename, applied_at) VALUES (?,?)",
                (path.name, _now()),
            )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] _run_migrations: {e}")
        raise DatabaseError(f"Migration run failed: {e}") from e
    finally:
        conn.close()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().isoformat()


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def _rows(rs: list[sqlite3.Row]) -> list[dict]:
    return [dict(r) for r in rs]


def _jdump(v) -> str:
    return json.dumps(v, default=str) if v is not None else "[]"


def _jload(v: str):
    try:
        return json.loads(v) if v else []
    except (json.JSONDecodeError, TypeError):
        return []


def normalise_company(name: str) -> str:
    """Strip common corporate suffixes for fuzzy dedup / cooldown matching."""
    suffixes = [' inc', ' ltd', ' llc', ' corp', ' limited',
                ' technologies', ' solutions', ' systems', ' software']
    result = (name or "").lower().strip()
    for suffix in suffixes:
        result = result.removesuffix(suffix)
    return result.strip()


# ── Settings (kill switch, misc key/value) ─────────────────────────────────

def get_setting(key: str, default: str | None = None) -> str | None:
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    except sqlite3.Error as e:
        print(f"  [DB Error] get_setting: {e}")
        raise DatabaseError(f"get_setting failed: {e}") from e
    finally:
        conn.close()


def set_setting(key: str, value: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] set_setting: {e}")
        raise DatabaseError(f"set_setting failed: {e}") from e
    finally:
        conn.close()


def get_send_paused() -> bool:
    return get_setting("send_paused", "0") == "1"


def set_send_paused(paused: bool) -> None:
    set_setting("send_paused", "1" if paused else "0")


# ── Jobs ─────────────────────────────────────────────────────────────────────

_JOB_FIELDS = [
    "title", "company", "company_normalised", "link", "source", "run_id",
    "score", "letter_grade", "status", "posted_at", "location_raw",
    "location_resolved", "text_summary", "skill_gap", "bullet_adjustments",
    "tailored_skills", "star_stories", "level_strategy", "comp_research",
    "negotiation_notes", "recruiter_message", "recruiter_email", "contact_email",
    "inferred_domain", "domain_confidence", "email_variant_used", "eval_engine",
    "eval_tokens", "eval_duration_ms", "pdf_path", "report_path", "processed_at",
]


def _letter_grade(score: int) -> str:
    if score >= 90: return "A"
    if score >= 80: return "B"
    if score >= 70: return "C"
    if score >= 60: return "D"
    return "F"


def save_job(
    title: str, company: str, link: str = "", source: str = "", run_id: str = "",
    score: int = 0, posted_at: str = "", location_raw: str = "", location_resolved: str = "",
    text_summary: str = "", skill_gap_list: list | None = None,
    bullet_adjustments_list: list | None = None, tailored_skills: list | None = None,
    star_stories: list | None = None, level_strategy: str = "", comp_research: str = "",
    negotiation_notes: str = "", recruiter_message: str = "", recruiter_email: str = "",
    contact_email: str = "", inferred_domain: str = "", domain_confidence: str = "",
    email_variant_used: str = "", eval_engine: str = "", eval_tokens: int = 0,
    eval_duration_ms: int = 0, pdf_path: str = "", report_path: str = "",
    status: str = "Sourced", letter_grade: str = "",
) -> int:
    """Upsert by link, falling back to (title, company). Returns job_id."""
    conn = get_connection()
    try:
        cur = conn.cursor()
        existing_id = None
        if link:
            row = cur.execute("SELECT id FROM jobs WHERE link=?", (link,)).fetchone()
            if row:
                existing_id = row["id"]
        if existing_id is None:
            row = cur.execute(
                "SELECT id FROM jobs WHERE LOWER(title)=? AND LOWER(company)=?",
                (title.lower().strip(), company.lower().strip()),
            ).fetchone()
            if row:
                existing_id = row["id"]

        values = {
            "title": title.strip(), "company": company.strip(),
            "company_normalised": normalise_company(company),
            "link": (link or "").strip() or None, "source": source, "run_id": run_id,
            "score": score, "letter_grade": letter_grade or _letter_grade(score),
            "status": status, "posted_at": posted_at, "location_raw": location_raw,
            "location_resolved": location_resolved, "text_summary": text_summary,
            "skill_gap": _jdump(skill_gap_list), "bullet_adjustments": _jdump(bullet_adjustments_list),
            "tailored_skills": _jdump(tailored_skills), "star_stories": _jdump(star_stories),
            "level_strategy": level_strategy, "comp_research": comp_research,
            "negotiation_notes": negotiation_notes, "recruiter_message": recruiter_message,
            "recruiter_email": recruiter_email, "contact_email": contact_email,
            "inferred_domain": inferred_domain, "domain_confidence": domain_confidence,
            "email_variant_used": email_variant_used, "eval_engine": eval_engine,
            "eval_tokens": eval_tokens, "eval_duration_ms": eval_duration_ms,
            "pdf_path": pdf_path, "report_path": report_path, "processed_at": _now(),
        }

        if existing_id:
            set_clause = ", ".join(f"{k}=?" for k in values)
            cur.execute(f"UPDATE jobs SET {set_clause} WHERE id=?", (*values.values(), existing_id))
            job_id = existing_id
        else:
            cols = ", ".join(values.keys())
            placeholders = ", ".join("?" for _ in values)
            cur.execute(f"INSERT INTO jobs ({cols}) VALUES ({placeholders})", tuple(values.values()))
            job_id = cur.lastrowid

        conn.commit()
        return job_id
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] save_job: {e}")
        raise DatabaseError(f"save_job failed for '{title}'@'{company}': {e}") from e
    finally:
        conn.close()


def get_job(job_id: int) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        d = _row(row)
        if d:
            for f in ("skill_gap", "bullet_adjustments", "tailored_skills", "star_stories"):
                d[f] = _jload(d.get(f, "[]"))
        return d
    except sqlite3.Error as e:
        print(f"  [DB Error] get_job: {e}")
        raise DatabaseError(f"get_job failed: {e}") from e
    finally:
        conn.close()


def get_job_by_title_company(title: str, company: str) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM jobs WHERE LOWER(title)=? AND LOWER(company)=?",
            (title.lower().strip(), company.lower().strip()),
        ).fetchone()
        return _row(row)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_job_by_title_company: {e}")
        raise DatabaseError(f"get_job_by_title_company failed: {e}") from e
    finally:
        conn.close()


def is_job_processed(title: str, company: str, link: str = "") -> bool:
    conn = get_connection()
    try:
        if link and link.strip():
            if conn.execute("SELECT 1 FROM jobs WHERE link=?", (link.strip(),)).fetchone():
                return True
        return bool(conn.execute(
            "SELECT 1 FROM jobs WHERE LOWER(title)=? AND LOWER(company)=?",
            (title.lower().strip(), company.lower().strip()),
        ).fetchone())
    except sqlite3.Error as e:
        print(f"  [DB Error] is_job_processed: {e}")
        raise DatabaseError(f"is_job_processed failed: {e}") from e
    finally:
        conn.close()


def update_job_status(job_id: int, status: str) -> None:
    conn = get_connection()
    try:
        conn.execute("UPDATE jobs SET status=? WHERE id=?", (status, job_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] update_job_status: {e}")
        raise DatabaseError(f"update_job_status failed: {e}") from e
    finally:
        conn.close()


def update_job_paths(job_id: int, pdf_path: str = "", report_path: str = "") -> None:
    """
    Partial update for the resume-build step only. Deliberately NOT a
    save_job() upsert call — save_job() defaults every unspecified field
    (score=0, status='Sourced', recruiter_message='', etc.), so calling it
    here after the job's evaluation was already saved would silently wipe
    that evaluation data back to defaults. Use this instead whenever only
    the PDF/report paths need to change.
    """
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE jobs SET pdf_path=?, report_path=? WHERE id=?",
            (pdf_path, report_path, job_id),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] update_job_paths: {e}")
        raise DatabaseError(f"update_job_paths failed: {e}") from e
    finally:
        conn.close()


def update_job_status_by_title_company(title: str, company: str, status: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute(
            "UPDATE jobs SET status=? WHERE LOWER(title)=? AND LOWER(company)=?",
            (status, title.lower().strip(), company.lower().strip()),
        )
        conn.commit()
        return cur.rowcount > 0
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] update_job_status_by_title_company: {e}")
        raise DatabaseError(f"update_job_status_by_title_company failed: {e}") from e
    finally:
        conn.close()


def get_jobs_by_status(statuses: list[str], limit: int = 200) -> list[dict]:
    conn = get_connection()
    try:
        placeholders = ", ".join("?" for _ in statuses)
        rows = conn.execute(
            f"SELECT * FROM jobs WHERE status IN ({placeholders}) "
            f"ORDER BY processed_at DESC LIMIT ?",
            (*statuses, limit),
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_jobs_by_status: {e}")
        raise DatabaseError(f"get_jobs_by_status failed: {e}") from e
    finally:
        conn.close()


def get_all_jobs(limit: int = 500) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY processed_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_all_jobs: {e}")
        raise DatabaseError(f"get_all_jobs failed: {e}") from e
    finally:
        conn.close()


def get_successful_bullets() -> list[dict]:
    """
    Non-negotiable #10: feedback loop ONLY from jobs that reached
    phone_screen or beyond — never from 'Sent'/'Applied'.
    """
    conn = get_connection()
    try:
        placeholders = ", ".join("?" for _ in INTERVIEW_STATUSES)
        rows = conn.execute(
            f"SELECT bullet_adjustments FROM jobs WHERE status IN ({placeholders})",
            INTERVIEW_STATUSES,
        ).fetchall()
        out: list[dict] = []
        seen = set()
        for r in rows:
            for adj in _jload(r["bullet_adjustments"]):
                if not isinstance(adj, dict):
                    continue
                key = (adj.get("original", ""), adj.get("tailored", ""))
                if key not in seen:
                    seen.add(key)
                    out.append(adj)
        return out
    except sqlite3.Error as e:
        print(f"  [DB Error] get_successful_bullets: {e}")
        raise DatabaseError(f"get_successful_bullets failed: {e}") from e
    finally:
        conn.close()


# ── Outreach ─────────────────────────────────────────────────────────────────

def save_outreach(job_id: int, company: str, contact_email: str, subject: str,
                   body: str = "", status: str = "sent", email_variant: str = "",
                   domain: str = "") -> int:
    """Auto cold-email path (outreach/send_engine.py). Always channel='email'."""
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO outreach "
            "(job_id, company, company_normalised, domain, contact_email, subject, "
            " body, email_variant, sent_at, status, channel) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, company.strip(), normalise_company(company), domain,
             contact_email.strip(), subject.strip(), body, email_variant, _now(), status,
             "email"),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] save_outreach: {e}")
        raise DatabaseError(f"save_outreach failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def log_manual_outreach(job_id: int, company: str, channel: str = "linkedin_dm",
                         notes: str = "", domain: str = "") -> int:
    """
    Logs outreach sent by hand — the primary channel in dm_first mode.
    Called from the dashboard "Mark DM Sent" button, the Go TUI 'd' key,
    or the referral-follow-through action after a G4 alert.

    Writing here matters for two reasons, not just record-keeping:
      1. G5's cooldown check (get_last_outreach_for_company) reads status='sent'
         rows regardless of channel, so a logged DM correctly prevents the
         pipeline from also cold-emailing the same company within the
         30-day window if a verified email later becomes available.
      2. The weekly digest's callback-rate-by-score-band calibration can
         now see dm_first outreach, not just the rare auto-sent email.

    channel: 'linkedin_dm' | 'referral' | 'other'
    """
    valid_channels = {"linkedin_dm", "referral", "other", "email"}
    if channel not in valid_channels:
        channel = "other"

    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO outreach "
            "(job_id, company, company_normalised, domain, contact_email, subject, "
            " body, email_variant, sent_at, status, channel, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, company.strip(), normalise_company(company), domain,
             "", "", "", "", _now(), "sent", channel, notes.strip()),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] log_manual_outreach: {e}")
        raise DatabaseError(f"log_manual_outreach failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def get_outreach_channel_breakdown(since_iso: str) -> dict:
    """Returns {channel: count} for outreach rows since `since_iso` — used by
    the weekly digest to show DM vs email split now that dm_first is default."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT COALESCE(channel, 'email') AS ch, COUNT(*) AS n FROM outreach "
            "WHERE sent_at >= ? AND status='sent' GROUP BY ch",
            (since_iso,),
        ).fetchall()
        return {r["ch"]: r["n"] for r in rows}
    except sqlite3.Error as e:
        print(f"  [DB Error] get_outreach_channel_breakdown: {e}")
        raise DatabaseError(f"get_outreach_channel_breakdown failed: {e}") from e
    finally:
        conn.close()


def get_recent_outreach(days: int = 14) -> list[dict]:
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT * FROM outreach WHERE sent_at >= ? ORDER BY sent_at DESC", (cutoff,)
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_recent_outreach: {e}")
        raise DatabaseError(f"get_recent_outreach failed: {e}") from e
    finally:
        conn.close()


def get_recent_outreach_emails(days: int = 14) -> list[str]:
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT DISTINCT contact_email FROM outreach "
            "WHERE contact_email != '' AND sent_at >= ?", (cutoff,)
        ).fetchall()
        return [r["contact_email"] for r in rows]
    except sqlite3.Error as e:
        print(f"  [DB Error] get_recent_outreach_emails: {e}")
        raise DatabaseError(f"get_recent_outreach_emails failed: {e}") from e
    finally:
        conn.close()


def get_outreach_count_today() -> int:
    conn = get_connection()
    try:
        today = _today_ist()
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM outreach WHERE sent_at LIKE ? AND status='sent'",
            (f"{today}%",),
        ).fetchone()
        return row["n"] if row else 0
    except sqlite3.Error as e:
        print(f"  [DB Error] get_outreach_count_today: {e}")
        raise DatabaseError(f"get_outreach_count_today failed: {e}") from e
    finally:
        conn.close()


def get_outreach_count_for_domain_today(domain: str) -> int:
    conn = get_connection()
    try:
        today = _today_ist()
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM outreach "
            "WHERE domain=? AND sent_at LIKE ? AND status='sent'",
            (domain, f"{today}%"),
        ).fetchone()
        return row["n"] if row else 0
    except sqlite3.Error as e:
        print(f"  [DB Error] get_outreach_count_for_domain_today: {e}")
        raise DatabaseError(f"get_outreach_count_for_domain_today failed: {e}") from e
    finally:
        conn.close()


def get_last_outreach_for_company(company_normalised: str) -> dict | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM outreach WHERE company_normalised=? AND status='sent' "
            "ORDER BY sent_at DESC LIMIT 1",
            (company_normalised,),
        ).fetchone()
        return _row(row)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_last_outreach_for_company: {e}")
        raise DatabaseError(f"get_last_outreach_for_company failed: {e}") from e
    finally:
        conn.close()


def get_followup_candidates(day_threshold: int = 5, max_per_application: int = 1) -> list[dict]:
    """
    Outreach rows sent >= day_threshold days ago, no followup sent yet,
    whose job has not been Replied / reached an interview stage.
    """
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=day_threshold)).isoformat()
        max_followups = 1 if max_per_application <= 1 else max_per_application
        rows = conn.execute(
            f"""
            SELECT o.*, j.title AS job_title, j.score AS job_score,
                   j.contact_email AS job_contact_email, j.status AS job_status,
                   j.recruiter_email AS job_recruiter_email,
                   j.text_summary AS job_text_summary
            FROM outreach o
            JOIN jobs j ON j.id = o.job_id
            WHERE o.status = 'sent'
              AND o.sent_at <= ?
              AND o.followup_sent < ?
              AND j.status NOT IN ('Replied','phone_screen','technical','final','offer','rejected','accepted')
            ORDER BY o.sent_at ASC
            """,
            (cutoff, max_followups),
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_followup_candidates: {e}")
        raise DatabaseError(f"get_followup_candidates failed: {e}") from e
    finally:
        conn.close()


def mark_followup_sent(outreach_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE outreach SET followup_sent = followup_sent + 1, followup_sent_at=? WHERE id=?",
            (_now(), outreach_id),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] mark_followup_sent: {e}")
        raise DatabaseError(f"mark_followup_sent failed: {e}") from e
    finally:
        conn.close()


def update_outreach_status(outreach_id: int, status: str) -> None:
    conn = get_connection()
    try:
        conn.execute("UPDATE outreach SET status=? WHERE id=?", (status, outreach_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] update_outreach_status: {e}")
        raise DatabaseError(f"update_outreach_status failed: {e}") from e
    finally:
        conn.close()


# ── Send queue (G7/G8 overflow) ─────────────────────────────────────────────

def enqueue_send(job_id: int, score: int, reason: str = "") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO send_queue (job_id, score, reason, status, queued_at) "
            "VALUES (?,?,?,?,?)",
            (job_id, score, reason, "pending", _now()),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] enqueue_send: {e}")
        raise DatabaseError(f"enqueue_send failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def get_pending_queue_items(limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT q.*, j.title AS job_title, j.company AS job_company "
            "FROM send_queue q JOIN jobs j ON j.id = q.job_id "
            "WHERE q.status='pending' ORDER BY q.score DESC, q.queued_at ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_pending_queue_items: {e}")
        raise DatabaseError(f"get_pending_queue_items failed: {e}") from e
    finally:
        conn.close()


def update_queue_status(queue_id: int, status: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE send_queue SET status=?, processed_at=? WHERE id=?",
            (status, _now(), queue_id),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] update_queue_status: {e}")
        raise DatabaseError(f"update_queue_status failed: {e}") from e
    finally:
        conn.close()


def get_stale_queue_items(days: int = 3) -> list[dict]:
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT * FROM send_queue WHERE status='pending' AND queued_at < ?", (cutoff,)
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_stale_queue_items: {e}")
        raise DatabaseError(f"get_stale_queue_items failed: {e}") from e
    finally:
        conn.close()


# ── Recruiter replies (IMAP) ────────────────────────────────────────────────

def save_reply(sender_email: str, subject: str, snippet: str, received_at: str,
                job_id: int | None = None) -> bool:
    """Returns True if this is a NEW reply (not a duplicate)."""
    conn = get_connection()
    try:
        existing = conn.execute(
            "SELECT 1 FROM recruiter_replies "
            "WHERE LOWER(sender_email)=? AND LOWER(subject)=? AND received_at=?",
            (sender_email.lower(), subject.lower(), received_at),
        ).fetchone()
        if existing:
            return False
        conn.execute(
            "INSERT INTO recruiter_replies "
            "(job_id, sender_email, subject, snippet, received_at, notified) "
            "VALUES (?,?,?,?,?,0)",
            (job_id, sender_email, subject, snippet, received_at),
        )
        conn.commit()
        return True
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] save_reply: {e}")
        raise DatabaseError(f"save_reply failed: {e}") from e
    finally:
        conn.close()


def get_unnotified_replies() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM recruiter_replies WHERE notified=0 ORDER BY received_at ASC"
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_unnotified_replies: {e}")
        raise DatabaseError(f"get_unnotified_replies failed: {e}") from e
    finally:
        conn.close()


def mark_reply_notified(reply_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("UPDATE recruiter_replies SET notified=1 WHERE id=?", (reply_id,))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] mark_reply_notified: {e}")
        raise DatabaseError(f"mark_reply_notified failed: {e}") from e
    finally:
        conn.close()


def get_reply_count_since(since_iso: str) -> int:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM recruiter_replies WHERE received_at >= ?", (since_iso,)
        ).fetchone()
        return row["n"] if row else 0
    except sqlite3.Error as e:
        print(f"  [DB Error] get_reply_count_since: {e}")
        raise DatabaseError(f"get_reply_count_since failed: {e}") from e
    finally:
        conn.close()


# ── Recruiter profiles (14-day TTL cache) ──────────────────────────────────

def cache_recruiter_profiles(company: str, profiles: list[dict]) -> None:
    conn = get_connection()
    try:
        now = _now()
        conn.execute("DELETE FROM recruiter_profiles WHERE company=?", (company,))
        for p in profiles:
            conn.execute(
                "INSERT INTO recruiter_profiles (company, name, title, link, cached_at) "
                "VALUES (?,?,?,?,?)",
                (company, p.get("name", ""), p.get("title", ""), p.get("link", ""), now),
            )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] cache_recruiter_profiles: {e}")
        raise DatabaseError(f"cache_recruiter_profiles failed for '{company}': {e}") from e
    finally:
        conn.close()


def get_cached_recruiter_profiles(company: str, ttl_days: int = 14) -> list[dict] | None:
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=ttl_days)).isoformat()
        rows = conn.execute(
            "SELECT name, title, link, cached_at FROM recruiter_profiles "
            "WHERE company=? AND cached_at >= ?",
            (company, cutoff),
        ).fetchall()
        return _rows(rows) if rows else None
    except sqlite3.Error as e:
        print(f"  [DB Error] get_cached_recruiter_profiles: {e}")
        raise DatabaseError(f"get_cached_recruiter_profiles failed for '{company}': {e}") from e
    finally:
        conn.close()


# ── Memories (Layer 2) ──────────────────────────────────────────────────────

def add_memory(category: str, raw_text: str, parsed: dict | None = None,
               action: str = "", company: str = "", cv_candidate: bool = False) -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO memories (category, raw_text, parsed, action, company, "
            "cv_candidate, active, created_at) VALUES (?,?,?,?,?,?,1,?)",
            (category, raw_text, json.dumps(parsed or {}, default=str), action,
             company, 1 if cv_candidate else 0, _now()),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] add_memory: {e}")
        raise DatabaseError(f"add_memory failed: {e}") from e
    finally:
        conn.close()


def get_active_memories(category: str | None = None, company: str | None = None,
                         limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        clauses, params = ["active=1"], []
        if category:
            clauses.append("category=?"); params.append(category)
        if company:
            clauses.append("LOWER(company)=?"); params.append(company.lower())
        where = " AND ".join(clauses)
        rows = conn.execute(
            f"SELECT * FROM memories WHERE {where} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        out = _rows(rows)
        for r in out:
            r["parsed"] = json.loads(r["parsed"]) if r.get("parsed") else {}
        return out
    except sqlite3.Error as e:
        print(f"  [DB Error] get_active_memories: {e}")
        raise DatabaseError(f"get_active_memories failed: {e}") from e
    finally:
        conn.close()


def get_cv_candidates() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM memories WHERE cv_candidate=1 AND active=1 ORDER BY created_at DESC"
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_cv_candidates: {e}")
        raise DatabaseError(f"get_cv_candidates failed: {e}") from e
    finally:
        conn.close()


# ── Outcomes (Layer 3 — callback/interview stages) ─────────────────────────

def record_outcome(job_id: int | None, company: str, title: str, stage: str, notes: str = "") -> int:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO outcomes (job_id, company, title, stage, notes, recorded_at, prep_sent) "
            "VALUES (?,?,?,?,?,?,0)",
            (job_id if job_id else None, company, title, stage, notes, _now()),
        )
        if job_id:
            conn.execute("UPDATE jobs SET status=? WHERE id=?", (stage, job_id))
        conn.commit()
        return cur.lastrowid
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] record_outcome: {e}")
        raise DatabaseError(f"record_outcome failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def get_outcomes_needing_prep() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT o.*, j.star_stories AS job_star_stories, j.comp_research AS job_comp_research, "
            "       j.negotiation_notes AS job_negotiation_notes, j.skill_gap AS job_skill_gap, "
            "       j.level_strategy AS job_level_strategy "
            "FROM outcomes o LEFT JOIN jobs j ON j.id = o.job_id "
            "WHERE o.stage='phone_screen' AND o.prep_sent=0"
        ).fetchall()
        out = _rows(rows)
        for r in out:
            r["job_star_stories"] = _jload(r.get("job_star_stories", "[]"))
            r["job_skill_gap"]    = _jload(r.get("job_skill_gap", "[]"))
        return out
    except sqlite3.Error as e:
        print(f"  [DB Error] get_outcomes_needing_prep: {e}")
        raise DatabaseError(f"get_outcomes_needing_prep failed: {e}") from e
    finally:
        conn.close()


def mark_prep_sent(outcome_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("UPDATE outcomes SET prep_sent=1 WHERE id=?", (outcome_id,))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] mark_prep_sent: {e}")
        raise DatabaseError(f"mark_prep_sent failed: {e}") from e
    finally:
        conn.close()


def get_outcomes_since(since_iso: str) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM outcomes WHERE recorded_at >= ? ORDER BY recorded_at DESC", (since_iso,)
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_outcomes_since: {e}")
        raise DatabaseError(f"get_outcomes_since failed: {e}") from e
    finally:
        conn.close()


def get_callback_rate_by_score_band(since_iso: str) -> dict:
    """Returns {'70-79': {'sent': n, 'callbacks': n}, '80-89': ..., '90+': ...}."""
    conn = get_connection()
    try:
        bands = {"70-79": (70, 80), "80-89": (80, 90), "90+": (90, 101)}
        result = {}
        for label, (lo, hi) in bands.items():
            sent = conn.execute(
                "SELECT COUNT(*) AS n FROM outreach o JOIN jobs j ON j.id=o.job_id "
                "WHERE o.status='sent' AND o.sent_at >= ? AND j.score >= ? AND j.score < ?",
                (since_iso, lo, hi),
            ).fetchone()["n"]
            callbacks = conn.execute(
                "SELECT COUNT(DISTINCT o.job_id) AS n FROM outreach o "
                "JOIN jobs j ON j.id=o.job_id "
                "JOIN outcomes oc ON oc.job_id = o.job_id "
                "WHERE o.sent_at >= ? AND j.score >= ? AND j.score < ?",
                (since_iso, lo, hi),
            ).fetchone()["n"]
            result[label] = {"sent": sent, "callbacks": callbacks}
        return result
    except sqlite3.Error as e:
        print(f"  [DB Error] get_callback_rate_by_score_band: {e}")
        raise DatabaseError(f"get_callback_rate_by_score_band failed: {e}") from e
    finally:
        conn.close()


def get_callback_rate_by_variant(since_iso: str) -> dict:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT email_variant, COUNT(*) AS sends, "
            "       SUM(CASE WHEN job_id IN (SELECT job_id FROM outcomes) THEN 1 ELSE 0 END) AS callbacks "
            "FROM outreach WHERE status='sent' AND sent_at >= ? AND email_variant != '' "
            "GROUP BY email_variant",
            (since_iso,),
        ).fetchall()
        return {r["email_variant"]: {"sends": r["sends"], "callbacks": r["callbacks"] or 0} for r in rows}
    except sqlite3.Error as e:
        print(f"  [DB Error] get_callback_rate_by_variant: {e}")
        raise DatabaseError(f"get_callback_rate_by_variant failed: {e}") from e
    finally:
        conn.close()


# ── Email A/B variants ──────────────────────────────────────────────────────

def get_variant_weights() -> dict[str, float]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT variant, weight FROM email_variants").fetchall()
        return {r["variant"]: r["weight"] for r in rows}
    except sqlite3.Error as e:
        print(f"  [DB Error] get_variant_weights: {e}")
        raise DatabaseError(f"get_variant_weights failed: {e}") from e
    finally:
        conn.close()


def record_variant_send(variant: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE email_variants SET sends = sends + 1, updated_at=? WHERE variant=?",
            (_now(), variant),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] record_variant_send: {e}")
        raise DatabaseError(f"record_variant_send failed for '{variant}': {e}") from e
    finally:
        conn.close()


def record_variant_reply(variant: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE email_variants SET replies = replies + 1, updated_at=? WHERE variant=?",
            (_now(), variant),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] record_variant_reply: {e}")
        raise DatabaseError(f"record_variant_reply failed for '{variant}': {e}") from e
    finally:
        conn.close()


def recompute_variant_weights() -> dict[str, float]:
    """After 10+ total sends, reweight variants proportionally to reply rate.
    Each variant keeps a floor of 0.05 so no variant is starved to zero."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT variant, sends, replies FROM email_variants").fetchall()
        total_sends = sum(r["sends"] for r in rows)
        if total_sends < 10:
            return {r["variant"]: r["weight"] for r in
                    conn.execute("SELECT variant, weight FROM email_variants").fetchall()}

        rates = {}
        for r in rows:
            rate = (r["replies"] / r["sends"]) if r["sends"] > 0 else 0.0
            rates[r["variant"]] = max(rate, 0.01)  # avoid hard zero
        total_rate = sum(rates.values())
        floor = 0.05
        remaining = 1.0 - floor * len(rates)
        new_weights = {v: floor + remaining * (rate / total_rate) for v, rate in rates.items()}

        for variant, weight in new_weights.items():
            conn.execute(
                "UPDATE email_variants SET weight=?, updated_at=? WHERE variant=?",
                (weight, _now(), variant),
            )
        conn.commit()
        return new_weights
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] recompute_variant_weights: {e}")
        raise DatabaseError(f"recompute_variant_weights failed: {e}") from e
    finally:
        conn.close()


# ── Source health ────────────────────────────────────────────────────────────

def record_source_health(source_name: str, run_id: str, jobs_found: int, error: str = "") -> int:
    """Inserts a row and returns the NEW consecutive-zero count for this source."""
    conn = get_connection()
    try:
        prev = conn.execute(
            "SELECT consecutive_zeros FROM source_health "
            "WHERE source_name=? ORDER BY checked_at DESC LIMIT 1",
            (source_name,),
        ).fetchone()
        prev_zeros = prev["consecutive_zeros"] if prev else 0
        new_zeros = prev_zeros + 1 if jobs_found == 0 else 0

        conn.execute(
            "INSERT INTO source_health "
            "(source_name, run_id, jobs_found, consecutive_zeros, error, checked_at) "
            "VALUES (?,?,?,?,?,?)",
            (source_name, run_id, jobs_found, new_zeros, error, _now()),
        )
        conn.commit()
        return new_zeros
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] record_source_health: {e}")
        raise DatabaseError(f"record_source_health failed for '{source_name}': {e}") from e
    finally:
        conn.close()


def get_source_health_summary() -> dict[str, dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT source_name, jobs_found, consecutive_zeros, checked_at FROM source_health "
            "WHERE id IN (SELECT MAX(id) FROM source_health GROUP BY source_name)"
        ).fetchall()
        return {r["source_name"]: dict(r) for r in rows}
    except sqlite3.Error as e:
        print(f"  [DB Error] get_source_health_summary: {e}")
        raise DatabaseError(f"get_source_health_summary failed: {e}") from e
    finally:
        conn.close()


# ── Run stats ────────────────────────────────────────────────────────────────

def save_run_stats(run_id: str, run_type: str, stats: dict) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO run_stats (run_id, run_type, stats_json, created_at) VALUES (?,?,?,?)",
            (run_id, run_type, json.dumps(stats, default=str), _now()),
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] save_run_stats: {e}")
        raise DatabaseError(f"save_run_stats failed for run_id={run_id}: {e}") from e
    finally:
        conn.close()


def get_run_stats_since(since_iso: str) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM run_stats WHERE created_at >= ? ORDER BY created_at ASC", (since_iso,)
        ).fetchall()
        out = _rows(rows)
        for r in out:
            r["stats"] = json.loads(r["stats_json"]) if r.get("stats_json") else {}
        return out
    except sqlite3.Error as e:
        print(f"  [DB Error] get_run_stats_since: {e}")
        raise DatabaseError(f"get_run_stats_since failed: {e}") from e
    finally:
        conn.close()


def get_last_n_runs(n: int = 5) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM run_stats ORDER BY created_at DESC LIMIT ?", (n,)
        ).fetchall()
        out = _rows(rows)
        for r in out:
            r["stats"] = json.loads(r["stats_json"]) if r.get("stats_json") else {}
        return out
    except sqlite3.Error as e:
        print(f"  [DB Error] get_last_n_runs: {e}")
        raise DatabaseError(f"get_last_n_runs failed: {e}") from e
    finally:
        conn.close()


# ── Aggregations for weekly digest ──────────────────────────────────────────

def get_top_skill_gaps(since_iso: str, top_n: int = 5) -> list[tuple[str, int]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT skill_gap FROM jobs WHERE processed_at >= ?", (since_iso,)
        ).fetchall()
        counts: dict[str, int] = {}
        for r in rows:
            for skill in _jload(r["skill_gap"]):
                if isinstance(skill, str) and skill.strip():
                    counts[skill.strip()] = counts.get(skill.strip(), 0) + 1
        return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    except sqlite3.Error as e:
        print(f"  [DB Error] get_top_skill_gaps: {e}")
        raise DatabaseError(f"get_top_skill_gaps failed: {e}") from e
    finally:
        conn.close()
