"""Fold jobs.status onto its canonical spelling.

jobs.status has no constraint, so two writers spelled the same state two ways:
apply.mjs and the pipeline write "Verified"/"Evaluated", while
record_instahyre_submit.py wrote "verified" for every Instahyre one-click
application - 159 rows. Reading code mostly lowercases before comparing, so the
damage was invisible in the batch, but a case-sensitive reader saw nothing:

    db_manager.get_jobs_by_status(["Verified"])      -> 58 of 217
    next_targets.py   WHERE status='Evaluated'       -> missed 3 rows
    send_engine.py    if current_status != "Evaluated" -> skipped 3 rows

Both ends are fixed: that tool now writes "Verified", and get_jobs_by_status
compares case-insensitively. This script folds what is already stored, so the
data itself stops disagreeing with every future reader.

outcomes.stage is deliberately untouched. That table's vocabulary is lower-case
("verified", "sent") and this is only about jobs.status.

Usage:
    python scripts/normalize_status.py            # report only
    python scripts/normalize_status.py --apply    # write
"""
from __future__ import annotations

import argparse
import sqlite3
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "pulseops.db"

# The spellings the code writes: apply.mjs, the pipeline, the outreach engine and
# the browser result mapper all use these. A status outside this list is only
# folded when it matches one of them ignoring case - an unknown status is
# reported, never guessed at, because inventing a canonical form for a state
# nobody writes would create a second problem instead of removing the first.
CANONICAL = {
    "Evaluated", "Verified", "Skipped", "Expired", "Applied", "Applying",
    "NeedsReview", "NeedsVerification", "FollowupSent", "Bounced",
    "EmailQueued", "SendPaused", "Sent",
}
_BY_LOWER = {s.lower(): s for s in CANONICAL}


def canonical_for(status: str) -> str | None:
    """The canonical spelling of ``status``, or None when it is unknown."""
    if status in CANONICAL:
        return None
    return _BY_LOWER.get((status or "").strip().lower())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the changes")
    args = ap.parse_args()

    with closing(sqlite3.connect(DB)) as conn:
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT status, COUNT(*) FROM jobs GROUP BY status ORDER BY 2 DESC"
        ).fetchall()

        # A status is canonical when it is exactly the spelling every writer
        # uses; anything else is either the same state wearing a different case
        # (fold it) or a state nothing writes (report it).
        drift = []
        unknown = []
        for status, count in rows:
            if not status or status in CANONICAL:
                continue
            target = canonical_for(status)
            if target:
                drift.append((status, target, count))
            else:
                unknown.append((status, count))

        for status, target, count in drift:
            print(f"  [fold] {status!r:<18} {count:>5} -> {target!r}")
        for status, count in unknown:
            print(f"  [skip] {status!r:<18} {count:>5} - not a status this repo writes")
        if not drift:
            print("  nothing to fold")
            return 0

        if not args.apply:
            print("\n  report only - pass --apply to write these changes")
            return 0

        total = 0
        for status, target, _ in drift:
            total += cur.execute(
                "UPDATE jobs SET status = ? WHERE status = ?",
                (target, status),
            ).rowcount
        conn.commit()
        print(f"\n  folded {total} row(s)")
        for status, count in cur.execute(
            "SELECT status, COUNT(*) FROM jobs GROUP BY status ORDER BY 2 DESC"
        ):
            print(f"    {status:<20} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
