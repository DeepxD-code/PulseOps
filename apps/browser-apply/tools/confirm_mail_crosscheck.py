"""Cross-check: for every job submitted to, did a confirmation email actually land?

Every submission so far has been confirmed from the board's own on-page
acknowledgement - Instahyre's "Application sent! on <date>", a Greenhouse
"Verified". That proves the board accepted it. It does NOT prove the applicant
received anything, and those are different claims.

This separates them, because a portal can accept an application and send no mail
at all. Instahyre, for instance, acknowledges nothing per application by email -
it sends profile-nudge mail instead - so "no email" is the expected result there
and must not be read as a failure. Conversely a board that mails an
acknowledgement and sends none for one job is worth knowing about.

For each confirmed submission it searches the inbox for the company name and
classifies what it finds. A miss is reported as "no mail (expected for this
board)" rather than silently counted as fine.

Read-only: IMAP FETCH with BODY.PEEK, no flags set, nothing deleted.
"""

from __future__ import annotations

import email
import imaplib
import re
import ssl
import sys
from collections import defaultdict
from email.header import decode_header, make_header
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mail_list import load_env  # noqa: E402

import sqlite3  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]

# Aliases: the board's sender rarely carries the company name.
#
# Deliberately strict. Two false positives came out of a looser version:
#   - "flipkart" matched a Flipkart PRODUCT REVIEW request
#     ("Rate 'PARKER BETA PREMIUM FOUNTAIN ...'"), not an application
#   - "greenhouse-mail" matched "Update from Anaplan: We've received your
#     application" - Anaplan merely uses Greenhouse, and the alias said nothing
#     about WHICH company the mail was about
# Both inflated "with mail" to 2 when the true answer was 0. An acknowledgement
# is a specific claim, so it is matched on the company and nothing else.
ALIASES = {
    "scaleai": ["scale ai", "scale.com"],
    "anthropic": ["anthropic"],
    "instahyre": ["instahyre"],
    "greyorange": ["greyorange"],
    "arintra": ["arintra"],
    "loco": ["loco"],
    "cognite": ["cognite"],
    "flipkart": ["flipkart", "rmp.flipkart"],
    "zenteiq": ["zenteiq"],
    "prismforce": ["prismforce"],
    "neander": ["neander"],
    "mynaksh": ["mynaksh"],
    "s16": ["s16"],
    "accenture": ["accenture"],
}

# An acknowledgement is a specific claim, so the SUBJECT has to be one. Matching
# the company alone produced three false positives in a row, each from substring
# coincidence rather than anything to do with an application:
#   - "Rate 'PARKER BETA PREMIUM FOUNTAIN'"      Flipkart asking for a review
#   - "Hi Deep, Your Cart is Missing You"         Flipkart abandoned-cart mail
#   - "Welcome to SimScale!"                      matched because "simscale.com"
#     CONTAINS the substring "scale.com"
# So: a word boundary on the company, AND a subject that is actually an
# acknowledgement. Anything else is reported as no mail, which is the truthful
# answer for the overwhelming majority of applications anyway.
APPLICATION_ACK = re.compile(
    r"thank you for applying|we(?:'ve| have) received your application|"
    r"application (?:has been |was )?(?:received|submitted)|"
    r"we received your application|your application is (?:in|under) review",
    re.I,
)


def mentions(blob: str, alias: str) -> bool:
    """Whole-token match, so 'simscale.com' does not count as 'scale.com'."""
    return re.search(r"(?<![a-z0-9])" + re.escape(alias), blob) is not None


def header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def board_of(link: str) -> str:
    l = (link or "").lower()
    if "instahyre" in l:
        return "instahyre"
    if "greenhouse" in l or "gh_jid" in l or "lever.co" in l:
        return "greenhouse/lever"
    return "other"


def main() -> int:
    only_today = "--today" in sys.argv

    conn = sqlite3.connect(ROOT / "pulseops.db")
    cur = conn.cursor()
    cur.execute(
        "SELECT j.id, j.company, j.title, j.link, o.recorded_at FROM jobs j"
        " JOIN outcomes o ON o.job_id = j.id WHERE o.stage = 'verified'"
        " ORDER BY o.recorded_at DESC"
    )
    rows = cur.fetchall()
    if only_today:
        rows = [r for r in rows if (r[4] or "").startswith("2026-10-08")]

    env = load_env()
    user, password = env.get("SMTP_EMAIL", ""), env.get("SMTP_PASSWORD", "")
    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    client.login(user, password)
    client.select("INBOX")
    _, data = client.search(None, "ALL")
    ids = data[0].split()

    # One pass over the inbox, bucketed by alias, instead of a search per job.
    #
    # Batched. Fetching each of ~5,000 messages in its own round trip took longer
    # than the command timeout, which is its own kind of failure: a diagnostic
    # that cannot finish is useless, and one that blocks for 30 minutes on an
    # unattended box is worse than useless. IMAP takes a comma-joined sequence
    # set, so this is ~11 requests instead of ~5,000.
    hits = defaultdict(list)
    CHUNK = 500
    for start in range(0, len(ids), CHUNK):
        batch = b",".join(ids[start : start + CHUNK])
        _, chunk = client.fetch(batch, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
        for part in chunk or []:
            if not isinstance(part, tuple) or not part[1]:
                continue
            msg = email.message_from_bytes(part[1])
            frm, subj = header(msg.get("From")), header(msg.get("Subject"))
            blob = (frm + " " + subj).lower()
            for key, aliases in ALIASES.items():
                if not APPLICATION_ACK.search(subj):
                    continue
                if any(mentions(blob, a) for a in aliases):
                    hits[key].append(subj)

    print(f"  submissions checked: {len(rows)}   (inbox scanned: {len(ids)})")
    matched = missing = 0
    for jid, company, title, link, ts in rows:
        key = re.sub(r"[^a-z0-9]", "", (company or "").lower())
        found = hits.get(key, [])
        board = board_of(link)
        if found:
            matched += 1
            print(f"  MAIL   #{jid:<5} {company[:18]:<20} {board:<16} {found[0][:56]}")
        else:
            missing += 1
            note = "expected - this board mails nothing per application" if board == "instahyre" else "NO MAIL - worth checking"
            print(f"  none   #{jid:<5} {company[:18]:<20} {board:<16} {note}")

    print(f"\n  with mail: {matched}   without mail: {missing}")
    client.logout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
