"""Record an Instahyre submission confirmed in the review browser.

The pipeline cannot write these rows itself. It authenticates against
.edge-profile, and the session that works lives in the review browser, whose
cookies cannot be exported (Django's sessionid is HttpOnly and the browser
tooling exposes no cookie accessor). So the submission happens in the review
browser and the result is written here, against the same schema apply.mjs uses.

What counts as confirmation. Only Instahyre's own post-submit state, read off the
job page after the click:

    "Application sent! on <date>"

That is a server-rendered acknowledgement naming a date, not an inference from a
click having been issued. The button text alone changing would not be enough -
it can change optimistically - so the dated phrase is required. Anything else is
recorded as unconfirmed rather than promoted to verified, because 21 earlier
attempts on these postings all ended in an unverified state and the difference
between "clicked" and "sent" is exactly what was lost.

Usage:
    python apps/browser-apply/tools/record_instahyre_submit.py --job-id 844 \
        --evidence "Application sent! on October 7, 2026"
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DB = ROOT / "pulseops.db"

# Instahyre's acknowledgement, e.g. "Application sent! on October 7, 2026".
CONFIRMED_RE = re.compile(r"application sent!\s*(?:on)?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})", re.I)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", type=int, required=True)
    ap.add_argument("--evidence", required=True, help="text read off the job page after clicking Apply")
    args = ap.parse_args()

    m = CONFIRMED_RE.search(args.evidence)
    if not m:
        print(f"  NOT CONFIRMED - no dated acknowledgement in: {args.evidence!r}")
        print("  Refusing to record a submission on the strength of a click alone.")
        return 1

    now = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("SELECT id, title, company, status FROM jobs WHERE id = ?", (args.job_id,))
    row = cur.fetchone()
    if not row:
        print(f"  job #{args.job_id} not found")
        return 1
    _, title, company, status = row

    cur.execute("UPDATE jobs SET status = 'verified', processed_at = ? WHERE id = ?", (now, args.job_id))

    # Replace any prior outcome for this job so the row count stays one-per-job
    # and a stale needs-verification cannot sit beside a verified.
    cur.execute("DELETE FROM outcomes WHERE job_id = ? AND stage = 'verified'", (args.job_id,))
    cur.execute(
        "INSERT INTO outcomes (job_id, company, title, stage, notes, recorded_at, prep_sent)"
        " VALUES (?, ?, ?, 'verified', ?, ?, 0)",
        (
            args.job_id,
            company,
            title,
            f"Instahyre one-click apply; page confirmed: {m.group(0)}",
            now,
        ),
    )
    conn.commit()

    cur.execute("SELECT stage, notes, recorded_at FROM outcomes WHERE job_id = ? ORDER BY rowid DESC LIMIT 1", (args.job_id,))
    stage, notes, recorded_at = cur.fetchone()
    print(f"  #{args.job_id} {company} - {title}")
    print(f"    previous status : {status}")
    print(f"    now             : verified")
    print(f"    evidence        : {m.group(0)}")
    print(f"    notes           : {notes}")
    print(f"    recorded_at     : {recorded_at}")

    cur.execute("SELECT COUNT(*) FROM outcomes WHERE stage = 'verified'")
    print(f"    verified total  : {cur.fetchone()[0]}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
