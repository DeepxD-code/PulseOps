"""Re-apply the apply gate to the pending email queue.

The queue is a snapshot of decisions made when a row was scored. Every time the
gate gained a rule, rows queued before it kept their place: "Chief Technology
Officer" and an 8-year ".Net Developer" sat in a queue the current gate rejects,
and the daily cap (ten sends) is the scarce resource. Each of those is a send
that cannot go to a role the candidate can win.

The verdict comes from apps/browser-apply/tools/gate-check.mjs, i.e. the real
`isStrictTargetRole` the batch uses. The Python package's own
`is_strict_target_role` is deliberately narrow (it only skips the Stage 2 model
on titles naming a stack) and using it here rejected "Software Engineer".

Nothing is deleted and nothing is claimed, so a dry run is completely safe.

Usage:
    python scripts/requeue_gate.py            # report only
    python scripts/requeue_gate.py --apply    # move failures out of the queue
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "apps" / "browser-apply" / "tools" / "gate-check.mjs"
INDIA_BOARD = ("naukri", "instahyre", "hirist", "wellfound", "cutshort", "foundit")

sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))
from pulseops_eval.title_clean import clean_title  # noqa: E402


def gate_verdicts(rows: list[dict]) -> dict[int, bool]:
    if not rows:
        return {}
    proc = subprocess.run(
        ["node", str(GATE)],
        input=json.dumps(rows),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(ROOT),
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"gate-check failed: {proc.stderr.strip()[:400]}")
    return {int(item["queue_id"]): bool(item["inScope"])
            for item in json.loads(proc.stdout or "[]")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes")
    parser.add_argument(
        "--retitle",
        action="store_true",
        help="re-clean stored titles with the current cleaner (they were written "
             "by whichever cleaner version the scan ran)",
    )
    parser.add_argument("--db", default=str(ROOT / "pulseops.db"))
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT q.id AS queue_id, q.score, j.id AS job_id, j.title, j.company, "
        "j.source, j.text_summary "
        "FROM send_queue q JOIN jobs j ON j.id=q.job_id "
        "WHERE q.status='pending' "
        "ORDER BY q.score DESC"
    ).fetchall()

    verdicts = gate_verdicts([
        {"queue_id": r["queue_id"], "title": r["title"] or "",
         "description": r["text_summary"] or ""}
        for r in rows
    ])

    rejected = [r for r in rows if not verdicts.get(int(r["queue_id"]), True)]
    india = sum(1 for r in rows if any(b in str(r["source"] or "").lower() for b in INDIA_BOARD))
    print(f"pending: {len(rows)}  (India-board {india}, other {len(rows) - india})")
    print(f"rejected by the apply gate: {len(rejected)}")
    for row in rejected:
        print(f"  {row['score']:>3} {str(row['source'])[:24]:<24} {str(row['title'])[:64]}")

    retitles: list[tuple[sqlite3.Row, str]] = []
    if args.retitle:
        for row in rows:
            cleaned = clean_title(row["title"] or "")
            if cleaned and cleaned != (row["title"] or ""):
                retitles.append((row, cleaned))
        print(f"\ntitles to re-clean: {len(retitles)}")
        for row, cleaned in retitles[:15]:
            print(f"  {cleaned[:64]!r}\n    was {str(row['title'])[:64]!r}")

    if not args.apply:
        print("\nreport only - pass --apply to move these out of the queue")
        return 0

    for row, cleaned in retitles:
        conn.execute("UPDATE jobs SET title=? WHERE id=?", (cleaned, row["job_id"]))
    if retitles:
        conn.commit()
        print(f"re-cleaned {len(retitles)} title(s)")
    if not rejected:
        return 0

    for row in rejected:
        conn.execute(
            "UPDATE send_queue SET status='skipped', processed_at=datetime('now') "
            "WHERE id=? AND status='pending'",
            (row["queue_id"],),
        )
        # Only rows the pipeline itself queued for email move; a row already
        # Sent/verified keeps whatever the board told us. There is no notes
        # column on jobs - the queue row carries the reason.
        conn.execute(
            "UPDATE jobs SET status='Skipped' "
            "WHERE id=? AND status IN ('EmailQueued','Evaluated')",
            (row["job_id"],),
        )
    conn.commit()
    print(f"\nskipped {len(rejected)} queue row(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
