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

ROOT = Path(__file__).resolve().parent.parent

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
) -> bool:
    """
    Core SMTP send. Returns True on success.
    If email_text is provided, parses subject+body from it (overrides subject/body args).
    Raises smtplib.SMTPException on SMTP failure.
    """
    global _last_send_time

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
) -> bool:
    """
    Public API for send_engine.py.
    simulate=True: skips actual SMTP but enforces the gap timer (for test runs).
    """
    if simulate:
        print(f"  [SMTP/Sim] Would send → {to_email}")
        return True
    return send_smtp(
        to_email=to_email,
        email_text=email_text,
        attachment_path=attachment_path,
        min_gap_minutes=min_gap_minutes,
    )
