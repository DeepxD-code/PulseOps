"""Tell the candidate what the browser actually did, by email.

The browser-apply stage records outcomes in the database but sends nothing, so
an unattended run that submitted three applications and stalled on two more
looked identical to a run that did nothing at all. This writes one short
summary per run to the candidate's own inbox - the same mailbox already used
for OTP codes - so the state is observable without watching a browser.

Deliberately plain and factual:

  - it states what was recorded, not what it hopes happened
  - a NeedsVerification row is reported as needing attention, never as sent
  - it never claims an application was submitted unless the run recorded one
  - it never includes a recruiter's email address or any message body

One message per run, after the stage finishes. Failure to send is reported on
stdout and never changes the run's exit code: a mail problem must not look
like an application problem.
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "output" / "apply-results.json"
PENDING = ROOT / "output" / "pending-questions.json"

# Load the repository .env so the script works when invoked directly from
# run-automation.ps1, which sets its own env vars but does not export
# SMTP_EMAIL/SMTP_PASSWORD. Without this it always reported "not set" and sent
# nothing - the one thing this script exists to do.
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:  # noqa: BLE001 - fall back to the ambient environment
    pass

# The recorded outcome -> how it is described to the candidate. Anything not
# listed here is reported by its raw action rather than being guessed at.
LABELS = {
    "verified": "submitted and confirmed by the board",
    "applied": "submitted",
    "needs-verification": "filled in, waiting on you",
    "needs-review": "stopped - needs your attention",
    "spam-refused": "refused by the board as spam",
    "skipped": "skipped",
    "error": "stopped on an error",
}


def load_results() -> dict:
    if not RESULTS.exists():
        return {}
    try:
        return json.loads(RESULTS.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[notify] could not read {RESULTS.name}: {exc}", file=sys.stderr)
        return {}


def load_pending() -> list:
    if not PENDING.exists():
        return []
    try:
        return json.loads(PENDING.read_text(encoding="utf-8")).get("groups", [])
    except (OSError, ValueError):
        return []


def describe(action: str) -> str:
    return LABELS.get(action, action or "no recorded outcome")


def build_body(payload: dict, pending: list) -> str:
    results = payload.get("results") or []
    when = str(payload.get("ran_at") or "")[:19].replace("T", " ")
    lines = [f"Run {when}".rstrip(), ""]

    if not results:
        lines.append("No applications were attempted this run.")
    else:
        for item in results:
            company = str(item.get("company") or "?")
            title = str(item.get("title") or "?")
            lines.append(f"- {company} - {title}: {describe(str(item.get('action') or ''))}")
        counts: dict[str, int] = {}
        for item in results:
            key = describe(str(item.get("action") or ""))
            counts[key] = counts.get(key, 0) + 1
        lines.append("")
        lines.append("Totals: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())))

    if pending:
        lines.append("")
        lines.append("Questions still unanswered (set these in config/profile.yml once):")
        for group in pending[:8]:
            fields = ", ".join(group.get("fields") or [])
            lines.append(f"- {fields} ({group.get('blocked_count', 0)} job(s))")

    lines.append("")
    lines.append("Anything marked 'waiting on you' or 'needs your attention' was not submitted.")
    return "\n".join(lines) + "\n"


def send(subject: str, body: str) -> bool:
    user = os.environ.get("SMTP_EMAIL", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    if not user or not password:
        print("[notify] SMTP_EMAIL/SMTP_PASSWORD not set; cannot send the run summary")
        return False
    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = user
    msg["Subject"] = subject
    msg.set_content(body)
    # Retry. A run summary is the only signal the operator gets about what the
    # browser did, so one DNS hiccup must not silently swallow it - observed
    # 2026-10-01 as
    #   [notify] could not send the run summary: gaierror: [Errno 11001]
    #   getaddrinfo failed
    # which left a completed run looking unreported. Retry the transient
    # transport failures with a short backoff; give up on an auth failure,
    # which retrying cannot fix.
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            # Port 587 with STARTTLS, not 465 implicit SSL. Verified against this
            # account on 2026-10-01: smtp.gmail.com:465 accepts the TCP connection
            # and the EHLO, then drops the socket during AUTH with
            # "SMTPServerDisconnected: Connection unexpectedly closed", while 587 +
            # STARTTLS authenticates cleanly with the same app password.
            with smtplib.SMTP("smtp.gmail.com", 587, timeout=45) as smtp:
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(user, password)
                smtp.send_message(msg)
            print("[notify] run summary sent to the candidate inbox")
            return True
        except smtplib.SMTPAuthenticationError as exc:
            last_error = exc
            print(f"[notify] authentication rejected; not retrying: {exc}", file=sys.stderr)
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            transient = isinstance(exc, (OSError, smtplib.SMTPException))
            if not transient or attempt == 3:
                break
            wait = attempt * 5
            print(f"[notify] attempt {attempt} failed ({type(exc).__name__}: {exc}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    # Never let a mail problem change the run's verdict, but always say it.
    print(f"[notify] could not send the run summary: {type(last_error).__name__}: {last_error}", file=sys.stderr)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Email the candidate a run summary")
    parser.add_argument("--dry-run", action="store_true", help="print the body, send nothing")
    parser.add_argument("--always", action="store_true",
                        help="send even when nothing was submitted")
    args = parser.parse_args()

    payload = load_results()
    if not payload:
        print("[notify] no apply-results.json; nothing to report")
        return 0
    results = payload.get("results") or []
    submitted = [r for r in results if str(r.get("action")) in ("verified", "applied")]
    attention = [r for r in results if str(r.get("action")) in ("needs-verification", "needs-review", "error")]
    if not results or (not submitted and not attention and not args.always):
        print(f"[notify] nothing worth an email ({len(results)} result(s)); use --always to force")
        return 0

    body = build_body(payload, load_pending())
    if args.dry_run:
        print(body)
        return 0
    send(f"PulseOps: {len(results)} application(s) attempted", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())