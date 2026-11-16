"""List and record the answers to the applications PulseOps sent.

Every application made through a board's form is answered by mail, and until
now nothing was reading it: the reply detector watches the cold-outreach
addresses, and a form application leaves no row there. So a recruiter's
"we would like to schedule an interview" sat in the inbox unseen.

This runs the application-reply sweep and prints what it found:

    python scripts/watch_application_replies.py            # report only
    python scripts/watch_application_replies.py --apply    # record + notify
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for package in ("pulse-store", "pulse-eval", "pulse-config", "pulse-notify", "pulse-core"):
    path = ROOT / "packages" / package / "src"
    if path.exists() and str(path) not in sys.path:
        sys.path.insert(0, str(path))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:  # noqa: BLE001 - the ambient environment may already have it
    pass

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="record the replies (default: report only)")
    parser.add_argument("--days", type=int, default=21, help="how far back to look (default 21)")
    args = parser.parse_args()

    from pulseops_notify.application_replies import sweep

    stats = sweep(days=args.days, dry_run=not args.apply)
    if stats.get("error"):
        print(f"[replies] {stats['error']}")
        return 1
    print(f"\n[replies] {stats['replies']} reply(ies), {stats['rejections']} rejection(s), "
          f"{stats['noise']} noise, {stats['new']} newly recorded")
    for item in stats["items"]:
        print(f"\n  {item['kind'].upper()}  {item['sender']}"
              + (f"  (job #{item['job_id']})" if item["job_id"] else "  (no matching row)"))
        print(f"    {item['received_at'][:31]}")
        print(f"    {item['subject']}")
        print(f"    {item['snippet'][:360]}")
    if not args.apply:
        print("\nReport only. Re-run with --apply to record these replies.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
