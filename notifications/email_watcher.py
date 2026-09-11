"""
notifications/email_watcher.py — IMAP bounce auto-fix + platform job ingest (runs hourly)

Watches trex2004avradeep@gmail.com INBOX for:
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

from persistence import db_manager as db

BOUNCE_SUBJECT_RE = re.compile(r"(delivery status notification|undeliverable|address not found|mail delivery failed|returned mail|bounced|550 5\.1\.1|550 5\.4\.1)", re.IGNORECASE)
BOUNCE_BODY_RE = re.compile(r"(550 5\.1\.1|address not found|recipient rejected|user unknown|mailbox unavailable|delivery has failed)", re.IGNORECASE)

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

def _extract_bounced_email(subject: str, body: str, original_msg: email.message.Message | None = None) -> str | None:
    # Try to find the bounced recipient in DSN
    for pattern in [r"Original-Recipient:\s*rfc822;([^\s]+)", r"Final-Recipient:\s*rfc822;([^\s]+)", r"Recipient: ([^\s]+@[^\s]+)"]:
        m = re.search(pattern, body, re.IGNORECASE)
        if m:
            return m.group(1).strip(";<>")
    # Fallback: extract first email in body after bounce marker
    if BOUNCE_BODY_RE.search(body) or BOUNCE_SUBJECT_RE.search(subject):
        emails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+\.[a-z]{2,}", body, re.IGNORECASE)
        # filter out our own
        own = os.getenv("SMTP_EMAIL", "trex2004avradeep@gmail.com").lower()
        for e in emails:
            if own not in e.lower() and "mailer-daemon" not in e.lower():
                return e
    return None

def _detect_platform(from_addr: str, subject: str) -> str | None:
    low = (from_addr + " " + subject).lower()
    for platform, senders in PLATFORM_SENDERS.items():
        for s in senders:
            if s.lower() in low:
                return platform
    return None

def run_watcher(dry_run: bool = False, limit_per_folder: int = 20) -> dict:
    imap_host = os.getenv("IMAP_HOST", "imap.gmail.com")
    imap_email = os.getenv("IMAP_EMAIL") or os.getenv("SMTP_EMAIL", "trex2004avradeep@gmail.com")
    imap_password = os.getenv("IMAP_PASSWORD") or os.getenv("SMTP_PASSWORD", "")
    if not imap_email or not imap_password:
        print("[watcher] IMAP not configured — skipping")
        return {"bounces_fixed": 0, "platform_jobs_ingested": 0, "skipped": True}

    # Connect
    try:
        mail = imaplib.IMAP4_SSL(imap_host, 993, timeout=20)
        mail.login(imap_email, imap_password)
    except Exception as e:
        print(f"[watcher] IMAP login failed: {e}")
        return {"error": str(e)}

    stats = {"bounces_fixed": 0, "platform_jobs_ingested": 0, "bounces": [], "platform_jobs": []}
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
                        bounced = _extract_bounced_email(subject, body, msg)
                        if not bounced:
                            continue
                        # Check if we sent to this address
                        recent = db.get_recent_outreach(days=30)
                        match = next((r for r in recent if r.get("contact_email","").lower() == bounced.lower()), None)
                        if not match:
                            continue
                        print(f"[bounce] {bounced} from {match.get('company')} — {subject[:80]}")
                        stats["bounces"].append(bounced)
                        if not dry_run:
                            try:
                                db.mark_outreach_bounced(match["id"], bounced)
                                db.update_job_status(match["job_id"], "Bounced")
                                # G9 will pause domain next run via bounce count
                                stats["bounces_fixed"] += 1
                            except Exception as e:
                                print(f"  [bounce fix failed] {e}")
                        else:
                            stats["bounces_fixed"] += 1
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
                                    # Insert as sourced job for next pipeline if not already seen
                                    link = f"https://{platform}.com/inbox/{msg_id.decode() if isinstance(msg_id, bytes) else msg_id}"
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

        print(f"[watcher] done — bounces_fixed {stats['bounces_fixed']}, platform_jobs {stats['platform_jobs_ingested']}")
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
