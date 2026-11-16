"""Re-match the recorded replies and repair the rows they were attached to.

The first version of the matcher filed a reply under any row whose company name
was a fragment of a word in the mail: "CRED" inside "credential", "Knowl"
inside "knowledge". Four rows were set to Replied that have nothing to do with
the mail, and the reply rows carry the wrong job_id.

This recomputes the attachment with the fixed matcher and puts the rows back
to the status their own outcomes say they had.
"""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(r"E:\Potential-gold\PulseOps")
for package in ("pulse-store", "pulse-eval", "pulse-config", "pulse-notify", "pulse-core"):
    path = ROOT / "packages" / package / "src"
    if path.exists() and str(path) not in sys.path:
        sys.path.insert(0, str(path))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:
    pass
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from pulseops_notify.application_replies import _job_for_reply, sender_address  # noqa: E402

DB = ROOT / "pulseops.db"

# The status a row had before a reply was attached to it: whatever its own
# outcomes say. A row whose last outcome was a confirmed submission was
# Verified; one whose last outcome was a submission without confirmation was
# NeedsVerification.
OUTCOME_TO_STATUS = {
    "verified": "Verified",
    "submitted": "Verified",
    "needs-verification": "NeedsVerification",
    "unverified": "NeedsVerification",
    "confirmed": "Verified",
    "applied": "Applied",
}


def main() -> int:
    conn = sqlite3.connect(str(DB), timeout=20)
    conn.row_factory = sqlite3.Row
    replies = list(conn.execute("SELECT id, job_id, sender_email, subject, snippet FROM recruiter_replies"))
    touched = []
    for reply in replies:
        sender = sender_address(reply["sender_email"])
        matched = _job_for_reply(sender, reply["subject"] or "", reply["snippet"] or "")
        old = reply["job_id"]
        if matched == old:
            continue
        conn.execute("UPDATE recruiter_replies SET job_id=? WHERE id=?", (matched, reply["id"]))
        touched.append((reply["id"], sender, old, matched))
        if old and old != matched:
            # Put the wrongly-attached row back to what its own outcomes say.
            row = conn.execute(
                "SELECT stage FROM outcomes WHERE job_id=? ORDER BY rowid DESC LIMIT 1", (old,)
            ).fetchone()
            status = OUTCOME_TO_STATUS.get(str(row["stage"]).lower() if row else "", "")
            if status:
                conn.execute("UPDATE jobs SET status=? WHERE id=?", (status, old))
                touched.append((old, "row restored", "Replied", status))
    conn.commit()
    for item in touched:
        print("  ", item)
    print(f"{len(touched)} change(s)")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
