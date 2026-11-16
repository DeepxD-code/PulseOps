"""Send the applications an employer asked to receive by email.

Some postings have no form at all: the whole application surface is
"Apply by email -> mailto:careers@example.com?subject=Application: ...". The
browser applier cannot press anything there, so it records the row as
``email-apply`` and appends the address to ``output/email-apply-queue.jsonl``.

This script is the other half. For each queued row it:

  1. builds the tailored resume for that job with the same builder the
     browser upload uses (``apps/browser-apply/tools/build_resume_for_job.py``),
     so an email application gets exactly the document a form upload would;
  2. writes the covering note about this specific posting from cv.md, the
     posting's own description and the stored evaluation, using the evaluator's
     Gemini client - the operator asked for a tailored body rather than a
     template, and every claim in it has to come from cv.md;
  3. sends it through ``pulseops_outreach.email_sender``, which owns the
     guardrails that matter: AUTO_SEND_EMAILS, the pause switch, the recipient
     domain boundary, and the minimum gap between sends;
  4. marks the row Applied and records the send in ``outcomes``.

Operator decisions behind it (2026-11-15): send automatically from the address
already configured in .env, and let the model tailor the body per posting.

Nothing is sent for a row that is already Applied/Sent/Verified, and nothing is
sent to an address on a job-board or ATS domain - those are hostnames, not
employers, and the transport refuses them too.

Usage:
    python scripts/apply_by_email.py                 # send everything queued
    python scripts/apply_by_email.py --dry-run       # compose, do not send
    python scripts/apply_by_email.py --job-id 1036 --to careers@alpresiresearch.com
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUEUE = ROOT / "output" / "email-apply-queue.jsonl"
BUILDER = ROOT / "apps" / "browser-apply" / "tools" / "build_resume_for_job.py"

try:
    from dotenv import load_dotenv

    # The SMTP credentials and the model key live in .env, exactly as they do
    # for every other entrypoint. Without this the transport sees no credentials
    # and refuses every send, which reads as "the queue is stuck".
    load_dotenv(ROOT / ".env", override=False)
except Exception:  # noqa: BLE001 - fall back to the ambient environment
    pass

for extra in ("packages/pulse-core/src", "packages/pulse-store/src",
              "packages/pulse-config/src", "packages/pulse-eval/src",
              "packages/pulse-outreach/src"):
    path = ROOT / extra
    if path.exists() and str(path) not in sys.path:
        sys.path.insert(0, str(path))

# Statuses that mean an application has already left this machine. Sending again
# would be a second application to the same employer, which reads as spam.
ALREADY_SENT = {"applied", "sent", "followupsent", "verified"}


def db_path() -> Path:
    raw = os.environ.get("PULSEOPS_DB") or os.environ.get("PULSEOPS_DB_PATH")
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else ROOT / path
    return ROOT / "pulseops.db"


def load_queue() -> list[dict]:
    if not QUEUE.exists():
        return []
    rows, seen = [], set()
    for line in QUEUE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = (item.get("job_id"), str(item.get("to") or "").lower())
        if key in seen:
            continue
        seen.add(key)
        rows.append(item)
    return rows


def save_queue(rows: list[dict]) -> None:
    QUEUE.parent.mkdir(parents=True, exist_ok=True)
    QUEUE.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def load_job(job_id: int) -> dict | None:
    path = db_path()
    if not path.is_file():
        return None
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT id, company, title, link, source, status, job_description, "
            "location_raw, text_summary FROM jobs WHERE id=?", (job_id,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def mark_applied(job_id: int, to_email: str, subject: str) -> None:
    path = db_path()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = sqlite3.connect(str(path), timeout=5)
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE jobs SET status='Applied' WHERE id=?", (job_id,))
        cols = {str(row[1]) for row in conn.execute("PRAGMA table_info(outcomes)")}
        if {"job_id", "stage"}.issubset(cols):
            job = conn.execute("SELECT title, company FROM jobs WHERE id=?", (job_id,)).fetchone()
            conn.execute(
                "INSERT INTO outcomes (job_id, company, title, stage, notes, recorded_at) "
                "VALUES (?,?,?,?,?,?)",
                (job_id, (job[1] if job else ""), (job[0] if job else ""),
                 "email-apply", f"emailed {subject[:150]} to {to_email}", stamp),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def build_resume(job_id: int) -> str:
    """Return the verified tailored PDF for this job, or "" when none exists."""
    try:
        proc = subprocess.run(
            [sys.executable, str(BUILDER), "--job-id", str(job_id)],
            capture_output=True, text=True, timeout=180, cwd=str(ROOT),
        )
    except Exception as exc:
        print(f"  [pdf] builder failed to run: {exc}")
        return ""
    line = (proc.stdout or "").strip().splitlines()
    payload = {}
    for candidate in reversed(line):
        try:
            payload = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    if payload.get("ok") and payload.get("pdf"):
        return str(payload["pdf"])
    print(f"  [pdf] no usable resume for #{job_id}: {payload.get('error') or 'unknown'}")
    return ""


def compose_body(job: dict, cv_text: str, email_subject: str) -> str:
    """The covering note. Every fact in it has to come from cv.md."""
    from pulseops_eval.analyzer import generate_text

    description = (job.get("job_description") or "").strip()
    prompt = (
        "You are writing a short email application on behalf of the candidate.\n"
        "Rules, all of them strict:\n"
        "- 90 to 140 words, plain text, no markdown, no bullet points, no placeholders.\n"
        "- Four short paragraphs maximum: what role, the strongest concrete match, "
        "one shipped system, and a closing line that the CV is attached.\n"
        "- Every claim must come from the CV below. Invent nothing: no years of "
        "experience beyond the CV, no employers, no metrics, no skills it does not list.\n"
        "- Lead with the backend and AI/ML work (Java, Python, Spring Boot, ML). "
        "Do not lead with frontend or Node.js unless the posting asks for them "
        "by name; the candidate's professional stack is Java, Python and ML.\n"
        "- Write as the candidate, first person, plain professional English. No "
        "superlatives, no 'passionate', no 'excited to'.\n"
        "- Do not include a subject line, a greeting placeholder, or a signature "
        "block: the sender adds those.\n"
        f"\nRole: {job.get('title')} at {job.get('company')}\n"
        f"Posting: {job.get('link')}\n"
        f"Posting description:\n{description[:3500] if description else '(not stored)'}\n"
        f"\nCV:\n{cv_text[:6000]}\n"
    )
    body = generate_text(prompt, max_output_tokens=700, temperature=0.4).strip()
    # The model sometimes still opens with a greeting or a subject line.
    lines = [line for line in body.splitlines() if line.strip()]
    if lines and lines[0].lower().startswith("subject:"):
        lines = lines[1:]
    return "\n\n".join(line.strip() for line in lines)


def sign_off(candidate: dict) -> str:
    bits = [candidate.get("name") or "", candidate.get("phone") or "",
            candidate.get("email") or ""]
    github = str(candidate.get("github") or "").strip()
    if github:
        bits.append(github)
    return "\n".join(bit for bit in bits if bit)


def load_profile() -> dict:
    import yaml

    path = ROOT / "config" / "profile.yml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def process(item: dict, *, dry_run: bool, profile: dict, cv_text: str) -> bool:
    job_id = int(item.get("job_id") or 0)
    to_email = str(item.get("to") or "").strip()
    if not job_id or "@" not in to_email:
        print(f"  [skip] malformed queue entry: {item}")
        return True

    job = load_job(job_id)
    if job is None:
        print(f"  [skip] #{job_id} is not in the database")
        return True
    if str(job.get("status") or "").strip().lower() in ALREADY_SENT:
        print(f"  [skip] #{job_id} is already {job.get('status')}")
        return True

    from pulseops_outreach.email_sender import is_untrusted_domain, send_smtp

    domain = to_email.rsplit("@", 1)[1]
    if is_untrusted_domain(domain):
        print(f"  [skip] #{job_id}: {domain} is a job board or ATS, not an employer")
        return True

    print(f"\n[#{job_id}] {job.get('company')} — {job.get('title')} → {to_email}")
    pdf = build_resume(job_id)
    if not pdf:
        # A body without the document is not an application; leave it queued so
        # the next run can try once the builder has what it needs.
        print(f"  [hold] #{job_id}: no verified resume, left in the queue")
        return False

    subject = str(item.get("subject") or "").strip()
    if not subject:
        subject = f"Application: {job.get('title')} — {profile.get('candidate', {}).get('name', '')}".strip()
    try:
        body = compose_body(job, cv_text, subject)
    except Exception as exc:
        print(f"  [hold] #{job_id}: could not compose the note ({exc})")
        return False

    signature = sign_off(profile.get("candidate", {}))
    email_text = (
        f"Subject: {subject}\n\n"
        "Dear Hiring Manager,\n\n"
        f"{body}\n\n"
        "Kind regards,\n"
        f"{signature}\n"
    )

    print(f"  [mail] subject: {subject}")
    print(f"  [mail] attach: {Path(pdf).name}")
    if dry_run:
        print("  [mail] --- composed body ---")
        for line in email_text.splitlines():
            print(f"  [mail] {line}")
        print("  [mail] --- end (dry run, nothing sent) ---")
        return False

    try:
        sent = send_smtp(
            to_email=to_email,
            email_text=email_text,
            attachment_path=pdf,
            min_gap_minutes=8,
        )
    except Exception as exc:
        print(f"  [mail] send failed: {exc}")
        return False
    if not sent:
        # AUTO_SEND_EMAILS=false, send paused, or the domain was refused.
        print(f"  [hold] #{job_id}: transport declined the send, left in the queue")
        return False

    mark_applied(job_id, to_email, subject)
    print(f"  [db] job #{job_id} -> Applied (email submission)")
    return True


def main() -> int:
    # The console on this machine is cp1252, and an arrow or a rupee sign in a
    # log line would abort the run with a UnicodeEncodeError in the middle of a
    # send. UTF-8 with replacement is what the rest of the pipeline runs under.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a stream that cannot be reconfigured is fine
            pass

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", type=int, help="one row instead of the whole queue")
    parser.add_argument("--to", help="recipient for --job-id")
    parser.add_argument("--subject", default="", help="override the subject")
    parser.add_argument("--dry-run", action="store_true", help="compose but do not send")
    args = parser.parse_args()

    profile = load_profile()
    cv_path = ROOT / "cv.md"
    if not cv_path.exists():
        print(f"[email-apply] missing {cv_path}")
        return 1
    cv_text = cv_path.read_text(encoding="utf-8")

    queue = load_queue()
    if args.job_id:
        queue = [{
            "job_id": args.job_id,
            "to": args.to or "",
            "subject": args.subject,
        }]

    if not queue:
        print("[email-apply] nothing queued")
        return 0

    remaining = queue
    for item in queue:
        done = process(item, dry_run=args.dry_run, profile=profile, cv_text=cv_text)
        if done:
            remaining = [row for row in remaining if row is not item]
    if not args.job_id and not args.dry_run:
        save_queue(remaining)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
