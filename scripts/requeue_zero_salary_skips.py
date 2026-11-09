"""Requeue the jobs the zero-salary bug wrongly skipped.

Before 2026-11-09, statedSalaryTooLow() treated "Rs 0/month" - a pay field the
board never filled in - as "pays nothing" and skipped the job. Nine rows were
lost that way across eight runs. The rule now reads a zero as undisclosed, so
these are safe to put back in the queue.

Only rows still in Skipped are touched; anything a later run already decided is
left alone.
"""
import sqlite3
import sys

DB = r"E:\Potential-gold\PulseOps\pulseops.db"
IDS = [1297, 1305, 1311, 1301, 1291, 1276, 1274, 984, 1019]

apply = "--apply" in sys.argv
conn = sqlite3.connect(DB)
rows = conn.execute(
    f"SELECT id, company, status FROM jobs WHERE id IN ({','.join('?' * len(IDS))})",
    IDS,
).fetchall()
print(f"{len(rows)} of {len(IDS)} rows present")
todo = [r for r in rows if r[2] == "Skipped"]
for jid, company, status in rows:
    print(f"  {jid:<5} {status:<10} {company}")
if not apply:
    print(f"\nwould reset {len(todo)} row(s); re-run with --apply")
    raise SystemExit(0)
cur = conn.execute(
    f"UPDATE jobs SET status='Evaluated' WHERE status='Skipped' AND id IN ({','.join('?' * len(IDS))})",
    IDS,
)
conn.commit()
print(f"\n{cur.rowcount} row(s) -> Evaluated")
