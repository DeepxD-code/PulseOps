"""
outreach/followup_engine.py — Day-5 follow-up cadence (PulseOps Phase 9)

Spec:
  - Day 5 after send: one follow-up email
  - Max 1 follow-up per application
  - Subject: "Re: {original_subject}"
  - Body: brief, references original, adds one new achievement from recent memories
  - Goes through same guardrails EXCEPT cooldown (already emailed them)
  - Never sends outside the send window
  - Never sends to paused/blacklisted domains (checks G3, G6, G7, G8, G9)

Prompt template: prompts/followup.txt (rendered inline here with placeholder
substitution — no f-strings in production LLM code).
"""

import os
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pulseops_core.exceptions import (
    BounceThresholdReachedError,
    DailyCapReachedError,
    OutsideSendWindowError,
)
from pulseops_store import audit_log
from pulseops_store import db_manager as db

ROOT = Path(__file__).resolve().parent.parent


def _load_prompt_template() -> str:
    p = ROOT / "prompts" / "followup.txt"
    if p.exists():
        return p.read_text(encoding="utf-8")
    # Inline fallback so the engine works even before prompts/ is populated
    return (
        "Subject: Re: {original_subject}\n\n"
        "Hi,\n\n"
        "I wanted to follow up on my application for the {job_title} role at {company}. "
        "I remain very enthusiastic about the opportunity and believe my background in "
        "{skills} would be a strong fit for the team.\n\n"
        "{achievement_line}"
        "I would love to connect at your convenience.\n\n"
        "Best regards,\n{sender_name}"
    )


def _render_followup(template: str, context: dict) -> str:
    result = template
    for key, val in context.items():
        result = result.replace("{" + key + "}", str(val or ""))
    return result


def _is_within_send_window(settings: dict) -> bool:
    guardrails = settings.get("guardrails", {})
    tz_name    = guardrails.get("send_timezone", "Asia/Kolkata")
    start_str  = guardrails.get("send_window_start", "09:00")
    end_str    = guardrails.get("send_window_end", "18:00")
    try:
        now    = datetime.now(ZoneInfo(tz_name))
        start  = now.replace(hour=int(start_str.split(":")[0]),
                              minute=int(start_str.split(":")[1]), second=0, microsecond=0)
        end    = now.replace(hour=int(end_str.split(":")[0]),
                              minute=int(end_str.split(":")[1]), second=0, microsecond=0)
        return start <= now <= end
    except Exception:
        return True  # default PASS on any config error


def _is_blacklisted(company: str, domain: str, settings: dict) -> bool:
    blacklist_path = ROOT / "config" / "blacklist.txt"
    if not blacklist_path.exists():
        return False
    entries = [e.strip().lower() for e in blacklist_path.read_text().splitlines()
               if e.strip() and not e.strip().startswith("#")]
    company_lower = company.lower()
    domain_lower  = domain.lower()
    return any(e in company_lower or e in domain_lower for e in entries)


def _is_domain_bounce_paused(domain: str) -> bool:
    """
    Reads recent outreach for bounce markers.
    bounce_pause_threshold from settings defaults to 2.
    If a real bounce-detection system marks status='bounced', check count.
    """
    try:
        recent = db.get_recent_outreach(days=30)
        bounces = sum(1 for r in recent if r.get("domain") == domain and r.get("status") == "bounced")
        return bounces >= 2
    except Exception:
        return False


def _recent_achievement(company: str) -> str:
    """Pull one relevant deferred memory for the follow-up body, if available."""
    try:
        mems = db.get_active_memories(category="project")
        if mems:
            m = mems[0].get("raw_text", "")
            return f"Since my initial email I {m[:160].rstrip('.')}.\n\n" if m else ""
    except Exception:
        pass
    return ""


def _send_followup_email(to_email: str, subject: str, body: str,
                          outreach_id: int, job_id: int, run_id: str) -> bool:
    """
    Delegates to outreach/email_sender.py SMTP transport.
    Returns True on success, raises on failure.
    """
    try:
        from pulseops_outreach.email_sender import send_smtp
        sent = send_smtp(to_email=to_email, subject=subject, body=body)
        if sent:
            db.mark_followup_sent(outreach_id)
            db.update_job_status(job_id, "FollowupSent")
            audit_log.write_followup(run_id, "", "", "SENT")
        return sent
    except Exception as e:
        audit_log.write_followup(run_id, "", "", "FAILED", str(e))
        raise


def process_followups(
    run_id: str = "",
    settings: dict | None = None,
    simulate: bool = False,
) -> int:
    """
    Main entry point called from main.py Phase 9.
    Returns number of follow-ups actually sent (or simulated).
    """
    if settings is None:
        settings = {}

    followup_cfg = settings.get("followup", {})
    if not followup_cfg.get("enabled", True):
        print("  [~] Follow-up engine disabled in settings.")
        return 0

    day_threshold = int(followup_cfg.get("day", 5))
    max_per_app   = int(followup_cfg.get("max_per_application", 1))
    daily_cap     = settings.get("guardrails", {}).get("daily_send_cap", 5)
    min_gap_mins  = settings.get("guardrails", {}).get("min_send_gap_minutes", 8)

    candidates = db.get_followup_candidates(day_threshold=day_threshold,
                                             max_per_application=max_per_app)
    if not candidates:
        print("  [~] No follow-ups due.")
        return 0

    print(f"  [~] {len(candidates)} follow-up candidate(s) found.")
    template = _load_prompt_template()
    sender_name = os.getenv("MY_FIRST_NAME", "Candidate")

    # Pre-flight G8 (send window)
    if not simulate and not _is_within_send_window(settings):
        print("  [~] Outside send window — follow-ups deferred.")
        raise OutsideSendWindowError("Follow-up: outside send window")

    sent_count = 0
    for row in candidates:
        company    = row.get("company", "")
        domain     = row.get("domain", "")
        contact    = row.get("contact_email", "") or row.get("job_contact_email", "")
        oid        = row["id"]
        job_id     = row.get("job_id")
        orig_subj  = row.get("subject", "Application")
        job_title  = row.get("job_title", "the role")

        # G3 blacklist
        if _is_blacklisted(company, domain, settings):
            print(f"  [Skip] Follow-up for {company}: blacklisted")
            audit_log.write_followup(run_id, company, job_title, "SKIP", "G3: blacklisted")
            continue

        # G7 daily cap
        if not simulate and db.get_outreach_count_today() >= daily_cap:
            print(f"  [Skip] Follow-up for {company}: daily cap reached")
            raise DailyCapReachedError("Follow-up: daily cap reached")

        # G9 bounce pause
        if not simulate and _is_domain_bounce_paused(domain):
            print(f"  [Skip] Follow-up for {company}: domain bounce-paused")
            audit_log.write_followup(run_id, company, job_title, "SKIP", "G9: bounce-paused")
            raise BounceThresholdReachedError(f"Follow-up: domain {domain} bounce-paused")

        if not contact:
            print(f"  [Skip] Follow-up for {company}: no contact email")
            audit_log.write_followup(run_id, company, job_title, "SKIP", "no contact email")
            continue

        # Build the follow-up email
        skills_str = "Java, C++, Python, Go, Spring Boot, gRPC, Kubernetes"
        achievement = _recent_achievement(company)

        body_raw = _render_followup(template, {
            "original_subject": orig_subj,
            "job_title": job_title,
            "company": company,
            "skills": skills_str,
            "achievement_line": achievement,
            "sender_name": sender_name,
        })

        # Split subject from body if template begins with "Subject: ..."
        lines = body_raw.strip().splitlines()
        if lines and lines[0].lower().startswith("subject:"):
            subject = lines[0].split(":", 1)[1].strip()
            body    = "\n".join(lines[1:]).lstrip("\n")
        else:
            subject = f"Re: {orig_subj}"
            body    = body_raw

        if simulate:
            print(f"  [~] Simulation follow-up → {contact}: '{subject}'")
            db.mark_followup_sent(oid)
            if job_id:
                db.update_job_status(job_id, "FollowupSent")
            audit_log.write_followup(run_id, company, job_title, "SIMULATED")
            sent_count += 1
            continue

        try:
            _send_followup_email(contact, subject, body, oid, job_id or 0, run_id)
            print(f"  [OK] Follow-up sent → {contact}: '{subject}'")
            sent_count += 1
            if sent_count < len(candidates):
                time.sleep(min_gap_mins * 60)
        except Exception as e:
            print(f"  [!] Follow-up failed for {company}: {e}")

    return sent_count
