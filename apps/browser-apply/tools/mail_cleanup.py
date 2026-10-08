"""Delete newsletter and promo mail, and nothing else.

Destructive and irreversible, so it works from an explicit allowlist of bulk
senders rather than a denylist of things to spare. That asymmetry is the whole
design: a denylist has to enumerate everything worth keeping, and one omission
throws away the only mail that matters. An allowlist only has to name the senders
that are safe to remove, and anything unrecognised is left alone by default.

The inbox currently contains mail that must NOT be deleted, and a keyword filter
would have caught at least one of them:

    "WorkIndia Talent"  - "Avradeep, You are selected for this Job"
    "Thank you for applying to Scale AI"
    "Security code for your application to Scale AI"
    Google security alert
    GitHub CI failure notifications
    PulseOps' own run summaries

KEEP_PATTERNS is checked FIRST and wins over everything. So even a sender that
appears in the delete list cannot take a message out if the subject looks like a
selection, an interview, an offer, a security alert, or a one-time passcode.
Passcodes are called out because a subject like "Security code" is exactly the sort
of thing a loose "security"-shaped filter could catch.

Anything not matched by either list is reported as UNKNOWN and left in place.

Usage:
    python apps/browser-apply/tools/mail_cleanup.py --dry-run
    python apps/browser-apply/tools/mail_cleanup.py --apply
"""

from __future__ import annotations

import argparse
import email
import imaplib
import re
import ssl
import sys
from email.header import decode_header, make_header
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mail_list import load_env  # noqa: E402

# Checked before anything else. If a subject matches, the message is never
# deleted, whatever the sender looks like.
KEEP_PATTERNS = re.compile(
    r"selected for this job|"
    r"you(?:'ve| have) been selected|"
    r"interview|interviewing|shortlist|"
    r"\boffer\b|"
    r"thank you for applying|we(?:'ve| have) received your application|"
    r"your application (?:has been|was) (?:received|submitted)|"
    r"security (?:code|alert|verification)|"
    # A sign-in notification from a bulk sender is still a security notification.
    # update@logs.autter.dev is on the delete list because its routine "found the
    # root cause of ..." digests are noise, and that list would otherwise take
    # "New sign-in detected on your autter.dev account" with it. Caught on the dry
    # run, which is what the dry run is for.
    r"new sign-in detected|"
    r"suspicious (?:sign-in|login|activity)|"
    r"(?:one[- ]time|verification|login|otp) (?:code|password)|"
    r"run (?:failed|succeeded)|"
    r"pulseops:|"
    r"action required",
    re.I,
)

# Bulk senders whose mail carries no job signal. Matched against the From
# address, case-insensitively.
DELETE_SENDERS = [
    r"noreply@glassdoor\.com",
    r"donotreply@jobalert\.indeed\.com",
    r"donotreply@match\.indeed\.com",
    r"notice\.alibaba\.com",
    r"english-personalized-digest@quora\.com",
    r"nytdirect@nytimes\.com",
    r"no-reply@kaggle\.com",
    r"noreply@pokemon\.com",
    r"support@indiegala\.com",
    r"no-reply@rmp\.flipkart\.com",
    r"no_reply@email\.heygen\.com",
    r"hello@gamma\.app",
    r"em1\.cloudflare\.com",
    r"update@logs\.autter\.dev",
    r"info@hirist\.tech",
    r"info@jobfeed\.hirist\.com",
    r"team@hi\.wellfound\.com",
    r"noreply@instahyre\.com",
]

DELETE_SENDERS_RE = re.compile("|".join(DELETE_SENDERS), re.I)


def header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually delete (default is a dry run)")
    ap.add_argument("--dry-run", action="store_true", help="explicit no-op; the default already is one")
    ap.add_argument("--limit", type=int, default=400)
    args = ap.parse_args()

    env = load_env()
    # Same keys mail_list.py uses; IMAP_USER/IMAP_PASSWORD do not exist in .env.
    user, password = env.get("SMTP_EMAIL", ""), env.get("SMTP_PASSWORD", "")
    if not user or not password:
        print("no SMTP_EMAIL/SMTP_PASSWORD in .env", file=sys.stderr)
        return 1
    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    client.login(user, password)
    client.select("INBOX")

    status, data = client.search(None, "ALL")
    ids = data[0].split()[-args.limit:]
    deleted, kept_unknown, kept_important = [], [], []

    for num in ids:
        status, chunk = client.fetch(num, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
        if not chunk or not chunk[0]:
            continue
        msg = email.message_from_bytes(chunk[0][1])
        frm = header(msg.get("From"))
        subj = header(msg.get("Subject"))

        if KEEP_PATTERNS.search(subj):
            kept_important.append((num.decode(), frm, subj))
            continue
        if DELETE_SENDERS_RE.search(frm):
            deleted.append((num.decode(), frm, subj))
            continue
        kept_unknown.append((num.decode(), frm, subj))

    mode = "DELETE" if args.apply else "would delete"
    print(f"  inbox scanned : {len(ids)}")
    print(f"  {mode:<12} : {len(deleted)}")
    print(f"  kept (job/safety): {len(kept_important)}")
    print(f"  kept (unrecognised): {len(kept_unknown)}")

    if kept_important:
        print("\n  --- deliberately KEPT (job-related or security) ---")
        for _, frm, subj in kept_important[:25]:
            print(f"    {frm[:44]:<46} {subj[:70]}")

    print(f"\n  --- {mode} ---")
    for num, frm, subj in deleted[:80]:
        print(f"    {frm[:44]:<46} {subj[:70]}")

    if not args.apply:
        print("\n  dry run - nothing deleted. Re-run with --apply to delete these.")
        client.logout()
        return 0

    # Mark deleted then expunge, so a partial failure cannot silently half-apply.
    batch = [n for n, _, _ in deleted]
    for i in range(0, len(batch), 50):
        client.store(",".join(batch[i : i + 50]), "+FLAGS", "\\Deleted")
    client.expunge()
    print(f"\n  expunged {len(batch)} message(s)")
    client.logout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
