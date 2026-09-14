"""
notifications/reply_detector.py — IMAP Gmail reply checker (PulseOps Phase 9)

check_for_replies(run_id, simulate):
  - Pulls contact_emails from outreach (last 14 days)
  - Live: IMAP4_SSL to IMAP_HOST (default imap.gmail.com:993), searches INBOX
    FROM each address, fetches last 3 messages, extracts subject/snippet
  - New replies: db_manager.save_reply() (dedup), job status -> 'Replied',
    notifier.send_reply_alert(), audit_log.write_reply_detected()
  - Simulation: generates one mock reply against the most recent outreach row
    (or skips cleanly if there's no outreach history yet)

IMAPError is non-fatal — main.py catches it via the generic Exception handler
around Phase 9, but this module also catches it internally so a broken inbox
connection never blocks follow-ups / digest from running afterward.
"""

import email
import imaplib
import os
from datetime import datetime
from email.header import decode_header

from pulseops_core.exceptions import IMAPError
from pulseops_store import audit_log
from pulseops_store import db_manager as db

from pulseops_notify import notifier


def decode_mime_words(s: str | None) -> str:
    if not s:
        return ""
    try:
        parts = decode_header(s)
        decoded = []
        for value, encoding in parts:
            if isinstance(value, bytes):
                decoded.append(value.decode(encoding or "utf-8", errors="ignore"))
            else:
                decoded.append(value)
        return "".join(decoded)
    except (LookupError, UnicodeError):
        return str(s)


def _extract_snippet(msg: email.message.Message, max_len: int = 250) -> str:
    snippet = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    snippet = payload.decode("utf-8", errors="ignore")[:max_len]
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            snippet = payload.decode("utf-8", errors="ignore")[:max_len]
    return " ".join(snippet.split())


def _job_id_for_sender(sender_email: str) -> int | None:
    """Most recent outreach row that emailed this address -> its job_id."""
    for row in db.get_recent_outreach(days=90):
        if row.get("contact_email", "").lower() == sender_email.lower():
            return row.get("job_id")
    return None


def _notify_and_record(reply: dict, run_id: str, bot_token: str | None, chat_id: str | None,
                       webhook_url: str | None = None) -> None:
    job_id = _job_id_for_sender(reply["sender_email"])
    is_new = db.save_reply(reply["sender_email"], reply["subject"], reply["snippet"],
                            reply["received_at"], job_id=job_id)
    if not is_new:
        return

    print(f"  [NEW REPLY] {reply['sender_email']}: '{reply['subject']}'")
    audit_log.write_reply_detected(run_id, reply["sender_email"], reply["subject"], job_id)

    if job_id:
        try:
            db.update_job_status(job_id, "Replied")
        except Exception as e:  # DatabaseError — non-fatal, still alert
            print(f"  [!] Could not update job {job_id} status to 'Replied': {e}")

    try:
        notifier.send_reply_alert(reply, bot_token=bot_token, chat_id=chat_id, run_id=run_id)
    except Exception as e:  # TelegramError — non-fatal
        print(f"  [!] Reply alert failed (Telegram): {e}")

    # Discord notification
    if webhook_url:
        try:
            from pulseops_notify.discord import send_discord_reply_alert
            send_discord_reply_alert(reply, webhook_url=webhook_url, run_id=run_id)
        except Exception as e:
            print(f"  [!] Reply alert failed (Discord): {e}")

    unnotified = db.get_unnotified_replies()
    if unnotified:
        db.mark_reply_notified(unnotified[0]["id"])


def _simulate_reply(run_id: str, bot_token: str | None, chat_id: str | None,
                    webhook_url: str | None = None) -> int:
    recent = db.get_recent_outreach(days=365)
    if not recent:
        print("  [~] Simulation: no outreach history yet — nothing to mock a reply against.")
        return 0

    target = recent[0]
    reply = {
        "sender_email": target["contact_email"] or "recruiter@example.com",
        "subject": f"Re: {target.get('subject') or 'Application'}",
        "snippet": ("Hi, thanks for reaching out. We reviewed your background and "
                    "would love to schedule a quick call this week. Are you free Thursday?"),
        "received_at": datetime.now().isoformat(),
    }
    print("  [~] Simulation: generated 1 mock recruiter reply.")
    _notify_and_record(reply, run_id, bot_token, chat_id, webhook_url=webhook_url)
    return 1


def check_for_replies(run_id: str = "", simulate: bool = False,
                       bot_token: str | None = None, chat_id: str | None = None,
                       webhook_url: str | None = None) -> int:
    """Returns the number of NEW replies detected."""
    bot_token = bot_token or os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = chat_id or os.getenv("TELEGRAM_CHAT_ID")
    webhook_url = webhook_url or os.getenv("DISCORD_WEBHOOK_URL", "")

    if simulate:
        return _simulate_reply(run_id, bot_token, chat_id, webhook_url=webhook_url)

    recent_emails = db.get_recent_outreach_emails(days=14)
    if not recent_emails:
        print("  [~] No outreach in the last 14 days — skipping inbox check.")
        return 0

    imap_host = os.getenv("IMAP_HOST", "imap.gmail.com")
    imap_email = os.getenv("IMAP_EMAIL") or os.getenv("SMTP_EMAIL")
    imap_password = os.getenv("IMAP_PASSWORD") or os.getenv("SMTP_PASSWORD")

    if not imap_email or not imap_password:
        print("  [~] IMAP_EMAIL / IMAP_PASSWORD not configured — skipping inbox check.")
        return 0

    new_count = 0
    try:
        mail = imaplib.IMAP4_SSL(imap_host, 993)
        try:
            mail.login(imap_email, imap_password)
            mail.select("INBOX")

            for sender in recent_emails:
                status, data = mail.search(None, f'FROM "{sender}"')
                if status != "OK" or not data or not data[0]:
                    continue

                for msg_id in data[0].split()[-3:]:
                    status, msg_data = mail.fetch(msg_id, "(RFC822)")
                    if status != "OK":
                        continue

                    msg = email.message_from_bytes(msg_data[0][1])
                    reply = {
                        "sender_email": sender,
                        "subject": decode_mime_words(msg.get("Subject", "")),
                        "snippet": _extract_snippet(msg),
                        "received_at": msg.get("Date", "") or datetime.now().isoformat(),
                    }
                    before = db.get_unnotified_replies()
                    _notify_and_record(reply, run_id, bot_token, chat_id, webhook_url=webhook_url)
                    after = db.get_unnotified_replies()
                    if len(after) != len(before):
                        new_count += 1
        finally:
            try:
                mail.logout()
            except Exception:
                pass
    except (imaplib.IMAP4.error, OSError) as e:
        print(f"  [IMAP Error] {e}")
        raise IMAPError(f"IMAP check failed: {e}") from e

    print(f"  [OK] Inbox sweep complete — {new_count} new repl{'y' if new_count == 1 else 'ies'}.")
    return new_count
