"""Fetch the newest verification code from the candidate's inbox over IMAP.

Job portals send a one-time code to the email on the profile. Reading it here
lets the browser step type the code instead of dead-ending the row and waiting
for a human at the keyboard.

The code is only ever taken from mail that arrived after the caller said to look,
and only from a message that actually looks like a verification: the sender or
subject has to match a verification keyword, and the code has to look like one.

Run: python -m pulseops_core.otp_fetch --within-minutes 10
Prints the code on stdout and exits 0, or prints nothing and exits 1.
"""
from __future__ import annotations

import argparse
import email
import imaplib
import re
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

# Words that mark a message as a one-time-code notification rather than ordinary
# mail. Kept deliberately broad across vendors and narrow about intent.
VERIFICATION_HINTS = re.compile(
    r"verification code|security code|one[- ]time|otp|confirm your|"
    r"verify (?:your|this)|access code|login code|passcode|"
    r"your code is|code to (?:sign|log|complete)",
    re.I,
)
# Codes are 4-8 digits. Boundaries keep us from lifting years or order numbers.
CODE_RE = re.compile(r"(?<!\d)(\d{4,8})(?!\d)")


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for name in (ROOT / ".env", Path(".env")):
        if not name.is_file():
            continue
        for raw in name.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
        break
    return env


def _ok(status: object) -> bool:
    """imaplib status is bytes on some builds and str on others."""
    if isinstance(status, bytes):
        status = status.decode(errors="replace")
    return str(status).upper() == "OK"


def _text_of(msg: email.message.Message) -> str:
    parts: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "text":
                payload = part.get_payload(decode=True)
                if payload:
                    parts.append(payload.decode(part.get_content_charset() or "utf-8", "replace"))
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            parts.append(payload.decode(msg.get_content_charset() or "utf-8", "replace"))
    return "\n".join(parts)


def _subject_of(msg: email.message.Message) -> str:
    try:
        return str(make_header(decode_header(msg.get("Subject", ""))))
    except Exception:  # noqa: BLE001
        return str(msg.get("Subject", ""))


def fetch_code(within_minutes: int = 10) -> str | None:
    env = _load_env()
    user = env.get("SMTP_EMAIL", "")
    password = env.get("SMTP_PASSWORD", "")
    if not user or not password:
        return None

    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    try:
        client.login(user, password)
        client.select("INBOX", readonly=True)
        since = datetime.now(timezone.utc) - timedelta(minutes=within_minutes)
        # Gmail's SINCE takes a date, so widen to today and filter by exact
        # timestamp below. Anything older is rejected there.
        status, data = client.search(None, "SINCE", since.strftime("%d-%b-%Y"))
        if not _ok(status) or not data or not data[0]:
            return None
        # Newest first, so the most recent code wins.
        for num in reversed(data[0].split()[-25:]):
            status, payload = client.fetch(num, "(RFC822)")
            if not _ok(status) or not payload or not payload[0]:
                continue
            msg = email.message_from_bytes(payload[0][1])
            try:
                sent = parsedate_to_datetime(msg.get("Date", ""))
                if sent.tzinfo is None:
                    sent = sent.replace(tzinfo=timezone.utc)
            except Exception:  # noqa: BLE001
                continue
            if sent < since:
                continue
            subject = _subject_of(msg)
            sender = str(msg.get("From", ""))
            body = _text_of(msg)
            if not (VERIFICATION_HINTS.search(subject) or VERIFICATION_HINTS.search(sender)
                    or VERIFICATION_HINTS.search(body[:2000])):
                continue
            match = CODE_RE.search(body)
            if match:
                return match.group(1)
        return None
    finally:
        try:
            client.logout()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--within-minutes", type=int, default=10)
    args = parser.parse_args()
    code = fetch_code(args.within_minutes)
    if not code:
        return 1
    print(code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
