"""
outreach/email_sender.py — SMTP transport layer (PulseOps Phase 9)

Rules:
  - Called by send_engine.py ONLY (never called directly from main.py)
  - MIN_SEND_GAP enforced between any two sends (8 minutes default)
  - AUTO_SEND_EMAILS=true required in env (hard guard)
  - Gmail App Password SMTP (port 587 STARTTLS / port 465 SSL)
  - Attaches PDF resume if attachment_path exists
  - On any SMTP failure: marks outreach status='failed', re-raises

State:
  _last_send_time — module-level timestamp shared within one pipeline run.
  Reset between runs automatically (new process each cron invocation).
"""

import os
import smtplib
import time
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from pulseops_store import db_manager as db

ROOT = Path(__file__).resolve().parent.parent

# These are hosting/ATS domains, not company mail domains.  Keep the roots
# here (rather than relying on a caller to classify them) so the transport has
# its own safety boundary even when it is invoked outside send_engine.
_JOB_BOARD_ATS_ROOTS = frozenset({
    # General job boards and company-less portals.
    "indeed.com", "indeed.co.uk", "indeed.co.in",
    "glassdoor.com", "glassdoor.co.in", "glassdoor.co.uk",
    "naukri.com", "naukri.co.in", "jobhai.com", "linkedin.com",
    "monster.com", "ziprecruiter.com", "dice.com", "simplyhired.com",
    "jobstreet.com", "jobstreet.co.in", "bayt.com", "hh.ru",
    "wellfound.com", "angel.co", "workatastartup.com", "ycombinator.com",
    "remoteok.com", "weworkremotely.com", "hired.com", "otta.com",
    "welcomewell.com", "join.com", "jobvite.com", "jobvite.net",
    "shine.com", "jobtarget.com", "reed.co.uk", "totaljobs.com",
    "jobsite.co.uk", "cwjobs.co.uk", "xing.com",
    # Applicant-tracking systems and hosted career sites.
    "lever.co", "jobs.lever.co", "lever.com", "greenhouse.io", "greenhouse.co",
    "greenhouse.co.uk", "greenhouse.com", "boards.greenhouse.io",
    "job-boards.greenhouse.io", "boards.greenhouse.co", "job-boards.greenhouse.co",
    "ashbyhq.com", "jobs.ashbyhq.com", "ashby.jobs",
    "workday.com", "myworkdayjobs.com", "workdayjobs.com", "smartrecruiters.com",
    "jobs.smartrecruiters.com", "careers.smartrecruiters.com",
    "lever.net", "icims.com", "taleo.net", "pinpointhq.com", "workable.com",
    "workablejobs.com", "bamboohr.com", "recruitee.com", "teamtailor.com",
    "successfactors.com", "sapsf.com", "apply.workable.com",
})


def is_untrusted_domain(value: str) -> bool:
    """Return true for an invalid or known job-board/ATS hostname.

    ``db.normalise_domain`` accepts either a hostname or a URL.  Matching is
    performed on the registrable suffix, but only at a label boundary, so a
    company such as ``notgreenhouse.io`` is not mistaken for ``greenhouse.io``.
    Unknown and malformed values are untrusted by design.
    """
    try:
        host = db.normalise_domain(value)
    except Exception:
        return True
    if not isinstance(host, str) or not host or host == "unknown.com":
        return True
    return any(host == root or host.endswith("." + root) for root in _JOB_BOARD_ATS_ROOTS)


def _send_pause_active() -> bool:
    """Read the kill switch fail-closed, including unreadable DB state."""
    try:
        paused = db.get_send_paused()
    except Exception as exc:
        print(f"  [SMTP] send pause unreadable — send skipped ({exc}).")
        return True
    # The store contract is boolean.  Accept an integer 0/1 as a compatible
    # representation, but treat every other value as unreadable/unsafe rather
    # than allowing a truthy/None value to accidentally enable delivery.
    if isinstance(paused, bool):
        return paused
    if isinstance(paused, int) and paused in (0, 1):
        return bool(paused)
    return True


def _resolve_domain_metadata(
    domain: str | None = None,
    verified_domain: str | None = None,
) -> tuple[bool, str]:
    """Validate optional domain metadata without weakening the exact match."""
    supplied = [value for value in (domain, verified_domain) if value is not None]
    if not supplied:
        return True, ""

    normalised: list[str] = []
    for value in supplied:
        try:
            target = db.normalise_domain(value)
        except Exception:
            target = ""
        if not target or target == "unknown.com" or is_untrusted_domain(target):
            return False, ""
        normalised.append(target)
    if len(set(normalised)) != 1:
        return False, ""
    return True, normalised[0]


def _domain_matches_recipient(
    to_email: str,
    domain: str | None = None,
    verified_domain: str | None = None,
) -> bool:
    """Enforce exact recipient-domain matching when metadata is supplied."""
    if domain is None and verified_domain is None:
        # Preserve the historical no-metadata API for ordinary company
        # mailboxes, while still refusing an explicitly ATS-hosted recipient
        # when its domain is available.
        try:
            normalised = db.normalise_email(to_email)
            if normalised:
                recipient_domain = normalised.rsplit("@", 1)[1]
                return not is_untrusted_domain(recipient_domain)
        except Exception:
            return False
        return True
    ok, target = _resolve_domain_metadata(domain, verified_domain)
    if not ok or not target:
        return False
    try:
        return bool(db.email_matches_domain(to_email, target))
    except Exception:
        return False


# Module-level state for min-gap enforcement
_last_send_time: float = 0.0


def _smtp_credentials() -> tuple[str, str, str, int]:
    host     = os.getenv("SMTP_HOST", "smtp.gmail.com")
    email_   = os.getenv("SMTP_EMAIL", "")
    password = os.getenv("SMTP_PASSWORD", "")
    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    return host, email_, password, port


def _enforce_min_gap(min_gap_minutes: int = 8) -> None:
    global _last_send_time
    elapsed = time.time() - _last_send_time
    gap_seconds = min_gap_minutes * 60
    if elapsed < gap_seconds and _last_send_time > 0:
        wait = gap_seconds - elapsed
        print(f"  [SMTP] Enforcing {min_gap_minutes}m gap — waiting {wait:.0f}s…")
        time.sleep(wait)


def parse_email_subject_and_body(email_text: str) -> tuple[str, str]:
    """
    Parses LLM-generated email text with an optional leading "Subject: …" line.
    Returns (subject, body).
    """
    lines = email_text.strip().splitlines()
    subject = "Application for Backend Engineering Role"
    body_lines = []
    found_subject = False

    for line in lines:
        if not found_subject and line.lower().startswith("subject:"):
            subject = line.split(":", 1)[1].strip()
            found_subject = True
        else:
            if found_subject or line.strip():
                body_lines.append(line)

    return subject, "\n".join(body_lines).strip()


def send_smtp(
    to_email: str,
    subject: str = "",
    body: str = "",
    email_text: str = "",
    attachment_path: str = "",
    min_gap_minutes: int = 8,
    domain: str | None = None,
    verified_domain: str | None = None,
) -> bool:
    """
    Core SMTP send. Returns True on success.
    If email_text is provided, parses subject+body from it (overrides subject/body args).
    ``domain``/``verified_domain`` are optional metadata for API compatibility;
    when either is supplied, the recipient must exactly match a valid,
    non-ATS domain.  Raises smtplib.SMTPException on SMTP failure.
    """
    global _last_send_time

    # The pause and domain checks deliberately precede AUTO_SEND_EMAILS.  An
    # environment flag can enable a run, but can never override the kill switch
    # or the independent transport boundary.
    if _send_pause_active():
        print("  [SMTP] send paused — send skipped.")
        return False
    if not _domain_matches_recipient(to_email, domain, verified_domain):
        print("  [SMTP] untrusted or non-exact recipient domain — send skipped.")
        return False

    auto_send = os.getenv("AUTO_SEND_EMAILS", "false").lower() == "true"
    if not auto_send:
        print("  [SMTP] AUTO_SEND_EMAILS=false — send skipped.")
        return False

    host, smtp_email, smtp_password, port = _smtp_credentials()
    if not smtp_email or not smtp_password:
        print("  [SMTP] SMTP_EMAIL / SMTP_PASSWORD not set — send skipped.")
        return False

    if email_text:
        subject, body = parse_email_subject_and_body(email_text)

    _enforce_min_gap(min_gap_minutes)

    msg = MIMEMultipart()
    msg["From"]    = smtp_email
    msg["To"]      = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    if attachment_path and os.path.exists(attachment_path):
        with open(attachment_path, "rb") as f:
            part = MIMEApplication(f.read(), Name=os.path.basename(attachment_path))
        part["Content-Disposition"] = (f'attachment; '
                                        f'filename="{os.path.basename(attachment_path)}"')
        msg.attach(part)
        print(f"  [SMTP] Attached: {os.path.basename(attachment_path)}")

    # A pause can be toggled while the gap or attachment is being handled.
    # Check at the last boundary before constructing the SMTP client.
    if _send_pause_active():
        print("  [SMTP] send paused — send skipped.")
        return False

    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=30)
        else:
            server = smtplib.SMTP(host, port, timeout=30)
            server.ehlo()
            server.starttls()
            server.ehlo()

        server.login(smtp_email, smtp_password)
        server.sendmail(smtp_email, to_email, msg.as_string())
        server.quit()

        _last_send_time = time.time()
        print(f"  [SMTP] ✓ Sent → {to_email}: '{subject}'")
        return True

    except smtplib.SMTPException as e:
        print(f"  [SMTP] ✗ Failed → {to_email}: {e}")
        raise


def send_cold_email(
    to_email: str,
    email_text: str,
    attachment_path: str = "",
    min_gap_minutes: int = 8,
    simulate: bool = False,
    domain: str | None = None,
    verified_domain: str | None = None,
) -> bool:
    """
    Public API for send_engine.py.
    simulate=True: skips actual SMTP but still applies the domain boundary.
    The pause kill switch is honored here as well as in ``send_smtp`` so a
    future caller cannot use the simulation/public wrapper to bypass it.
    """
    if _send_pause_active():
        print("  [SMTP] send paused — send skipped.")
        return False
    if not _domain_matches_recipient(to_email, domain, verified_domain):
        print("  [SMTP] untrusted or non-exact recipient domain — send skipped.")
        return False
    if simulate:
        print(f"  [SMTP/Sim] Would send → {to_email}")
        return True
    send_kwargs = {
        "to_email": to_email,
        "email_text": email_text,
        "attachment_path": attachment_path,
        "min_gap_minutes": min_gap_minutes,
    }
    # Do not add new keywords on the legacy no-metadata path; this preserves
    # compatibility with older wrappers/mocks while still passing the safety
    # metadata whenever a caller supplies it.
    if domain is not None:
        send_kwargs["domain"] = domain
    if verified_domain is not None:
        send_kwargs["verified_domain"] = verified_domain
    return send_smtp(**send_kwargs)
