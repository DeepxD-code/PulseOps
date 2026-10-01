"""Send one plain-text email using the SMTP credentials already in .env.

This exists because sending is irreversible and every prior mail tool in this repo
was either an IMAP reader or a bulk sender for job applications. It deliberately
takes the body from a file rather than argv, so shell quoting cannot silently mangle
a paragraph before it leaves the machine.

Refuses to send with no recipient, and prints the resolved headers before handing
off to the SMTP server.

Run: python send_mail.py --to a@b.com --subject "..." --body-file path.txt
"""
from __future__ import annotations

import argparse
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for name in (ROOT / ".env", Path(".env")):
        if name.is_file():
            for raw in name.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
            break
    return env


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body-file", required=True)
    ap.add_argument("--cc", default="")
    ap.add_argument("--dry-run", action="store_true", help="build and print, do not send")
    args = ap.parse_args()

    body_path = Path(args.body_file)
    if not body_path.is_file():
        print(f"body file not found: {body_path}", file=sys.stderr)
        return 1
    body = body_path.read_text(encoding="utf-8")

    env = load_env()
    sender = env.get("SMTP_EMAIL", "")
    password = env.get("SMTP_PASSWORD", "")
    if not sender or not password:
        print("SMTP_EMAIL / SMTP_PASSWORD missing from .env", file=sys.stderr)
        return 1

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = args.to
    msg["Subject"] = args.subject
    if args.cc:
        msg["Cc"] = args.cc
    msg.set_content(body)

    print(f"From    : {sender}")
    print(f"To      : {args.to}" + (f"\nCc      : {args.cc}" if args.cc else ""))
    print(f"Subject : {args.subject}")
    print(f"Body    : {body_path} ({len(body)} chars, {len(body.splitlines())} lines)")

    if args.dry_run:
        print("\n--dry-run, nothing sent--\n")
        print(body)
        return 0

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=45) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(sender, password)
            refused = s.send_message(msg)
    except smtplib.SMTPException as e:
        print(f"\nSMTP refused: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"\nSend failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    if refused:
        print(f"\nRefused recipients: {refused}", file=sys.stderr)
        return 3

    print(f"\nSent to {args.to}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
