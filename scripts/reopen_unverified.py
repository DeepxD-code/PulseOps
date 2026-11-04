"""Reopen board-apply rows that were never actually submitted.

NeedsVerification and NeedsReview are terminal: the batch query only picks up
status='evaluated', so once a row lands in either state neither the engine nor
the schedule will ever look at it again. For rows that were genuinely submitted
that is correct. For rows where the click was recorded but the board never
received anything - which is what a logged-out board produces, since it shows a
signup form instead of an error - it means the row is lost.

Measured 2026-11-03: 99 NeedsVerification + 109 NeedsReview, while the automation
profile was logged in to Naukri alone. Every Wellfound click in that window
"attempted" a submission that the board still offered to accept afterwards.

So the mailbox decides, not the engine's own log:

  a row with a receipt mail (subject names the company and says the application
  was submitted) stays put - it happened;

  a row with no such mail goes back to 'evaluated' and is retried.

Conservative by design: a receipt that cannot be matched keeps the row stuck
rather than risking a duplicate application.

Usage:
    python scripts/reopen_unverified.py             # report only
    python scripts/reopen_unverified.py --apply     # write the resets
    python scripts/reopen_unverified.py --days 180  # wider mail window
"""
from __future__ import annotations

import argparse
import email
import imaplib
import re
import sqlite3
import ssl
import sys
from contextlib import closing
from email.header import decode_header, make_header
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "pulseops.db"

sys.path.insert(0, str(ROOT / "apps" / "browser-apply" / "tools"))
from mail_list import header, load_env  # noqa: E402

STUCK_STATUSES = ("NeedsVerification", "NeedsReview")

# Only rows from boards that were provably logged out are reopened by default.
# A click on a logged-out board cannot submit anything - it lands on a signup
# form - so those rows are non-submissions by construction, not by inference.
# Board-apply clicks elsewhere (US ATS, YC, a company's own form) are left alone:
# absence of an email receipt is weaker evidence there than absence of a session.
DEFAULT_SOURCES = ("wellfound", "instahyre", "hirist", "linkedin", "glassdoor", "indeed")

# A receipt says the application was accepted by the board. Anything vaguer is
# not evidence of a submission.
#
# "Application Successful" is Hirist's wording ("Application Successful: <Company>
# - <Title>") and it matched none of the phrasings below, so every Hirist receipt
# was invisible to this script while the rows they proved sat at NeedsVerification.
RECEIPT_RE = re.compile(
    r"successfully submitted|application submitted|application (?:has been |was )?received"
    r"|application successful|application sent successfully"
    r"|thanks for applying|thank you for applying|we(?:'ve| have) received your application"
    r"|your application to|applied successfully|application sent",
    re.I,
)

COMPANY_NOISE = re.compile(
    r"\b(?:pvt|private|ltd|limited|inc|llc|corp|corporation|technologies|technology|tech|"
    r"labs|systems|solutions|software|india|global|group|company|the)\b",
    re.I,
)


def normalise(text: str) -> str:
    text = re.sub(r"\(.*?\)", " ", text or "")
    text = COMPANY_NOISE.sub(" ", text)
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def mail_receipts(days: int) -> list[tuple[str, str]]:
    env = load_env()
    user = env.get("SMTP_EMAIL")
    password = env.get("SMTP_PASSWORD")
    if not user or not password:
        raise SystemExit("  .env has no SMTP_EMAIL / SMTP_PASSWORD - cannot read receipts")

    out: list[tuple[str, str]] = []
    with closing(imaplib.IMAP4_SSL("imap.gmail.com", 993,
                                   ssl_context=ssl.create_default_context())) as conn:
        conn.login(user, password)
        conn.select("INBOX", readonly=True)  # never mutate the mailbox
        # Ask Gmail for only the receipt-shaped subjects instead of pulling
        # headers for the whole inbox: 1500 round-trips dropped the TLS socket
        # mid-scan (imaplib.abort: EOF occurred in violation of protocol).
        ids: list[bytes] = []
        try:
            raw = ('subject:("successfully submitted" OR "application submitted" OR '
                   '"application received" OR "application successful" OR '
                   '"thanks for applying" OR "thank you for applying" OR '
                   '"received your application" OR "your application to" OR '
                   '"applied successfully" OR "application sent")')
            typ, data = conn.search(None, "X-GM-RAW", f'"{raw}"')
            ids = data[0].split() if data and data[0] else []
        except imaplib.IMAP4.error:
            # Not Gmail-backed: fall back to a ranged header scan.
            typ, data = conn.search(None, "ALL")
            ids = (data[0].split() if data and data[0] else [])[::-1][:600]

        for num in ids[::-1]:
            typ, chunk = conn.fetch(num, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
            if not chunk or not isinstance(chunk[0], tuple):
                continue
            msg = email.message_from_bytes(chunk[0][1])
            try:
                subject = str(make_header(decode_header(msg.get("Subject") or "")))
            except Exception:
                subject = str(msg.get("Subject") or "")
            sender = header(msg.get("From")).lower()
            if RECEIPT_RE.search(subject):
                out.append((sender, subject))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the resets")
    ap.add_argument("--days", type=int, default=120, help="mail window (default 120)")
    ap.add_argument("--sources", default=",".join(DEFAULT_SOURCES),
                    help="comma-separated source substrings to consider (default: the boards that were logged out)")
    args = ap.parse_args()
    wanted = tuple(s.strip().lower() for s in args.sources.split(",") if s.strip())

    print("  reading receipts from the inbox (read-only)")
    receipts = mail_receipts(args.days)
    print(f"  receipt mails found: {len(receipts)}")
    receipt_text = [normalise(s) for _, s in receipts]

    with closing(sqlite3.connect(DB)) as conn:
        rows = conn.execute(
            f"select id, status, source, company, title, link from jobs "
            f"where status in ({','.join('?' * len(STUCK_STATUSES))})",
            STUCK_STATUSES,
        ).fetchall()

    keep, reopen, unmatched = [], [], []
    skipped_source = []
    for job_id, status, source, company, title, link in rows:
        if wanted and not any(w in (source or "").lower() for w in wanted):
            skipped_source.append((job_id, status, source, company))
            continue
        key = normalise(company)
        if len(key) < 3:
            unmatched.append((job_id, status, source, company))
            continue
        hit = any(key in text for text in receipt_text)
        (keep if hit else reopen).append((job_id, status, source, company))

    print(f"\n  stuck rows          : {len(rows)}")
    print(f"  out of scope (source): {len(skipped_source)}   (left alone)")
    print(f"  evidenced by mail   : {len(keep)}   (promoted to Verified)")
    print(f"  no evidence         : {len(reopen)}   (retryable)")
    print(f"  company unreadable  : {len(unmatched)}   (left alone)")

    print("\n  reopening (no receipt names the company):")
    for job_id, status, source, company in reopen[:25]:
        print(f"    #{job_id:<5} {status:<17} {source[:26]:<26} {company[:34]}")
    if len(reopen) > 25:
        print(f"    ... and {len(reopen) - 25} more")

    print("\n  verifying (a receipt names the company):")
    for job_id, status, source, company in keep[:12]:
        print(f"    #{job_id:<5} {status:<17} {source[:26]:<26} {company[:34]}")
    if len(keep) > 12:
        print(f"    ... and {len(keep) - 12} more")

    if not args.apply:
        print("\n  report only - pass --apply to reset the unattempted rows and verify the receipted ones")
        return 0

    with closing(sqlite3.connect(DB)) as conn:
        ids = [r[0] for r in reopen]
        for chunk_start in range(0, len(ids), 200):
            chunk = ids[chunk_start:chunk_start + 200]
            conn.execute(
                f"update jobs set status='Evaluated' where id in ({','.join('?' * len(chunk))})",
                chunk,
            )
        conn.commit()
        # The mailbox decides in both directions. A row the board has already
        # confirmed must not sit at NeedsVerification forever: that state says
        # "we cannot tell", and the receipt is exactly the thing that tells us.
        verified = [r[0] for r in keep]
        for chunk_start in range(0, len(verified), 200):
            chunk = verified[chunk_start:chunk_start + 200]
            conn.execute(
                f"update jobs set status='Verified' where id in ({','.join('?' * len(chunk))})",
                chunk,
            )
        conn.commit()
        remaining = dict(conn.execute(
            "select status, count(*) from jobs where status in ('NeedsVerification','NeedsReview') group by 1"
        ).fetchall())
    print(f"\n  reset {len(ids)} row(s) -> Evaluated")
    print(f"  stuck now: {remaining}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
