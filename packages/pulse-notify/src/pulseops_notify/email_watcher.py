"""
notifications/email_watcher.py — IMAP bounce auto-fix + platform job ingest (runs hourly)

Watches the SMTP_EMAIL / IMAP_EMAIL inbox for:
  1. Bounces / Address not found (550 5.1.1, 550 5.4.1, Delivery Status Notification)
     → auto-fix: mark outreach as bounced, pause domain (G9), blacklist if needed, clear G8 queue
  2. Job platform matched listings (Naukri, Indeed, Glassdoor, LinkedIn, Wellfound, JobHai, YC, Instahyre)
     → auto-ingest: extract job cards from email body → insert into jobs table for next pipeline scoring

Runs via: python -m notifications.email_watcher  (dry-run with --dry-run)
         and via .github/workflows/watcher.yml every 30m
         and via main.py Phase 9 (light sweep)
"""
from __future__ import annotations

import email
import imaplib
import os
import re
from datetime import datetime, timedelta
from email.header import decode_header

from dotenv import load_dotenv

load_dotenv()

from pulseops_store import db_manager as db

BOUNCE_SUBJECT_RE = re.compile(r"(delivery status notification|undeliverable|address not found|mail delivery failed|returned mail|bounced|550 5\.1\.1|550 5\.4\.1)", re.IGNORECASE)
BOUNCE_BODY_RE = re.compile(r"(550 5\.1\.1|address not found|recipient rejected|user unknown|mailbox unavailable|delivery has failed)", re.IGNORECASE)

# The sentence the mailbox writes when a recipient does not exist, e.g. Google's
# "Your message wasn't delivered to hiring@anthropic.com because the address
# couldn't be found". Reading this phrase names one address unambiguously,
# unlike "the first email in the body" - which also finds the help links and
# the sender's own address.
BOUNCE_RECIPIENT_RES = (
    re.compile(r"(?:wasn'?t|was not|has not been|could not be|couldn'?t be)\s+delivered\s+to\s+([\w.+-]+@[\w.-]+)", re.I),
    re.compile(r"delivery\s+to\s+(?:the\s+following\s+recipients?\s+)?(?:failed|permanently failed)[^@]{0,40}?([\w.+-]+@[\w.-]+)", re.I),
    re.compile(r"your\s+message\s+to\s+([\w.+-]+@[\w.-]+)", re.I),
)

# One or more dot-separated labels. The old pattern required TWO labels after
# the @, so an ordinary address (hiring@anthropic.com) was invisible: 75 real
# bounces sat in the inbox unrecognised while the follow-up engine kept
# re-sending to mailboxes Gmail had already refused.
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

PLATFORM_SENDERS = {
    "naukri": ["naukri.com", "naukri@naukri.com", "do-not-reply@naukri.com"],
    "indeed": ["indeed.com", "no-reply@indeed.com", "indeedapply@indeed.com"],
    "glassdoor": ["glassdoor.com", "no-reply@glassdoor.com"],
    "linkedin": ["linkedin.com", "messages-noreply@linkedin.com", "jobs-noreply@linkedin.com"],
    "wellfound": ["wellfound.com", "wellfound.co", "angel.co"],
    "jobhai": ["jobhai.com"],
    "yc": ["workatastartup.com", "ycombinator.com"],
    "instahyre": ["instahyre.com"],
}

def _decode(s: str | None) -> str:
    if not s:
        return ""
    try:
        parts = decode_header(s)
        out = []
        for v, enc in parts:
            out.append(v.decode(enc or "utf-8", errors="ignore") if isinstance(v, bytes) else v)
        return "".join(out)
    except Exception:
        return str(s)

def _snippet(msg: email.message.Message, n=800) -> str:
    txt = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    txt = payload.decode("utf-8", errors="ignore")[:n]
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            txt = payload.decode("utf-8", errors="ignore")[:n]
    return " ".join(txt.split())

def _is_own_or_agent_address(address: str) -> bool:
    low = (address or "").lower()
    if not low:
        return True
    own = {v.lower() for v in (os.getenv("SMTP_EMAIL"), os.getenv("IMAP_EMAIL")) if v}
    if low in own:
        return True
    return any(marker in low for marker in ("mailer-daemon", "googlemail.com", "google.com"))


def _dsn_recipients(msg: email.message.Message | None) -> list[str]:
    """Read Final-Recipient / Original-Recipient out of a DSN report part."""
    if msg is None:
        return []
    found: list[str] = []
    try:
        parts = msg.walk() if msg.is_multipart() else [msg]
    except Exception:
        return []
    for part in parts:
        if part.get_content_type() != "message/delivery-status":
            continue
        payload = part.get_payload()
        chunks = payload if isinstance(payload, list) else [payload]
        for chunk in chunks:
            text = chunk.as_string() if hasattr(chunk, "as_string") else str(chunk)
            for match in re.finditer(r"(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^>\s;]+)", text, re.I):
                found.append(match.group(1))
    return found


def _extract_bounced_email(subject: str, body: str, original_msg: email.message.Message | None = None) -> str | None:
    # 1. The report part is the machine-readable truth when the mailbox
    #    includes one.
    for candidate in _dsn_recipients(original_msg):
        if not _is_own_or_agent_address(candidate):
            return candidate.strip(";<>")
    # 2. The sentence the mailbox wrote. Names one address, no guessing.
    for pattern in BOUNCE_RECIPIENT_RES:
        for match in pattern.finditer(body or ""):
            if not _is_own_or_agent_address(match.group(1)):
                return match.group(1).strip(";<>")
    # 3. Anything quoted as the failed recipient.
    for pattern in (r"Original-Recipient:\s*rfc822;([^\s]+)", r"Final-Recipient:\s*rfc822;([^\s]+)", r"Recipient:\s*([^\s]+@[^\s]+)"):
        match = re.search(pattern, body or "", re.IGNORECASE)
        if match and not _is_own_or_agent_address(match.group(1)):
            return match.group(1).strip(";<>")
    # 4. Last resort: the first address in a message already known to be a
    #    bounce. Only reached when the phrasing above changed.
    if BOUNCE_BODY_RE.search(body or "") or BOUNCE_SUBJECT_RE.search(subject or ""):
        for candidate in EMAIL_RE.findall(body or ""):
            if not _is_own_or_agent_address(candidate):
                return candidate
    return None

def _detect_platform(from_addr: str, subject: str) -> str | None:
    low = (from_addr + " " + subject).lower()
    for platform, senders in PLATFORM_SENDERS.items():
        for s in senders:
            if s.lower() in low:
                return platform
    return None

def _is_transient_delay(subject: str, body: str) -> bool:
    """True for "delayed, we will keep trying" mail, which is not a bounce.

    Gmail files both a delay and a permanent failure under the same
    "Delivery Status Notification" subject, so the search cannot tell them
    apart. A delay means the server is still retrying; condemning the mailbox
    on one would suppress an address that works.
    """
    text = f"{subject or ''} {body or ''}".lower()
    if re.search(r"\b(?:failure|failed permanently|address not found|does not exist|user unknown)\b", text):
        return False
    if re.search(r"\bdelay(?:ed)?\b", text) and re.search(r"retry|will (?:keep|continue) trying|still trying|temporar", text):
        return True
    return "delivery status notification (delay)" in text


def run_watcher(dry_run: bool = False, limit_per_folder: int = 20) -> dict:
    imap_host = os.getenv("IMAP_HOST", "imap.gmail.com")
    imap_email = os.getenv("IMAP_EMAIL") or os.getenv("SMTP_EMAIL", "")
    imap_password = os.getenv("IMAP_PASSWORD") or os.getenv("SMTP_PASSWORD", "")
    if not imap_email or not imap_password:
        print("[watcher] IMAP_EMAIL/IMAP_PASSWORD (or SMTP_*) not set — failing loud, not silent-skip")
        return {"bounces_fixed": 0, "platform_jobs_ingested": 0, "skipped": True, "error": "missing IMAP creds"}

    # Connect
    try:
        mail = imaplib.IMAP4_SSL(imap_host, 993, timeout=20)
        mail.login(imap_email, imap_password)
    except Exception as e:
        print(f"[watcher] IMAP login failed: {e}")
        return {"error": str(e)}

    stats = {
        "bounces_fixed": 0,
        "bounces_seen": 0,
        "bounces_transient": 0,
        "bounces_unmatched": [],
        "platform_jobs_ingested": 0,
        "bounces": [],
        "platform_jobs": [],
    }
    try:
        for folder in ["INBOX"]:
            try:
                mail.select(folder)
            except Exception:
                continue
            # 1. Bounces: search recent 7 days, subject contains bounce keywords
            for keyword in ['"Delivery Status Notification"', '"Undeliverable"', '"Address not found"', '"Returned mail"', '"Mail Delivery Failed"']:
                try:
                    status, data = mail.search(None, f'SUBJECT {keyword}')
                    if status != "OK" or not data or not data[0]:
                        continue
                    for msg_id in data[0].split()[-limit_per_folder:]:
                        status, msg_data = mail.fetch(msg_id, "(RFC822)")
                        if status != "OK":
                            continue
                        msg = email.message_from_bytes(msg_data[0][1])
                        subject = _decode(msg.get("Subject", ""))
                        body = _snippet(msg, 1500)
                        # A DELAY is not a bounce. Gmail sends the same
                        # "Delivery Status Notification" subject for "your
                        # message is delayed, we will keep trying", and the
                        # search matches both. Marking a mailbox dead on a delay
                        # would kill a perfectly good address, so only a
                        # permanent failure gets to condemn one.
                        if _is_transient_delay(subject, body):
                            stats["bounces_transient"] += 1
                            continue
                        bounced = _extract_bounced_email(subject, body, msg)
                        if not bounced:
                            continue
                        stats["bounces_seen"] += 1
                        # The address is the identifier, not the send date. This
                        # used to match only outreach from the last 30 days, so
                        # mail sent in September and bounced in November matched
                        # nothing: 75 bounces were sitting in the inbox while
                        # this loop reported "bounces_fixed 0", the domain was
                        # never paused, and the follow-up engine kept re-sending
                        # to mailboxes Gmail had already refused.
                        matches = db.get_outreach_by_contact_email(bounced)
                        if not matches:
                            # Still a real bounce - we may simply have no row for
                            # it (an unsubscribe reply, a stale manual send). Say
                            # so instead of counting it as nothing.
                            stats["bounces_unmatched"].append(bounced)
                            print(f"[bounce] {bounced} — no outreach row for this address; not marked")
                            continue
                        print(f"[bounce] {bounced} from {matches[0].get('company')} — {subject[:80]}")
                        stats["bounces"].append(bounced)
                        if dry_run:
                            stats["bounces_fixed"] += 1
                            continue
                        try:
                            # One dead mailbox means every message to it failed,
                            # so mark them all - that is what removes them from
                            # the follow-up and send-queue candidate sets.
                            changed = db.mark_address_bounced(bounced)
                            for row in matches:
                                if row.get("job_id"):
                                    db.update_job_status(row["job_id"], "Bounced")
                            # G9 pauses the domain from the bounce count.
                            stats["bounces_fixed"] += changed
                        except Exception as e:
                            print(f"  [bounce fix failed] {e}")
                except Exception as e:
                    print(f"[watcher] bounce search {keyword} failed: {e}")

            # 2. Platform job listings: from Naukri/Indeed etc. in last 3 days
            # Search for recent platform senders
            for platform in PLATFORM_SENDERS:
                for sender_fragment in PLATFORM_SENDERS[platform][:1]:  # just first per platform to avoid too many searches
                    try:
                        # Use SINCE to limit to last 7 days
                        since = (datetime.now() - timedelta(days=7)).strftime("%d-%b-%Y")
                        status, data = mail.search(None, f'(FROM "{sender_fragment}" SINCE "{since}")')
                        if status != "OK" or not data or not data[0]:
                            continue
                        for msg_id in data[0].split()[-5:]:
                            status, msg_data = mail.fetch(msg_id, "(RFC822)")
                            if status != "OK":
                                continue
                            msg = email.message_from_bytes(msg_data[0][1])
                            subject = _decode(msg.get("Subject", ""))
                            body = _snippet(msg, 3000)
                            # Extract jobs: look for job titles + links in body
                            jobs_found = []
                            # Naukri style: Job Title at Company
                            for m in re.finditer(r"(.{0,40}?(Engineer|Developer|Intern|Backend|AI|ML).{0,60}?)\n", body, re.IGNORECASE):
                                title = m.group(1).strip()[:80]
                                if len(title) > 10:
                                    jobs_found.append(title)
                            if jobs_found:
                                print(f"[platform {platform}] {subject[:60]} — {len(jobs_found)} jobs hint")
                                for title in jobs_found[:3]:
                                    # No fabricated links: store Message-ID + subject, leave link empty for human review
                                    mid = msg.get("Message-ID", "") or (msg_id.decode() if isinstance(msg_id, bytes) else str(msg_id))
                                    link = ""
                                    if not dry_run:
                                        try:
                                            # Use save_job with source=Email:{platform}
                                            db.save_job(title=title, company=platform.title(), link=link, source=f"Email:{platform}", run_id="watcher", score=0, letter_grade="*", status="Sourced", posted_at=datetime.now().isoformat())
                                            stats["platform_jobs_ingested"] += 1
                                            stats["platform_jobs"].append(f"{platform}: {title}")
                                        except Exception as e:
                                            print(f"  ingest failed {e}")
                                    else:
                                        stats["platform_jobs_ingested"] += 1
                    except Exception as e:
                        print(f"[watcher] platform {platform} failed: {e}")

        print(
            f"[watcher] done — {stats['bounces_fixed']} row(s) marked bounced from "
            f"{stats['bounces_seen']} bounce message(s), "
            f"{stats['bounces_transient']} transient delay(s) ignored, "
            f"{len(stats['bounces_unmatched'])} address(es) with no outreach row, "
            f"platform_jobs {stats['platform_jobs_ingested']}"
        )
        return stats
    finally:
        try:
            mail.logout()
        except Exception:
            pass

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="don't write DB")
    args = p.parse_args()
    s = run_watcher(dry_run=args.dry_run)
    print(s)
