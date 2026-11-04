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

from pulseops_outreach.email_sender import is_untrusted_domain

try:
    from pulseops_config.paths import PROMPTS_DIR, repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parent.parent
    PROMPTS_DIR = ROOT / "prompts"


def _send_pause_active() -> bool:
    """Read the global kill switch fail-closed.

    A missing/unreadable settings row is not evidence that sending is safe.
    Only an explicit false value permits a follow-up to proceed.
    """
    try:
        paused = db.get_send_paused()
    except Exception as exc:
        print(f"  [Follow-up] send pause unreadable — follow-ups skipped ({exc}).")
        return True
    if isinstance(paused, bool):
        return paused
    if isinstance(paused, int) and paused in (0, 1):
        return bool(paused)
    return True


def _validated_followup_target(row: dict) -> tuple[str, str, str]:
    """Return ``(contact, domain, reason)`` for a safe stored target.

    The outreach row's domain is the source of truth.  In particular, legacy
    and manually logged rows must not borrow a current job/evaluator domain:
    doing so could turn a third-party recruiter address into a follow-up.
    """
    raw_domain = row.get("domain", "")
    try:
        domain = db.normalise_domain(raw_domain)
    except Exception:
        domain = ""
    if not domain or domain == "unknown.com" or is_untrusted_domain(domain):
        return "", "", "G10: missing or untrusted stored domain"
    for url_key in ("job_url", "job_link", "source_url", "link", "url"):
        source_url = row.get(url_key)
        if source_url and is_untrusted_domain(source_url):
            return "", domain, "G10: job URL is a job-board/ATS domain"

    # Keep the original contact precedence: a non-empty but unsafe stored
    # contact must not silently fall back to a different job contact.
    raw_contact = row.get("contact_email", "") or row.get("job_contact_email", "") or ""
    try:
        contact = db.normalise_email(raw_contact)
    except Exception:
        contact = ""
    if not contact:
        return "", domain, "G10: no valid contact email"
    try:
        matches = bool(db.email_matches_domain(contact, raw_domain))
    except Exception:
        matches = False
    if not matches:
        return "", domain, "G10: contact does not exactly match stored domain"
    return contact, domain, ""


def _load_prompt_template() -> str:
    p = PROMPTS_DIR / "followup.txt"
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
        return False  # malformed send-window config fails closed


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
    """True when two or more distinct mailboxes on the domain have bounced.

    Same rule as G9 in the send engine: distinct dead addresses, counted over
    all history rather than the last 30 days of outreach, because the bounce
    marks the outreach row it condemns and that row can be far older than the
    bounce itself.
    """
    try:
        return db.count_bounced_addresses_for_domain(domain) >= 2
    except Exception as exc:
        print(f"  [Follow-up] bounce state unreadable — treating domain as paused ({exc}).")
        return True


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
                          outreach_id: int, job_id: int, run_id: str,
                          domain: str = "") -> bool:
    """
    Delegates to outreach/email_sender.py SMTP transport.
    Returns True on success, raises on failure.  The domain is supplied by
    the stored outreach row and is revalidated at this last local boundary.
    """
    try:
        target_domain = db.normalise_domain(domain)
    except Exception:
        target_domain = ""
    try:
        safe_target = bool(
            target_domain
            and target_domain != "unknown.com"
            and not is_untrusted_domain(target_domain)
            and db.email_matches_domain(to_email, domain)
        )
    except Exception:
        safe_target = False
    if not safe_target:
        audit_log.write_followup(
            run_id, "", "", "SKIP", "G10: unsafe follow-up target/domain"
        )
        return False

    # Keep the pause check immediately adjacent to the transport call.  The
    # caller also checks it after rendering each candidate, so a pause toggled
    # during candidate-to-candidate work is caught before this helper runs.
    if _send_pause_active():
        audit_log.write_followup(run_id, "", "", "SKIP", "send paused")
        return False

    try:
        from pulseops_outreach.email_sender import send_smtp
        sent = send_smtp(
            to_email=to_email,
            subject=subject,
            body=body,
            domain=target_domain,
        )
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

    # Preflight the global kill switch before even reading candidates.  An
    # unreadable pause state is treated exactly like an active pause.
    if _send_pause_active():
        print("  [~] Sending is paused — follow-ups deferred.")
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
        oid        = row["id"]
        job_id     = row.get("job_id")
        orig_subj  = row.get("subject", "Application")
        job_title  = row.get("job_title", "the role")

        # G10/domain safety is checked before every other follow-up work.  A
        # legacy/manual row with no verified stored domain is permanently
        # ineligible; never substitute the job's current inferred domain.
        contact, domain, target_reason = _validated_followup_target(row)
        if target_reason:
            print(f"  [Skip] Follow-up for {company}: {target_reason}")
            audit_log.write_followup(run_id, company, job_title, "SKIP", target_reason)
            continue

        # G3 blacklist
        if _is_blacklisted(company, domain, settings):
            print(f"  [Skip] Follow-up for {company}: blacklisted")
            audit_log.write_followup(run_id, company, job_title, "SKIP", "G3: blacklisted")
            continue

        # G7 daily cap. Follow-ups count: they are real mail from the same
        # mailbox, and counting only new outreach rows let nine go out in ninety
        # minutes against a cap of five.
        if not simulate and (db.get_outreach_count_today() + db.get_followup_count_today()) >= daily_cap:
            print(f"  [Skip] Follow-up for {company}: daily cap reached")
            raise DailyCapReachedError("Follow-up: daily cap reached")

        # G9 bounce pause
        if not simulate and _is_domain_bounce_paused(domain):
            print(f"  [Skip] Follow-up for {company}: domain bounce-paused")
            audit_log.write_followup(run_id, company, job_title, "SKIP", "G9: bounce-paused")
            raise BounceThresholdReachedError(f"Follow-up: domain {domain} bounce-paused")

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

        # Recheck the kill switch immediately before either a simulated send
        # decision or the live transport call.  This catches a pause toggled
        # while processing an earlier candidate or rendering this message.
        if _send_pause_active():
            print("  [~] Sending is paused — remaining follow-ups deferred.")
            return sent_count

        if simulate:
            print(f"  [~] Simulation follow-up → {contact}: '{subject}'")
            # Simulation is decision-only: do not consume the follow-up or
            # change live job/outreach/audit state.
            sent_count += 1
            continue

        try:
            sent = _send_followup_email(
                contact,
                subject,
                body,
                oid,
                job_id or 0,
                run_id,
                domain=domain,
            )
            if not sent:
                print(f"  [~] Follow-up for {company} was not sent.")
                continue
            print(f"  [OK] Follow-up sent → {contact}: '{subject}'")
            sent_count += 1
            if sent_count < len(candidates):
                time.sleep(min_gap_mins * 60)
        except Exception as e:
            print(f"  [!] Follow-up failed for {company}: {e}")

    return sent_count
