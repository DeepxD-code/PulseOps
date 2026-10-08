"""Stop the PulseOps run-summary mail and clear the ones already sent.

The operator asked to stop receiving "PulseOps: N application(s) attempted" after
every browser-apply stage. Two reasons it was worth turning off rather than
tuning:

  - It arrives in the same inbox he needs to read for employer replies. A
    rejection or an interview invite is the signal; a run summary is noise.
  - Every 15 minutes, a summary buries exactly that signal. Volume is what makes
    an inbox unread, not any single message.

run-automation.ps1 called notify_run.py unconditionally. Now gated behind
PULSEOPS_NOTIFY=1, which has to be set deliberately - so it cannot come back by
accident after a merge or a re-run. The script itself is untouched and still
runnable by hand:

    python apps/browser-apply/tools/notify_run.py

Existing summaries are deleted from INBOX. Only messages whose SUBJECT begins
"PulseOps:" are touched, matched on the subject rather than the sender, because
the sender is the candidate's own address and deleting on that would be
indiscriminate.

Both halves are written as a file rather than a PowerShell here-string: inline
heredocs through PowerShell have mangled quotes and backslashes repeatedly
today, including this one.
"""

from __future__ import annotations

import email
import imaplib
import re
import ssl
import sys
from email.header import decode_header, make_header
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "browser-apply" / "tools"))
from mail_list import load_env  # noqa: E402


def patch_pipeline() -> None:
    p = ROOT / "scripts" / "run-automation.ps1"
    text = p.read_text(encoding="utf-8")
    if "PULSEOPS_NOTIFY" in text:
        print("  run-automation.ps1: already gated")
        return
    old = (
        '    Write-Output "=== Notifying candidate of this run ==="\n'
        "    & python -u apps/browser-apply/tools/notify_run.py\n"
        '    Write-Output "notify_exit=$LASTEXITCODE"'
    )
    new = (
        "    # 2026-10-08: opt-in. The operator asked to stop receiving these. A\n"
        '    # "PulseOps: N application(s) attempted" mail after every browser-apply\n'
        "    # stage lands in the same inbox he needs to read for employer replies,\n"
        "    # and every 15 minutes of summaries is what buries a real rejection.\n"
        "    #\n"
        "    # Off unless PULSEOPS_NOTIFY=1 is set, so it cannot return by accident.\n"
        "    # By hand: python apps/browser-apply/tools/notify_run.py\n"
        '    if ($env:PULSEOPS_NOTIFY -eq \'1\') {\n'
        '        Write-Output "=== Notifying candidate of this run ==="\n'
        "        & python -u apps/browser-apply/tools/notify_run.py\n"
        '        Write-Output "notify_exit=$LASTEXITCODE"\n'
        "    } else {\n"
        '        Write-Output "=== Run summary mail suppressed (PULSEOPS_NOTIFY=1 enables) ==="\n'
        "    }"
    )
    if old not in text:
        print("  run-automation.ps1: ANCHOR NOT FOUND - not patched, check by hand")
        return
    p.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")
    print("  run-automation.ps1: run-summary mail gated behind PULSEOPS_NOTIFY=1")


def clear_sent() -> None:
    env = load_env()
    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    client.login(env["SMTP_EMAIL"], env["SMTP_PASSWORD"])
    client.select("INBOX")
    # Ask the server to find them. The first version fetched all ~5,000 inbox
    # messages one at a time to look for a subject prefix, and blew the timeout
    # - the same mistake confirm_mail_crosscheck.py already had fixed. IMAP can
    # do this in one SEARCH.
    _, data = client.search(None, 'SUBJECT', '"PulseOps:"')
    ids = data[0].split() if data and data[0] else []
    doomed = []
    for num in ids:
        _, chunk = client.fetch(num, "(BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
        if not chunk or not isinstance(chunk[0], tuple):
            continue
        msg = email.message_from_bytes(chunk[0][1])
        try:
            subj = str(make_header(decode_header(msg.get("Subject") or "")))
        except Exception:
            subj = msg.get("Subject") or ""
        if re.match(r"^\s*pulseops:", subj, re.I):
            doomed.append(num)
    if doomed:
        for i in range(0, len(doomed), 50):
            client.store(b",".join(doomed[i : i + 50]), "+FLAGS", "\\Deleted")
        client.expunge()
    print(f"  deleted {len(doomed)} PulseOps summary mail(s) from INBOX")
    client.logout()


if __name__ == "__main__":
    patch_pipeline()
    clear_sent()
