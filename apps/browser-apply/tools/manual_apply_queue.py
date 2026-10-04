"""Open the postings a run could not submit, so the candidate can.

Some postings never reach the point of an automated submission, for reasons
that are not defects:

  - the board refused the submission itself (Ashby returns HTTP 200 and then
    declines it as spam)
  - a required question is candidate-only and must not be invented
  - a CAPTCHA needs a person

The forms are already filled right up to that point, so each one is about
fifteen seconds of clicking. Collecting them into one list and opening them in
the browser is the difference between applying and hunting for links.

Read-only by construction. It reads the database and opens URLs; it does not
drive a browser, so it cannot fill a field, accept a term or click Submit. A
CAPTCHA on any of these pages is left for the human.

Usage:
    python tools/manual_apply_queue.py --dry-run
    python tools/manual_apply_queue.py --limit 15
    python tools/manual_apply_queue.py --include-open      # Greenhouse too
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DB = ROOT / "pulseops.db"

# Why a row needs a person, keyed by the exact `action` a run persisted into
# outcomes.stage. These are the outcomes where a human can finish what the
# automation started - the form is filled, or the page is reachable, and the only
# thing missing is a person clicking Submit or solving a challenge.
#
# Deliberately absent: dead-link, invalid-listing, redirect-blocked,
# portal-disabled, simulation-blocked, salary-below-threshold, dry-run-preview,
# mock-preview. None of those can be completed by anyone, so listing them would
# pad the queue with links that are already closed.
HUMAN_ACTIONABLE = {
    "spam-refused": "board declined the submission",
    "captcha-blocked": "captcha needs solving",
    "manual-submit-required": "form filled, submit left to you",
    "authwall-skip": "needs you signed in",
    "needs-review": "stopped before submitting",
    "needs-verification": "submitted, not yet confirmed",
}

# Nothing actionable here: the posting is gone or was never applicable.
DEAD_END = {
    "dead-link", "invalid-listing", "redirect-blocked", "portal-disabled",
    "simulation-blocked", "salary-below-threshold", "dry-run-preview",
    "mock-preview", "profile-incomplete", "send-paused",
}


def query(limit: int, per_company_cap: int) -> tuple[list[dict], int]:
    if not DB.exists():
        print(f"[queue] no {DB.name}", file=sys.stderr)
        return []
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        # `outcomes.stage` is where the browser-apply reason is persisted. It
        # carries "spam-refused" for a board that declined, which is otherwise
        # indistinguishable from any other Skipped row - the jobs table has no
        # reason column and the table was empty until this was written.
        #
        # The filter has to be IN the SQL, not applied afterwards. Selecting the
        # top N by score and then discarding the rows that turn out to be dead
        # ends meant the fetch was spent on rows nobody could act on: the queue
        # reported "nothing needs a person" while two Anthropic applications sat
        # blocked on questions only the candidate can answer.
        #
        # Rows with no recorded outcome are kept, because a status still
        # separates a row awaiting a person from one already sent, and older rows
        # predate outcomes being written at all.
        placeholders = ",".join("?" for _ in HUMAN_ACTIONABLE)
        rows = conn.execute(
            f"""
            SELECT j.id, j.company, j.title, j.link, j.status, j.score,
                   (SELECT o.stage FROM outcomes o
                     WHERE o.job_id = j.id ORDER BY o.id DESC LIMIT 1) AS stage
              FROM jobs j
             WHERE LOWER(COALESCE(j.status,'')) IN ('needsverification','needsreview','skipped')
               AND LOWER(COALESCE(j.link,'')) LIKE 'https://%'
               AND ( (SELECT o2.stage FROM outcomes o2
                       WHERE o2.job_id = j.id ORDER BY o2.id DESC LIMIT 1) IN ({placeholders})
                     OR NOT EXISTS (SELECT 1 FROM outcomes o3 WHERE o3.job_id = j.id) )
             ORDER BY COALESCE(j.score, 0) DESC, j.id DESC
             LIMIT ?
            """,
            (*sorted(HUMAN_ACTIONABLE), max(1, min(limit, 200)) * 8),
        ).fetchall()
    except sqlite3.OperationalError:
        # An older database without the outcomes table still works.
        rows = conn.execute(
            """
            SELECT j.id, j.company, j.title, j.link, j.status, j.score, NULL AS stage
              FROM jobs j
             WHERE LOWER(COALESCE(j.status,'')) IN ('needsverification','needsreview','skipped')
               AND LOWER(COALESCE(j.link,'')) LIKE 'https://%'
             ORDER BY COALESCE(j.score, 0) DESC, j.id DESC
             LIMIT ?
            """,
            (max(1, min(limit, 200) * 2),),
        ).fetchall()
    finally:
        conn.close()

    out: list[dict] = []
    seen: set[str] = set()
    per_company: dict[str, int] = {}
    skipped_dead: int = 0
    for r in rows:
        link = (r["link"] or "").strip().rstrip("/")
        if not link or link in seen:
            continue
        seen.add(link)
        stage = (r["stage"] or "").strip().lower()
        status = (r["status"] or "").strip().lower()

        # Only an outcome a person can actually finish belongs here. A row whose
        # latest outcome is a dead end stays out even if an older one wasn't -
        # the newest outcome is the current truth for that posting.
        if stage in DEAD_END:
            skipped_dead += 1
            continue
        reason = HUMAN_ACTIONABLE.get(stage)
        if reason is None:
            # No recorded outcome yet (the table only started being written
            # recently), so fall back to the status, which still separates a
            # row awaiting a person from one already sent.
            reason = HUMAN_ACTIONABLE.get(status)
        if reason is None:
            continue

        company = (r["company"] or "?").strip()
        # Cap per company. Twenty postings at one company is one employer, not
        # twenty opportunities, and it would crowd out everything else.
        if per_company.get(company, 0) >= per_company_cap:
            continue
        per_company[company] = per_company.get(company, 0) + 1

        out.append({
            "id": r["id"],
            "company": company,
            "title": r["title"] or "?",
            "link": link,
            "score": r["score"],
            "reason": reason,
        })
        if len(out) >= limit:
            break
    return out, skipped_dead


def open_in_browser(urls: list[str]) -> bool:
    if not urls:
        return True
    if sys.platform.startswith("win"):
        command, prefix = ["cmd", "/c", "start", ""], []
    elif sys.platform == "darwin":
        command, prefix = ["open"], []
    else:
        command, prefix = ["xdg-open"], []
    ok = True
    for url in urls:
        try:
            subprocess.run([command, *prefix, url], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        except Exception:  # noqa: BLE001
            ok = False
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="Open postings that need a person")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--per-company", type=int, default=3,
                    help="most postings to list for any one company (default 3)")
    args = ap.parse_args()

    rows, skipped_dead = query(args.limit, max(1, args.per_company))
    if not rows:
        print("[queue] nothing needs a person right now")
        if skipped_dead:
            print(f"[queue] ({skipped_dead} closed posting(s) left out - nothing to complete)")
        return 0

    # Grouped so the pattern is visible at a glance rather than as 15 near-identical lines.
    by_reason: dict[str, list[dict]] = {}
    for r in rows:
        by_reason.setdefault(r["reason"], []).append(r)

    print(f"[queue] {len(rows)} posting(s) need you:")
    if skipped_dead:
        print(f"       ({skipped_dead} closed posting(s) left out - nothing to complete)")
    for reason, items in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        print(f"\n  {reason}  ({len(items)})")
        for r in items[:12]:
            score = r["score"] if r["score"] is not None else "?"
            print(f"    #{r['id']:<5} {str(score):>4}  {r['company'][:20]:<22} {r['title'][:46]}")
            print(f"          {r['link']}")
        if len(items) > 12:
            print(f"    ... and {len(items) - 12} more")

    if args.dry_run:
        print("\n[queue] --dry-run: nothing opened")
        return 0
    if open_in_browser([r["link"] for r in rows]):
        print(f"\n[queue] opened {len(rows)} tab(s). Fill and submit each one.")
        return 0
    print("\n[queue] the browser refused at least one URL; open the links above", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())