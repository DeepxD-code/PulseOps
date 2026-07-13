"""
memory/outcome_tracker.py — Interview stage recording + prep pack trigger (Phase 8)

Usage:
  python outcome_tracker.py record "Stripe" "Backend Intern" phone_screen "Great call!"
  python outcome_tracker.py record "Stripe" "Backend Intern" technical
  python outcome_tracker.py record "Stripe" "Backend Intern" rejected "Failed system design"

On phone_screen: auto-triggers interview prep pack delivery via Telegram
(check_and_send_prep_packs runs inside main.py Phase 9, but can also be
triggered manually here).

Non-negotiable #10: feedback loop only from phone_screen+ status.
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

VALID_STAGES = frozenset([
    "phone_screen", "technical", "final", "offer", "rejected", "accepted"
])


def record(company: str, title: str, stage: str, notes: str = "") -> None:
    if stage not in VALID_STAGES:
        print(f"  [Error] Invalid stage '{stage}'. Valid: {sorted(VALID_STAGES)}")
        sys.exit(1)

    from persistence import db_manager as db, audit_log

    db.init_db()

    # Find the job_id
    job = db.get_job_by_title_company(title, company)
    job_id = job["id"] if job else None

    if not job_id:
        print(f"  [!] No job found for '{title}' @ '{company}' — recording outcome without job link")

    oid = db.record_outcome(
        job_id=job_id,
        company=company, title=title, stage=stage, notes=notes,
    )
    audit_log.write_outcome("", company, title, stage)
    print(f"  [OK] Outcome #{oid} recorded: {title} @ {company} → {stage}")
    if notes:
        print(f"       Notes: {notes}")

    # phone_screen → add deferred memory + queue prep pack
    if stage == "phone_screen":
        # Add a callback memory so it shows up in future evals for this company
        from memory.memory_parser import parse_memory
        raw = f"Got interview callback from {company} for {title} role."
        parsed = parse_memory(raw, simulate=True)
        parsed["action"]   = "deferred"
        parsed["company"]  = company
        parsed["category"] = "callback"
        parsed["sentiment"] = "positive"
        db.add_memory(
            category="callback", raw_text=raw, parsed=parsed,
            action="deferred", company=company,
        )
        print(f"  [OK] Callback memory added for {company} (will inject into next eval)")
        print(f"  [OK] Prep pack queued — will fire at next Phase 9 run (or run interview_prep manually)")

    if stage in ("rejected", "offer"):
        # add_cooldown for rejections; offer is a win — add note
        action = "add_cooldown" if stage == "rejected" else "deferred"
        raw = (f"Rejected by {company} at {stage} stage. {notes}" if stage == "rejected"
                else f"Received offer from {company} for {title}. {notes}")
        parsed = parse_memory(raw, simulate=True)
        parsed["action"]  = action
        parsed["company"] = company
        db.add_memory(category="feedback", raw_text=raw, parsed=parsed,
                       action=action, company=company)
        if stage == "rejected":
            print(f"  [OK] Cooldown memory added for {company}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="outcome_tracker",
                                      description="Record interview stage outcomes")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("record", help="Record an outcome stage")
    p.add_argument("company")
    p.add_argument("title")
    p.add_argument("stage", choices=sorted(VALID_STAGES))
    p.add_argument("notes", nargs="?", default="")

    p_list = sub.add_parser("list", help="List recent outcomes")
    p_list.add_argument("--days", type=int, default=30)

    args = parser.parse_args()

    from persistence.db_manager import init_db
    init_db()

    if args.command == "record":
        record(args.company, args.title, args.stage, args.notes)
    elif args.command == "list":
        from persistence import db_manager as db
        from datetime import datetime, timedelta
        since = (datetime.now() - timedelta(days=args.days)).isoformat()
        outcomes = db.get_outcomes_since(since)
        if not outcomes:
            print("  No outcomes in the last", args.days, "days.")
        for o in outcomes:
            print(f"  #{o['id']:3d}  {o['recorded_at'][:10]}  {o['stage']:<14}  "
                   f"{o['company']:<20}  {o['title'][:40]}")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
