"""Retire queued rows that the location filter would reject today.

The location filter learned late that a stated foreign place is a rejection
rather than missing data (see packages/pulse-eval/location_filter.py). Rows
sourced before that rule are still sitting in the queue as ``Evaluated``, and
every one of them costs a browser visit that can only end in the board refusing
the candidate's location - "not accepting applications from your current
location" with Submit disabled.

Measured 2026-11-11: 61 of 540 Evaluated rows name a foreign location and no
India signal, roughly a fifth of a full day's batch slots ahead of rows that can
actually be submitted.

The parked backlog is the same problem: 2026-11-16 measured 21 rows in
NeedsReview whose location names a foreign city and no India signal, each one
waiting for a browser visit that can only end in a refusal. They are retired
here with the same rule.

A row that already carries a submission outcome is never touched. "Needs
verification" means an application may have gone out and nobody has read the
reply yet; that is the mailbox's question to answer, not the filter's, and
skipping it would bury a real application under a retirement reason.

This re-applies the filter that already exists rather than carrying a second copy
of the place lists in the applier. Dry-run by default.

    python scripts/skip_foreign_location_rows.py            # report only
    python scripts/skip_foreign_location_rows.py --apply    # write Skipped
    python scripts/skip_foreign_location_rows.py --status NeedsReview --apply
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for package in ("pulse-store", "pulse-eval", "pulse-config"):
    sys.path.insert(0, str(ROOT / "packages" / package / "src"))

import yaml  # noqa: E402

from pulseops_eval.location_filter import _resolve_location  # noqa: E402
from pulseops_store import db_manager as db  # noqa: E402

# Outcomes that mean an application may already have gone out to the employer.
# The mailbox confirms it; the location filter does not.
SUBMISSION_STAGES = {"submitted", "verified", "unverified", "needs-verification", "applied", "sent"}


def preferred_cities() -> list[str]:
    config_path = ROOT / "config" / "profile.yml"
    try:
        profile = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return []
    cities = profile.get("preferred_cities") or profile.get("candidate", {}).get("preferred_cities") or []
    return [str(c) for c in cities]


def submission_stages(job_id: int) -> list[str]:
    """The outcome stages recorded against one row."""
    path = db.DB_PATH
    if not path.is_file():
        return []
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute("SELECT stage FROM outcomes WHERE job_id=?", (job_id,)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    return [str(row[0] or "") for row in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the Skipped status (default: report only)")
    parser.add_argument("--status", action="append", default=None,
                        help="which statuses to sweep (default: Evaluated). Repeatable.")
    args = parser.parse_args()

    statuses = args.status or ["Evaluated"]
    cities = preferred_cities()
    rows = []
    for status in statuses:
        rows.extend(db.get_jobs_by_status([status], limit=2000))
    rejected = []
    held = []
    for row in rows:
        resolved = _resolve_location(
            {"location_raw": row.get("location_raw") or "", "description": row.get("job_description") or ""},
            cities,
        )
        if resolved != "foreign":
            continue
        stages = submission_stages(int(row["id"]))
        if any(stage.lower() in SUBMISSION_STAGES for stage in stages):
            held.append((row, stages))
            continue
        rejected.append(row)

    print(f"Rows in {statuses}: {len(rows)}   foreign-located: {len(rejected) + len(held)}"
          f"   (held: {len(held)} already carry a submission outcome)")
    for row in rejected[:20]:
        print(f"  #{row['id']:<5} {(row.get('location_raw') or '')[:44]:46} "
              f"{(row.get('company') or '')[:20]:22} {(row.get('title') or '')[:38]}")
    if len(rejected) > 20:
        print(f"  ... and {len(rejected) - 20} more")
    for row, stages in held[:10]:
        print(f"  [held] #{row['id']:<5} {(row.get('company') or '')[:20]:22} "
              f"{(row.get('title') or '')[:34]:36} {stages[-2:]}")

    if not args.apply:
        print("\nReport only. Re-run with --apply to mark these Skipped.")
        return 0

    for row in rejected:
        # record_outcome also writes jobs.status (it stores the stage there), so
        # the mapped status has to be written after it. The applier follows the
        # same convention: outcomes.stage carries the action, jobs.status the
        # status it maps to.
        db.record_outcome(
            int(row["id"]),
            row.get("company") or "",
            row.get("title") or "",
            "location-ineligible",
            "location filter: the posting names a foreign location and no India signal",
        )
        db.update_job_status(int(row["id"]), "Skipped")
    print(f"\nMarked {len(rejected)} rows Skipped (location-ineligible).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
