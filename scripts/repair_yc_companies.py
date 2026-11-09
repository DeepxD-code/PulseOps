"""Repair the rows the old YC anchor scrape stamped with a fake employer.

The scan used to read card anchors, which name only the role, and wrote the
literal "YC Startup" as the company on 48 rows - one employer that does not
exist, which defeats dedupe, outreach and every per-company judgement. The
scanner now reads the board's own payload; this fixes what it already stored.

The company and role come from each posting's own page (props.company.name and
props.job.title), never from the card text, which glued company, one-liner and
role into one string:

    'MasonMason is the fastest way ... Software Engineer - BackendFull-time ...'

Postings that are gone (HTTP 404) keep a company split off that card text and
are marked Expired: they can no longer be applied to, and an Expired row is not
picked up by a batch. The two rows that are not job postings at all (a search
URL and a company landing page) are deleted.

Usage:
    python scripts/repair_yc_companies.py            # report only
    python scripts/repair_yc_companies.py --apply    # write
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "pulseops.db"
DEFAULT_MAP = Path.home() / "AppData" / "Local" / "Temp" / "opencode" / "ycrepair.json"
FAKE = "YC Startup"
NOT_A_JOB = re.compile(r"/jobs/v2|/companies/")


def split_company(title: str) -> str:
    """Company from the glued card text: the last capital after a lower-case."""
    title = (title or "").strip()
    best = None
    for i in range(1, min(len(title), 40)):
        if title[i].isupper() and (title[i - 1].islower() or title[i - 1].isdigit()):
            best = i
    return title[:best].strip() if best else title[:24].strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the changes")
    ap.add_argument("--map", default=str(DEFAULT_MAP), help="job id -> company/title map")
    args = ap.parse_args()

    repair = json.loads(Path(args.map).read_text(encoding="utf-8"))
    fixed, dead, removed = [], [], []

    with closing(sqlite3.connect(DB)) as conn:
        rows = conn.execute(
            "select id, link, title, status from jobs where company = ?", (FAKE,)
        ).fetchall()
        print(f"  rows holding the fake employer: {len(rows)}")

        for job_id, link, title, status in rows:
            if NOT_A_JOB.search(link or ""):
                removed.append((job_id, link, title))
                continue
            entry = repair.get(str(job_id)) or {}
            if entry.get("company"):
                fixed.append((job_id, entry["company"], entry["title"], entry.get("location", "")))
            else:
                dead.append((job_id, split_company(title), entry.get("reason", "")))

        print()
        for job_id, company, title, location in fixed:
            print(f"  [repair] #{job_id:<5} -> {company[:28]:<28} {title[:46]:<46} {location[:24]}")
        for job_id, company, reason in dead:
            print(f"  [expire] #{job_id:<5} -> {company[:28]:<28} {reason}")
        for job_id, link, title in removed:
            print(f"  [delete] #{job_id:<5} not a job posting: {str(link)[:52]}")

        if not args.apply:
            print("\n  report only - pass --apply to write these changes")
            return 0

        stamp = f"yc-company-repair|{datetime.now(timezone.utc).isoformat()}"
        for job_id, company, title, location in fixed:
            conn.execute(
                "update jobs set company=?, company_normalised=lower(?), title=?, location_raw=?, processed_at=? where id=?",
                (company, company, title, location, stamp, job_id),
            )
        for job_id, company, _reason in dead:
            conn.execute(
                "update jobs set company=?, company_normalised=lower(?), status='Expired', processed_at=? where id=?",
                (company, company, stamp, job_id),
            )
        for job_id, _link, _title in removed:
            conn.execute("delete from jobs where id=?", (job_id,))
        conn.commit()

    print(f"\n  repaired {len(fixed)}, expired {len(dead)}, deleted {len(removed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
