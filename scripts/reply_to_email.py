"""Reply to an email, from the candidate's own mailbox.

Some applications are answered by mail, and the answer is the whole
application: "reply with the word INTERESTED", or a short form the recruiter
asks for. Those replies were unreadable by the pipeline because nothing read
the inbox - and unwritable because nothing sent from it either.

This sends one reply, through the same transport as every other mail
(pulseops_outreach.email_sender), so the same guardrails apply: AUTO_SEND_EMAILS,
the pause switch, the recipient-domain boundary, and the gap between sends.

Nothing is invented here. The body is either given on the command line or read
from a file, and the script does not add a signature, a CV or a claim of any
kind - a reply that needs a fact the operator has not given is left for them.

Usage:
    python scripts/reply_to_email.py --to hr@example.com \
        --subject "Re: Action Required: Reply INTERESTED" --body "INTERESTED"
    python scripts/reply_to_email.py --to hr@example.com --subject "..." \
        --body-file C:/path/body.txt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for package in ("pulse-store", "pulse-outreach", "pulse-config", "pulse-core"):
    path = ROOT / "packages" / package / "src"
    if path.exists() and str(path) not in sys.path:
        sys.path.insert(0, str(path))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:  # noqa: BLE001 - the ambient environment may already have it
    pass

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to", required=True, help="recipient")
    parser.add_argument("--subject", required=True, help="subject line, including Re: if it is a reply")
    parser.add_argument("--body", default="", help="the body text")
    parser.add_argument("--body-file", default="", help="read the body from a file instead")
    parser.add_argument("--attach", default="", help="optional file to attach")
    parser.add_argument("--dry-run", action="store_true", help="print the mail and send nothing")
    args = parser.parse_args()

    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    body = body.strip()
    if not body:
        print("[reply] no body given; nothing sent")
        return 1

    from pulseops_outreach.email_sender import is_untrusted_domain, send_smtp

    domain = args.to.rsplit("@", 1)[-1]
    if is_untrusted_domain(domain):
        print(f"[reply] {domain} is a job board or an ATS, not a person; not sending")
        return 1

    email_text = f"Subject: {args.subject}\n\n{body}\n"
    if args.dry_run:
        print(f"[reply] TO: {args.to}\n[email]\n{email_text}")
        return 0

    try:
        sent = send_smtp(
            to_email=args.to,
            email_text=email_text,
            attachment_path=args.attach,
            min_gap_minutes=8,
        )
    except Exception as exc:  # noqa: BLE001 - the transport's own errors
        print(f"[reply] send failed: {exc}")
        return 1
    if not sent:
        print("[reply] the transport declined the send (paused, not authorised, or the domain refused it)")
        return 1
    print(f"[reply] sent to {args.to}: {args.subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
