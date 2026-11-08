"""Release rows a dead browser run left claimed in 'Applying'.

A batch claims a row before it opens the page, and the claim is what stops two
workers from submitting the same application. But 'Applying' is a protected
state: the batch query only reads status='evaluated', so a row whose run died
before recording an outcome is never looked at again by anything. Measured
2026-11-05, two rows were sitting there - #1129 since 2026-11-03, and #1277
claimed by the batch that immediately then reported it as "contended" and
skipped it.

The claim itself cannot decide whether the application went through: a run can
die after the submit click and before the result is written. The mailbox can,
and that is the same rule the rest of the pipeline uses - a receipt promotes the
row to Verified, no receipt means nothing was accepted and the row is retried.

Usage:
    python scripts/release_stale_claims.py                # report only
    python scripts/release_stale_claims.py --apply        # write the changes
    python scripts/release_stale_claims.py --minutes 15   # narrower window
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from reopen_unverified import mail_receipts, normalise  # noqa: E402

DB = ROOT / "pulseops.db"
CLAIM_PREFIX = "browser-apply-claim|"


def claim_age_minutes(marker: str) -> float | None:
    parts = str(marker or "").split("|")
    if len(parts) < 2:
        return None
    try:
        stamped = datetime.fromisoformat(parts[1].replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamped.tzinfo is None:
        stamped = stamped.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - stamped).total_seconds() / 60.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the changes")
    ap.add_argument("--minutes", type=int, default=30,
                    help="only rows claimed longer ago than this (default 30)")
    ap.add_argument("--days", type=int, default=120, help="mail window (default 120)")
    args = ap.parse_args()

    with closing(sqlite3.connect(DB)) as conn:
        rows = conn.execute(
            "select id, company, title, source, processed_at from jobs "
            "where lower(coalesce(status,''))='applying'"
        ).fetchall()

    if not rows:
        print("  no rows are claimed right now")
        return 0

    receipts = mail_receipts(args.days)
    receipt_text = [normalise(subject) for _, subject in receipts]
    print(f"  receipt mails found: {len(receipts)}")
    print(f"  claimed rows       : {len(rows)}\n")

    keep, release, fresh = [], [], []
    for job_id, company, title, source, marker in rows:
        age = claim_age_minutes(marker)
        if age is None or age < args.minutes:
            fresh.append((job_id, company, age, marker))
            continue
        key = normalise(company or "")
        proven = bool(key) and len(key) >= 3 and any(
            re.search(rf"\b{re.escape(key)}\b", text) for text in receipt_text
        )
        (keep if proven else release).append((job_id, company, title, source, age))

    for job_id, company, age, marker in fresh:
        mins = "unknown" if age is None else f"{age:.0f}m"
        print(f"  [held]    #{job_id:<5} {str(company)[:30]:<30} claimed {mins} ago - too recent to touch")

    print()
    for job_id, company, title, source, age in keep:
        print(f"  [verify]  #{job_id:<5} {str(company)[:30]:<30} a receipt names it -> Verified")

    for job_id, company, title, source, age in release:
        print(f"  [release] #{job_id:<5} {str(company)[:30]:<30} no receipt after {age:.0f}m -> Evaluated")

    if not args.apply:
        print("\n  report only - pass --apply to write these changes")
        return 0

    with closing(sqlite3.connect(DB)) as conn:
        for job_id, *_ in keep:
            conn.execute("update jobs set status='Verified' where id=?", (job_id,))
        for job_id, *_ in release:
            conn.execute(
                "update jobs set status='Evaluated', processed_at=? where id=?",
                (f"claim-released|{datetime.now(timezone.utc).isoformat()}", job_id),
            )
        conn.commit()

    print(f"\n  released {len(release)} row(s) -> Evaluated")
    print(f"  verified {len(keep)} row(s) -> Verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
