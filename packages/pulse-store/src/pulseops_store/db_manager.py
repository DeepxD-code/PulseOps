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

import ipaddress
import json
import os
import re
import socket
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pulseops_core.exceptions import DatabaseError


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / ".git").exists():
            return p
    return here.parents[4]  # packages/pulse-store/src/pulseops_store -> repo root

ROOT       = _repo_root()
DB_PATH    = Path(os.getenv("PULSEOPS_DB", str(ROOT / "pulseops.db")))
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"

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


# ── Email/domain validation ───────────────────────────────────────────────────
# These helpers intentionally live in the persistence package as well as the
# send engine.  The cache is a security boundary: a caller must not be able to
# turn a malformed or third-party address into a persistent "verified" value.

_EMAIL_LOCAL_RE = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+")
_DOMAIN_LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_LOCAL_DOMAIN_NAMES = frozenset({
    "localhost",
    "localhost.localdomain",
    "local",
    "internal",
})
_LOCAL_DOMAIN_SUFFIXES = (".localhost", ".local", ".internal")


def _is_ip_literal_hostname(value: str) -> bool:
    """Return true for IP-literal spellings accepted by common URL clients."""
    if ":" in value:
        # A colon cannot occur in a DNS hostname.  Treat malformed and
        # zone-qualified IPv6 values as literals rather than passing them on.
        return True
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        pass
    if re.fullmatch(r"[0-9]+|0[xX][0-9a-fA-F]+", value):
        return True
    try:
        socket.inet_aton(value)
    except (OSError, ValueError):
        return False
    return True


def normalise_domain(domain: str) -> str:
    """Return a conservative, non-local ASCII hostname or ``""``.

    This is the persistence-layer boundary used by both the contact cache and
    the send engine.  It accepts a hostname or an HTTP(S) URL, but rejects
    credentials, non-web schemes, IP literals, and local/internal names before
    any caller can use the result for discovery or delivery.  DNS address
    classification is performed by the shared public URL policy immediately
    before an HTTP request; normalising a domain does not perform network I/O.
    """
    if not isinstance(domain, str):
        return ""
    value = domain.strip().lower()
    if not value:
        return ""
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        return ""
    if "\\" in value or ("@" in value and "://" not in value):
        return ""

    # Accept either a hostname or an HTTP(S) URL, but never retain a
    # path/port/query and never silently discard URL credentials.
    if "://" in value:
        try:
            parsed = urlsplit(value)
            scheme = parsed.scheme.lower()
            # Accessing ``port`` catches malformed/out-of-range ports.
            _ = parsed.port
            hostname = parsed.hostname
            authority = parsed.netloc.rsplit("@", 1)[-1]
        except ValueError:
            return ""
        if scheme not in {"http", "https"}:
            return ""
        if (
            parsed.username is not None
            or parsed.password is not None
            or "@" in parsed.netloc
            or authority.endswith(":")
            or not hostname
        ):
            return ""
        value = hostname.lower()
    else:
        value = value.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
        if value.count(":") == 1:
            host, possible_port = value.rsplit(":", 1)
            if not possible_port.isdigit():
                return ""
            value = host
        elif ":" in value:
            return ""

    value = value.rstrip(".")
    if not value or _is_ip_literal_hostname(value):
        return ""

    try:
        value = value.encode("idna").decode("ascii")
    except UnicodeError:
        return ""

    if value in _LOCAL_DOMAIN_NAMES or value.endswith(_LOCAL_DOMAIN_SUFFIXES):
        return ""

    labels = value.split(".")
    if len(labels) < 2 or any(not _DOMAIN_LABEL_RE.fullmatch(label) for label in labels):
        return ""
    if len(value) > 253 or any(len(label) > 63 for label in labels):
        return ""
    # A normal public hostname has an alphabetic TLD or an IDNA A-label.  This
    # rejects IP-like/local-only values while retaining valid .com/.co.in etc.
    tld = labels[-1]
    if not ((len(tld) >= 2 and tld.isalpha()) or tld.startswith("xn--")):
        return ""
    return ".".join(labels)


def normalise_email(email: str) -> str:
    """Return a syntactically valid address, normalised for comparison.

    This is deliberately stricter than ``email.utils.parseaddr`` (which accepts
    display-name forms and malformed separators).  Company-domain matching is
    performed separately by :func:`email_matches_domain`.
    """
    if not isinstance(email, str):
        return ""
    value = email.strip()
    if not value or len(value) > 254 or any(ch.isspace() or ord(ch) < 32 for ch in value):
        return ""
    if value.count("@") != 1:
        return ""

    local, domain_part = value.rsplit("@", 1)
    if not local or len(local) > 64 or local.startswith(".") or local.endswith("."):
        return ""
    if ".." in local or not _EMAIL_LOCAL_RE.fullmatch(local):
        return ""

    domain = normalise_domain(domain_part)
    if not domain:
        return ""
    return f"{local}@{domain}"


def email_matches_domain(email: str, domain: str) -> bool:
    """True only when *email* is valid and its domain exactly equals *domain*."""
    normalised_email = normalise_email(email)
    normalised_domain = normalise_domain(domain)
    if not normalised_email or not normalised_domain:
        return False
    return normalised_email.rsplit("@", 1)[1] == normalised_domain


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
    """Return the kill-switch state, accepting the persisted text variants.

    The setting is written by several clients and may be edited by hand, so
    comparison must be case-insensitive and whitespace-tolerant.  An unknown
    value is not an invitation to send: raise a database-domain error so the
    caller can fail closed and keep the send pipeline stopped.
    """
    raw = get_setting("send_paused", "0")
    if raw is None:
        raw = ""
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off", ""}:
        return False
    raise DatabaseError(f"Invalid send_paused setting: {raw!r}")


def set_send_paused(paused: bool) -> None:
    set_setting("send_paused", "1" if paused else "0")


# ── Jobs ─────────────────────────────────────────────────────────────────────

_JOB_FIELDS = [
    "title", "company", "company_normalised", "link", "source", "run_id",
    "score", "letter_grade", "status", "posted_at", "location_raw",
    "location_resolved", "text_summary", "skill_gap", "bullet_adjustments",
    # The posting's own description. Distinct from text_summary, which is the
    # evaluator's assessment OF THE CANDIDATE. Role scope is judged on this.
    "job_description",
    "tailored_skills", "star_stories", "level_strategy", "comp_research",
    "negotiation_notes", "recruiter_message", "recruiter_email", "contact_email",
    "inferred_domain", "domain_confidence", "email_variant_used", "eval_engine",
    "eval_tokens", "eval_duration_ms", "pdf_path", "report_path", "processed_at",
]

# These states represent an action already taken, a human gate, or an
# intentionally paused/simulated row.  Re-running a scraper/evaluator must not
# turn one of them back into Evaluated/Sourced and make it eligible for a
# second browser action.  ``update_job_status`` remains the explicit,
# human/worker-owned transition seam; ``save_job`` is an upsert and never uses
# that seam to change a protected state.
PROTECTED_JOB_STATUSES = frozenset({
    "Applied", "Sent", "FollowupSent", "Verified", "NeedsReview",
    "NeedsVerification", "Expired", "Skipped", "Simulated", "SendPaused",
    "EmailQueued", "Applying", "Replied", "phone_screen", "technical",
    "final", "offer", "accepted", "rejected",
})
# Backwards/forwards-compatible alias for callers that used the shorter name.
PROTECTED_STATUSES = PROTECTED_JOB_STATUSES
_PROTECTED_STATUS_KEYS = frozenset(
    re.sub(r"[\s_-]+", "", value).lower() for value in PROTECTED_JOB_STATUSES
)


def _status_key(status: object) -> str:
    return re.sub(r"[\s_-]+", "", str(status or "").strip()).lower()


def is_protected_job_status(status: object) -> bool:
    """Return whether *status* must be preserved by an upsert/re-evaluation."""
    return _status_key(status) in _PROTECTED_STATUS_KEYS


# Short alias for integrations that already use the generic name.
is_protected_status = is_protected_job_status


def _find_job_row(cur: sqlite3.Cursor, title: str, company: str, link: str = ""):
    """Find the same identity save_job uses, preferring protected rows.

    The link match is exact because it is the database's unique job key.  The
    title/company fallback is retained for legacy rows, but a protected match
    wins over a stale non-protected duplicate.
    """
    clean_link = str(link or "").strip()
    exact_row = None
    if clean_link:
        exact_row = cur.execute("SELECT * FROM jobs WHERE link=? LIMIT 1", (clean_link,)).fetchone()
        if exact_row and is_protected_job_status(exact_row["status"]):
            return exact_row
    rows = cur.execute(
        "SELECT * FROM jobs WHERE LOWER(title)=? AND LOWER(company)=? ORDER BY id ASC",
        (str(title or "").lower().strip(), str(company or "").lower().strip()),
    ).fetchall()
    # Even when a non-protected row has the exact incoming link, prefer a
    # protected legacy row with the same title/company.  This prevents a
    # second URL variant from bypassing a terminal application.
    for row in rows:
        if is_protected_job_status(row["status"]):
            return row
    if exact_row:
        return exact_row
    return rows[0] if rows else None


def get_job_for_identity(title: str, company: str, link: str = "") -> dict | None:
    """Return the existing row for an exact link or legacy title/company key.

    Live orchestrators use this to avoid re-evaluating protected rows even when
    ``--force`` is set.  It is read-only; status changes must go through an
    explicit transition function.
    """
    conn = get_connection()
    try:
        row = _find_job_row(conn.cursor(), title, company, link)
        return _row(row)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_job_for_identity: {e}")
        raise DatabaseError(
            f"get_job_for_identity failed for '{title}'@'{company}': {e}"
        ) from e
    finally:
        conn.close()


def _letter_grade(score: int) -> str:
    if score >= 90: return "A"
    if score >= 80: return "B"
    if score >= 70: return "C"
    if score >= 60: return "D"
    return "F"


def save_job(
    title: str, company: str, link: str = "", source: str = "", run_id: str = "",
    score: int = 0, posted_at: str = "", location_raw: str = "", location_resolved: str = "",
    text_summary: str = "", job_description: str = "",
    skill_gap_list: list | None = None,
    bullet_adjustments_list: list | None = None, tailored_skills: list | None = None,
    star_stories: list | None = None, level_strategy: str = "", comp_research: str = "",
    negotiation_notes: str = "", recruiter_message: str = "", recruiter_email: str = "",
    contact_email: str = "", inferred_domain: str = "", domain_confidence: str = "",
    email_variant_used: str = "", eval_engine: str = "", eval_tokens: int = 0,
    eval_duration_ms: int = 0, pdf_path: str = "", report_path: str = "",
    status: str = "Sourced", letter_grade: str = "",
) -> int:
    """Upsert a job while preserving terminal/protected state.

    The lookup and update run in one ``BEGIN IMMEDIATE`` transaction.  A
    protected existing row keeps its status (and identity/provenance fields),
    even when a force re-evaluation supplies ``status='Evaluated'``.  Callers
    that intentionally change state must use :func:`update_job_status` (or the
    worker-specific explicit transition), never this ingestion upsert.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.cursor()
        existing = _find_job_row(cur, title, company, link)
        requested_status = str(status or "Sourced").strip() or "Sourced"

        values = {
            "title": str(title or "").strip(), "company": str(company or "").strip(),
            "company_normalised": normalise_company(str(company or "")),
            "link": str(link or "").strip() or None, "source": source, "run_id": run_id,
            "score": score, "letter_grade": letter_grade or _letter_grade(score),
            "status": requested_status, "posted_at": posted_at, "location_raw": location_raw,
            "location_resolved": location_resolved, "text_summary": text_summary,
    "job_description": job_description,
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

        if existing:
            job_id = int(existing["id"])
            if is_protected_job_status(existing["status"]):
                # Keep the exact row and its identity intact.  Updating the
                # analytical fields is safe, but replacing title/company/link
                # could make a terminal application appear to be a new job.
                values["status"] = existing["status"]
                for field in ("title", "company", "company_normalised", "link", "source", "run_id"):
                    values[field] = existing[field]

                # Browser claims use processed_at as the durable owner marker
                # (browser-apply-claim|timestamp|owner).  A force re-evaluation
                # must not replace that field: doing so would make the current
                # owner lose its lease and could allow a second application.
                # Preserve the complete marker, including its timestamp, byte
                # for byte as stored in SQLite.
                existing_marker = existing["processed_at"]
                if (
                    _status_key(existing["status"]) == "applying"
                    and isinstance(existing_marker, str)
                    and existing_marker.startswith("browser-apply-claim|")
                ):
                    values["processed_at"] = existing_marker
            set_clause = ", ".join(f"{k}=?" for k in values)
            cur.execute(f"UPDATE jobs SET {set_clause} WHERE id=?", (*values.values(), job_id))
        else:
            cols = ", ".join(values.keys())
            placeholders = ", ".join("?" for _ in values)
            cur.execute(f"INSERT INTO jobs ({cols}) VALUES ({placeholders})", tuple(values.values()))
            job_id = int(cur.lastrowid)

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
    """True when this posting has already been sourced.

    Identity is the link first. The (title, company) pair is only a fallback,
    and only when the employer is actually known: 64 Wellfound rows were stored
    with company "Unknown", and matching on that permanently blocked every later
    posting that happened to share a title — a different employer's "Software
    Engineer" looked already seen.
    """
    conn = get_connection()
    try:
        if link and link.strip():
            if conn.execute("SELECT 1 FROM jobs WHERE link=?", (link.strip(),)).fetchone():
                return True

        title_norm = (title or "").strip().lower()
        company_norm = (company or "").strip().lower()
        if not title_norm or company_norm in {"", "unknown", "n/a", "na", "-", "none"}:
            return False

        rows = conn.execute(
            "SELECT company FROM jobs WHERE LOWER(title)=?", (title_norm,)
        ).fetchall()
        target = normalise_company(company)
        return any(normalise_company(row["company"]) == target for row in rows)
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
    """Persist an auto-email row only with an exact, valid recipient domain.

    Empty-recipient rows are retained for synthetic cooldown records, but any
    row that contains an email address must name the same company domain.  The
    send engine and the transport repeat this check; keeping it here prevents a
    future caller from turning a third-party address into a persisted send.
    """
    if not isinstance(contact_email, str):
        if contact_email:
            raise DatabaseError("save_outreach requires a string recipient address")
        contact_email = ""
    raw_email = contact_email.strip()
    raw_domain = domain.strip() if isinstance(domain, str) else ""
    normalised_domain = normalise_domain(raw_domain) if raw_domain else ""
    if raw_domain and not normalised_domain:
        raise DatabaseError(
            f"save_outreach refused invalid company domain: {domain!r}"
        )
    if str(status or "").strip().lower() == "sent" and not raw_email:
        raise DatabaseError(
            "save_outreach refused a sent row without a verified recipient address"
        )

    if raw_email:
        normalised_email = normalise_email(raw_email)
        if not normalised_email or not email_matches_domain(
            normalised_email, normalised_domain
        ):
            raise DatabaseError(
                "save_outreach refused an email outside the exact company domain"
            )
        contact_email = normalised_email
        domain = normalised_domain
    else:
        # Keep synthetic/non-email rows (for example memory cooldowns) valid,
        # but do not preserve an unsafe domain string supplied alongside them.
        contact_email = ""
        domain = normalised_domain

    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO outreach "
            "(job_id, company, company_normalised, domain, contact_email, subject, "
            " body, email_variant, sent_at, status, channel) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, company.strip(), normalise_company(company), domain,
             contact_email, subject.strip(), body, email_variant, _now(), status,
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
    """Return outreach rows with the associated job title.

    G2 historically read ``job_title`` from this function, but the query used
    to select ``outreach.*`` only; since ``outreach`` has no title column the
    check silently never fired.  Keep the existing ``outreach.*`` shape and
    add a LEFT JOIN so historical/manual rows remain visible even if a job was
    removed.
    """
    conn = get_connection()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT o.*, j.title AS job_title, j.company AS job_company, "
            "j.company_normalised AS job_company_normalised "
            "FROM outreach o LEFT JOIN jobs j ON j.id = o.job_id "
            "WHERE o.sent_at >= ? ORDER BY o.sent_at DESC",
            (cutoff,),
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_recent_outreach: {e}")
        raise DatabaseError(f"get_recent_outreach failed: {e}") from e
    finally:
        conn.close()


def get_sent_outreach_with_jobs(company_normalised: str = "") -> list[dict]:
    """Return all sent outreach joined to jobs for semantic duplicate checks.

    The optional company argument is retained for callers that want to narrow
    the result later.  The underlying historical helper now performs the join;
    delegating through it keeps older callers/tests that stub that seam working
    while still covering the full retained history.
    """
    del company_normalised  # filtering is performed by the send-engine helper
    rows = get_recent_outreach(days=36500)
    return [row for row in rows if str(row.get("status", "")).lower() == "sent"]


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
            """
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


def has_outreach_status(job_id: int, status: str, channel: str | None = None) -> bool:
    """Return True when this job already has an outreach row in ``status``."""
    conn = get_connection()
    try:
        if channel:
            row = conn.execute(
                "SELECT 1 FROM outreach WHERE job_id=? AND status=? AND channel=? LIMIT 1",
                (job_id, status, channel),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM outreach WHERE job_id=? AND status=? LIMIT 1",
                (job_id, status),
            ).fetchone()
        return row is not None
    except sqlite3.Error as e:
        print(f"  [DB Error] has_outreach_status: {e}")
        raise DatabaseError(f"has_outreach_status failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def has_posted_review_card(job_id: int) -> bool:
    """True after a G10 review card was delivered, regardless of legacy channel."""
    return has_outreach_status(job_id, "review_posted")


def ensure_review_outreach(job_id: int, company: str, domain: str = "",
                           reason: str = "") -> int:
    """Create one review row for a G10 miss, idempotently across processes.

    The current schema has no partial unique index for review rows.  SQLite's
    ``BEGIN IMMEDIATE`` write transaction is therefore the application-level
    uniqueness lock: concurrent callers serialise, re-check after acquiring the
    lock, and either reuse the existing row or insert exactly one.  The lookup
    intentionally includes legacy rows whose ``channel`` is ``email``; this is
    what preserves the 17 pending rows already present in existing databases.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id FROM outreach WHERE job_id=? "
            "AND status IN ('needs_review', 'review_sending', 'review_posted') "
            "ORDER BY CASE status WHEN 'review_posted' THEN 0 ELSE 1 END, id DESC "
            "LIMIT 1",
            (job_id,),
        ).fetchone()
        if row:
            review_id = int(row["id"])
            conn.commit()
            return review_id

        company_value = str(company or "Unknown").strip() or "Unknown"
        domain_value = str(domain or "").strip().lower()
        reason_value = str(reason or "").strip()
        cur = conn.execute(
            "INSERT INTO outreach "
            "(job_id, company, company_normalised, domain, contact_email, subject, "
            " body, email_variant, sent_at, status, channel, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, company_value, normalise_company(company_value), domain_value, "",
             f"Human review: {company_value}", reason_value, "g10_review", _now(),
             "needs_review", "discord_review", reason_value),
        )
        review_id = int(cur.lastrowid)
        conn.commit()
        return review_id
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] ensure_review_outreach: {e}")
        raise DatabaseError(f"ensure_review_outreach failed for job_id={job_id}: {e}") from e
    finally:
        conn.close()


def get_pending_review_jobs(limit: int = 20) -> list[dict]:
    """Return undelivered G10 review rows, highest score first.

    ``LEFT JOIN`` is intentional: a review must remain visible even if its job
    row is missing or temporarily unavailable.
    """
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT o.id AS outreach_id, o.job_id, o.company, o.domain, "
            "       o.notes AS review_reason, o.sent_at, o.status AS review_status, "
            "       o.channel AS review_channel, "
            "       j.title, j.link, j.source, j.score, j.letter_grade, "
            "       j.text_summary, j.skill_gap, j.recruiter_message, "
            "       j.recruiter_email, j.contact_email, j.inferred_domain, "
            "       j.domain_confidence, j.pdf_path "
            "FROM outreach o LEFT JOIN jobs j ON j.id=o.job_id "
            "WHERE o.status='needs_review' "
            "ORDER BY COALESCE(j.score, 0) DESC, o.id ASC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
        return _rows(rows)
    except sqlite3.Error as e:
        print(f"  [DB Error] get_pending_review_jobs: {e}")
        raise DatabaseError(f"get_pending_review_jobs failed: {e}") from e
    finally:
        conn.close()


def count_pending_review_jobs() -> int:
    """Count every pending review row, including legacy ``email`` rows."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM outreach WHERE status='needs_review'"
        ).fetchone()
        return int(row["n"] if row else 0)
    except sqlite3.Error as e:
        print(f"  [DB Error] count_pending_review_jobs: {e}")
        raise DatabaseError(f"count_pending_review_jobs failed: {e}") from e
    finally:
        conn.close()


def get_review_outreach_status(outreach_id: int) -> str | None:
    """Return the current status of one exact review row."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT status FROM outreach WHERE id=?", (outreach_id,)
        ).fetchone()
        return str(row["status"]) if row else None
    except sqlite3.Error as e:
        print(f"  [DB Error] get_review_outreach_status: {e}")
        raise DatabaseError(
            f"get_review_outreach_status failed for id={outreach_id}: {e}"
        ) from e
    finally:
        conn.close()


def claim_review_card(outreach_id: int, job_id: int | None = None) -> bool:
    """Atomically claim one pending review row for at-most-once delivery.

    A successful claim changes the exact row to ``review_sending``. Competing
    workers therefore cannot post the same card concurrently. The state is not
    automatically reset after a crash: retrying an ambiguous external side
    effect is less safe than leaving the row visible for manual reconciliation.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        where = "id=? AND status='needs_review'"
        params: list[object] = [outreach_id]
        if job_id is not None:
            where += " AND job_id=?"
            params.append(job_id)
        cur = conn.execute(
            "UPDATE outreach SET status='review_sending', sent_at=? " + f"WHERE {where}",
            (_now(), *params),
        )
        conn.commit()
        return bool(cur.rowcount)
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] claim_review_card: {e}")
        raise DatabaseError(f"claim_review_card failed for id={outreach_id}: {e}") from e
    finally:
        conn.close()


def release_review_card(outreach_id: int, reason: str = "") -> bool:
    """Release a claimed row after a confirmed non-delivery/transport failure."""
    conn = get_connection()
    try:
        detail = str(reason or "delivery failed").strip()[:300]
        cur = conn.execute(
            "UPDATE outreach SET status='needs_review', "
            "notes=CASE WHEN COALESCE(notes,'')='' THEN ? "
            "ELSE notes || '; ' || ? END "
            "WHERE id=? AND status='review_sending'",
            (detail, detail, outreach_id),
        )
        conn.commit()
        return bool(cur.rowcount)
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] release_review_card: {e}")
        raise DatabaseError(f"release_review_card failed for id={outreach_id}: {e}") from e
    finally:
        conn.close()


def mark_review_card_posted(outreach_id: int, job_id: int | None = None) -> bool:
    """Mark exactly one outreach row as delivered; safe to call repeatedly.

    ``job_id`` is an optional consistency check.  The primary key is always
    used for the update, so a newer pending row for the same job can never be
    marked by mistake.
    """
    conn = get_connection()
    try:
        where = "id=? AND status IN ('needs_review','review_sending')"
        params: list[object] = [outreach_id]
        if job_id is not None:
            where += " AND job_id=?"
            params.append(job_id)
        cur = conn.execute(
            "UPDATE outreach SET status='review_posted', channel='discord_review', "
            "notes=CASE WHEN COALESCE(notes, '') LIKE '%Discord review card posted%' THEN notes "
            "WHEN COALESCE(notes, '')='' THEN 'Discord review card posted' "
            "ELSE notes || '; Discord review card posted' END "
            f"WHERE {where}",
            params,
        )
        if cur.rowcount:
            conn.commit()
            return True

        # Another worker may have completed the exact row between SELECT and
        # UPDATE.  Treat that as success, but never fall back to ``job_id``.
        status_row = conn.execute(
            "SELECT status FROM outreach WHERE id=?", (outreach_id,)
        ).fetchone()
        conn.commit()
        return bool(status_row and status_row["status"] == "review_posted")
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] mark_review_card_posted: {e}")
        raise DatabaseError(
            f"mark_review_card_posted failed for outreach_id={outreach_id}: {e}"
        ) from e
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


def claim_pending_queue_item() -> dict | None:
    """Atomically claim one live queue item for processing.

    Claims are persisted as ``processing`` before any SMTP work starts, so two
    daily/watcher processes cannot consume the same deferred send concurrently.
    A process crash intentionally leaves an explicit ``processing`` row for
    manual reconciliation rather than automatically risking a duplicate send.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT q.*, j.title AS job_title, j.company AS job_company, "
            "j.status AS job_status, j.link AS job_link, j.source AS job_source "
            "FROM send_queue q JOIN jobs j ON j.id=q.job_id "
            "WHERE q.status='pending' "
            "ORDER BY q.score DESC, q.queued_at ASC, q.id ASC LIMIT 1"
        ).fetchone()
        if row is None:
            conn.commit()
            return None
        cur = conn.execute(
            "UPDATE send_queue SET status='processing', processed_at=? "
            "WHERE id=? AND status='pending'",
            (_now(), int(row["id"])),
        )
        if cur.rowcount != 1:
            conn.rollback()
            return None
        conn.commit()
        return _row(row)
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] claim_pending_queue_item: {e}")
        raise DatabaseError(f"claim_pending_queue_item failed: {e}") from e
    finally:
        conn.close()


def resolve_stale_processing_queue(timeout_minutes: int = 60) -> int:
    """Resolve abandoned queue claims without retrying an ambiguous send.

    A crashed SMTP worker may have sent before losing its DB connection. Marking
    old claims ``uncertain`` makes the outcome visible and prevents automatic
    duplicate delivery.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cutoff = (
            datetime.now() - timedelta(minutes=max(1, int(timeout_minutes)))
        ).isoformat()
        rows = conn.execute(
            "SELECT id, job_id FROM send_queue "
            "WHERE status='processing' AND processed_at < ?",
            (cutoff,),
        ).fetchall()
        if not rows:
            conn.commit()
            return 0
        queue_ids = [int(row["id"]) for row in rows]
        job_ids = [int(row["job_id"]) for row in rows if row["job_id"] is not None]
        placeholders = ",".join("?" for _ in queue_ids)
        conn.execute(
            f"UPDATE send_queue SET status='uncertain', processed_at=? "
            f"WHERE status='processing' AND id IN ({placeholders})",
            (_now(), *queue_ids),
        )
        if job_ids:
            job_placeholders = ",".join("?" for _ in job_ids)
            conn.execute(
                f"UPDATE jobs SET status='NeedsVerification' "
                f"WHERE id IN ({job_placeholders}) "
                f"AND status IN ('Evaluated','EmailQueued')",
                tuple(job_ids),
            )
        conn.commit()
        return len(queue_ids)
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] resolve_stale_processing_queue: {e}")
        raise DatabaseError(f"resolve_stale_processing_queue failed: {e}") from e
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


def get_domain_contact(domain: str) -> dict | None:
    """Return a cached contact only when it is valid for this exact domain."""
    normalised_domain = normalise_domain(domain)
    if not normalised_domain:
        return None
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT domain, email, source FROM domain_contacts "
            "WHERE lower(domain)=? AND bounce_count < 2",
            (normalised_domain,),
        ).fetchone()
        if not row:
            return None
        cached = dict(row)
        if not email_matches_domain(cached.get("email", ""), normalised_domain):
            # Do not propagate a stale/third-party row written by an older
            # build.  Do not delete it here: this function is also used by
            # simulation, which must perform no cache writes.
            return None
        cached["domain"] = normalised_domain
        cached["email"] = normalise_email(cached["email"])
        return cached
    except sqlite3.Error:
        return None  # table may not exist yet (pre-008 DBs)
    finally:
        conn.close()


def save_domain_contact(domain: str, email: str, source: str) -> bool:
    """Persist a contact only after exact-domain and syntax validation."""
    normalised_domain = normalise_domain(domain)
    normalised_email = normalise_email(email)
    if not email_matches_domain(normalised_email, normalised_domain):
        print(
            "  [G10] refused domain-contact cache write: address does not "
            f"match {normalised_domain or domain!r}"
        )
        return False
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO domain_contacts (domain, email, source, found_at) "
            "VALUES (?,?,?,?) ON CONFLICT(domain) DO UPDATE SET "
            "email=excluded.email, source=excluded.source, found_at=excluded.found_at",
            (normalised_domain, normalised_email, str(source or "unknown"), _now()),
        )
        conn.commit()
        return True
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] save_domain_contact: {e}")
        return False
    finally:
        conn.close()


def bump_domain_contact(domain: str, bounced: bool) -> None:
    normalised_domain = normalise_domain(domain)
    if not normalised_domain:
        return
    conn = get_connection()
    try:
        if bounced:
            conn.execute(
                "UPDATE domain_contacts SET bounce_count=bounce_count+1 WHERE lower(domain)=?",
                (normalised_domain,),
            )
        else:
            conn.execute(
                "UPDATE domain_contacts SET send_count=send_count+1 WHERE lower(domain)=?",
                (normalised_domain,),
            )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
    finally:
        conn.close()


def mark_outreach_bounced(outreach_id: int, bounced_email: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE outreach SET status='bounced', notes=? WHERE id=?",
            (f"bounced: {bounced_email}", outreach_id),
        )
        if "@" in bounced_email:
            conn.execute(
                "UPDATE domain_contacts SET bounce_count=bounce_count+1 "
                "WHERE lower(domain)=?",
                (bounced_email.rsplit("@", 1)[-1].lower(),),
            )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"  [DB Error] mark_outreach_bounced: {e}")
        raise DatabaseError(f"mark_outreach_bounced failed: {e}") from e
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
