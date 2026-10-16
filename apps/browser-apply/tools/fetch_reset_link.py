"""Pull a password-reset link out of the mailbox for a given board.

Written as a file rather than a PowerShell here-string because the escaped quotes
inside an IMAP FETCH argument get mangled on the way through, producing
"FETCH command error: BAD [b'Could not parse command']". That is the fourth time
today a here-string has quietly corrupted Python source; this is the shape that
does not.

Usage:
    python apps/browser-apply/tools/fetch_reset_link.py wellfound
    python apps/browser-apply/tools/fetch_reset_link.py instahyre naukri

Prints, on stdout:
    LINK|<url>
    MAIL|<from>|<subject>     (for each candidate message, as it is inspected)

Exit 0 with a link, 1 with none. Read-only: BODY.PEEK, no flags, nothing deleted.
"""

from __future__ import annotations

import email
import imaplib
import re
import ssl
import sys
import time
from email.header import decode_header, make_header
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mail_list import load_env  # noqa: E402

WAIT_SECONDS = 150


def hdr(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def bodies(msg) -> list[str]:
    out = []
    for sub in msg.walk() if msg.is_multipart() else [msg]:
        if sub.get_content_type() not in ("text/plain", "text/html"):
            continue
        try:
            out.append(sub.get_payload(decode=True).decode("utf-8", "replace"))
        except Exception:
            continue
    return out


def main(needles: list[str]) -> int:
    env = load_env()
    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    client.login(env["SMTP_EMAIL"], env["SMTP_PASSWORD"])
    client.select("INBOX")

    pattern = re.compile(
        r"https?://[^\s\"'<>]*[^\s\"'<>]*"
        r"(?:password|reset|token|confirm|verify|activate|set[_-]?password)"
        r"[^\s\"'<>]*",
        re.I,
    )
    deadline = time.time() + WAIT_SECONDS
    seen: set[bytes] = set()
    print(f"  watching for: {', '.join(needles)}  ({WAIT_SECONDS}s)", flush=True)

    while time.time() < deadline:
        _, data = client.search(None, "ALL")
        ids = data[0].split() if data and data[0] else []
        for num in reversed(ids[-70:]):
            if num in seen:
                continue
            seen.add(num)
            # A simpler fetch form, and each one guarded. The parenthesised
            # HEADER.FIELDS form intermittently answers "FETCH command error: BAD
            # [b'Could not parse command']" on this server for some sequence
            # numbers, and one unreadable message was aborting the whole scan
            # before it ever looked at the mail we wanted.
            try:
                status, chunk = client.fetch(num, "(BODY.PEEK[HEADER])")
            except imaplib.IMAP4.error:
                continue
            if not chunk or not isinstance(chunk[0], tuple):
                continue
            head = email.message_from_bytes(chunk[0][1])
            frm, subj = hdr(head.get("From")), hdr(head.get("Subject"))
            blob = (frm + " " + subj).lower()
            if not any(n in blob for n in needles):
                continue
            print(f"  MAIL|{frm}|{subj}", flush=True)
            try:
                _, full = client.fetch(num, "(BODY.PEEK[])")
            except imaplib.IMAP4.error:
                continue
            for part in full or []:
                if not isinstance(part, tuple):
                    continue
                msg = email.message_from_bytes(part[1])
                for body in bodies(msg):
                    m = pattern.search(body)
                    if m:
                        link = m.group(0).rstrip(".,)>\"'")
                        print(f"LINK|{link}")
                        client.logout()
                        return 0
        time.sleep(6)

    print("LINK|")
    client.logout()
    return 1


if __name__ == "__main__":
    args = [a.lower() for a in sys.argv[1:]] or ["instahyre"]
    sys.exit(main(args))
