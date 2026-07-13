"""
memory/memory.py — Memory CLI (PulseOps Phase 8)

Usage:
  python memory.py add "Got callback from Stripe. Failed system design round."
  python memory.py add "Built C++ load balancer, 100k concurrent connections."
  python memory.py add "Avoid Infosys, Wipro, TCS — service companies."
  python memory.py list [--category callback|feedback|project|skill|preference|note]
  python memory.py pending            # cv_candidate memories awaiting cv.md update
  python memory.py context [company]  # show what would be injected into next eval
  python memory.py delete <id>
  python memory.py edit <id> "new raw text"

Non-negotiable #4: memory NEVER auto-modifies cv.md.
  cv_candidate memories are FLAGGED ONLY.
  User reviews via: python doctor.py --apply-memories
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _do_add(raw_text: str, simulate: bool = False) -> None:
    from memory.memory_parser import parse_memory
    from persistence import db_manager as db, audit_log

    print(f"  Parsing: '{raw_text[:80]}…'" if len(raw_text) > 80 else f"  Parsing: '{raw_text}'")

    try:
        parsed = parse_memory(raw_text, simulate=simulate)
    except Exception as e:
        print(f"  [Error] Memory parsing failed: {e}")
        sys.exit(1)

    category    = parsed["category"]
    company     = parsed.get("company", "")
    action      = parsed["action"]
    cv_cand     = parsed.get("cv_candidate", False)

    mem_id = db.add_memory(
        category=category,
        raw_text=raw_text,
        parsed=parsed,
        action=action,
        company=company,
        cv_candidate=cv_cand,
    )
    audit_log.write_memory("", category, action, parsed.get("summary", "")[:120])

    print(f"  [OK] Memory #{mem_id} saved")
    print(f"       Category: {category}  |  Company: {company or '—'}  |  Action: {action}")
    if parsed.get("summary"):
        print(f"       Summary:  {parsed['summary'][:120]}")
    if parsed.get("skills"):
        print(f"       Skills:   {', '.join(parsed['skills'])}")

    # ── Immediate actions ─────────────────────────────────────────────────
    if action == "add_to_blacklist" and company:
        bl_path = ROOT / "config" / "blacklist.txt"
        existing = bl_path.read_text(encoding="utf-8") if bl_path.exists() else ""
        if company.lower() not in existing.lower():
            with open(bl_path, "a", encoding="utf-8") as f:
                f.write(f"\n{company}\n")
            print(f"  [OK] '{company}' added to config/blacklist.txt")

    if action == "add_cooldown" and company:
        from persistence.db_manager import normalise_company, save_outreach, get_job
        # Record a synthetic outreach row so G5 cooldown fires
        existing_jobs = db.get_jobs_by_status(["Sent", "Evaluated"], limit=50)
        job_id = next((j["id"] for j in existing_jobs
                        if normalise_company(j.get("company","")) == normalise_company(company)), 0)
        if job_id:
            save_outreach(job_id=job_id, company=company, contact_email="",
                           subject="[cooldown added via memory]", status="cooldown", domain="")
            print(f"  [OK] Cooldown added for '{company}'")
        else:
            print(f"  [!] No job found for '{company}' to add cooldown to — add manually if needed")

    if cv_cand:
        print(f"  [NOTE] Flagged as cv_candidate — review via: python doctor.py --apply-memories")
        print(f"  [NOTE] cv.md is NEVER auto-modified (non-negotiable #4)")


def _do_list(category: str | None = None) -> None:
    from persistence import db_manager as db
    memories = db.get_active_memories(category=category, limit=50)
    if not memories:
        print("  No active memories found.")
        return
    for m in memories:
        parsed = m.get("parsed") or {}
        summary = parsed.get("summary") or m.get("raw_text", "")[:80]
        company = m.get("company") or "—"
        print(f"  #{m['id']:3d}  [{m['category']:<12}]  {m['created_at'][:10]}  "
               f"company={company:<15}  action={m.get('action','—'):<18}  {summary[:60]}")


def _do_pending() -> None:
    from persistence import db_manager as db
    pending = db.get_cv_candidates()
    if not pending:
        print("  No pending cv_candidate memories.")
        return
    print(f"  {len(pending)} cv_candidate memory/memories pending review:\n")
    for m in pending:
        parsed = m.get("parsed") or {}
        print(f"  #{m['id']}  [{m['category']}]  {m['raw_text'][:120]}")
        if parsed.get("skills"):
            print(f"       Skills: {', '.join(parsed['skills'])}")
        print()
    print("  Review via: python doctor.py --apply-memories")


def _do_context(company: str = "") -> None:
    from memory.context_loader import load_context
    ctx = load_context(company=company)
    if ctx:
        print(ctx)
    else:
        print("  No deferred memory context found" +
               (f" for '{company}'" if company else "") + ".")


def _do_delete(mem_id: int) -> None:
    from persistence import db_manager as db
    conn = db.get_connection()
    try:
        conn.execute("UPDATE memories SET active=0 WHERE id=?", (mem_id,))
        conn.commit()
        print(f"  [OK] Memory #{mem_id} deactivated.")
    finally:
        conn.close()


def _do_edit(mem_id: int, new_text: str, simulate: bool = False) -> None:
    from memory.memory_parser import parse_memory
    from persistence import db_manager as db
    try:
        parsed = parse_memory(new_text, simulate=simulate)
    except Exception as e:
        print(f"  [Error] Re-parse failed: {e}")
        sys.exit(1)
    conn = db.get_connection()
    try:
        conn.execute(
            "UPDATE memories SET raw_text=?, parsed=?, category=?, action=?, "
            "company=?, cv_candidate=? WHERE id=?",
            (new_text, json.dumps(parsed), parsed["category"], parsed["action"],
             parsed.get("company",""), 1 if parsed.get("cv_candidate") else 0, mem_id),
        )
        conn.commit()
        print(f"  [OK] Memory #{mem_id} updated.")
    finally:
        conn.close()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(prog="memory", description="PulseOps Memory CLI")
    parser.add_argument("--simulate", action="store_true",
                         help="Use keyword fallback instead of LLM")
    sub = parser.add_subparsers(dest="command")

    p_add = sub.add_parser("add", help="Add a new memory")
    p_add.add_argument("text", nargs="+")

    p_list = sub.add_parser("list", help="List active memories")
    p_list.add_argument("--category", default=None)

    sub.add_parser("pending", help="Show pending cv_candidate memories")

    p_ctx = sub.add_parser("context", help="Show memory context for a company")
    p_ctx.add_argument("company", nargs="?", default="")

    p_del = sub.add_parser("delete", help="Deactivate a memory by ID")
    p_del.add_argument("id", type=int)

    p_edit = sub.add_parser("edit", help="Edit a memory by ID")
    p_edit.add_argument("id", type=int)
    p_edit.add_argument("text", nargs="+")

    args = parser.parse_args()

    from persistence.db_manager import init_db
    init_db()

    if args.command == "add":
        _do_add(" ".join(args.text), simulate=args.simulate)
    elif args.command == "list":
        _do_list(args.category)
    elif args.command == "pending":
        _do_pending()
    elif args.command == "context":
        _do_context(args.company)
    elif args.command == "delete":
        _do_delete(args.id)
    elif args.command == "edit":
        _do_edit(args.id, " ".join(args.text), simulate=args.simulate)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
