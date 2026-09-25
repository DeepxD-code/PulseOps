"""Deliver pending PulseOps G10 review cards to Discord.

The watcher never prints webhook URLs.  It waits for
``DISCORD_REVIEW_WEBHOOK_URL`` in the repository ``.env``, then calls the
idempotent review flush.  Successfully delivered rows change from
``needs_review`` to ``review_posted`` and are not sent again.

Delivery failures are visible and non-fatal: the row is left pending so a later
healthy worker can retry it.  In particular, an import/stale-module problem is
never converted into a successful exit or a silently dropped review.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT / ".env"


def _counts(result: object) -> tuple[int, int, int]:
    """Read the three public counters defensively without hiding bad output."""
    if not isinstance(result, dict):
        raise TypeError(f"review flush returned {type(result).__name__}, expected dict")
    try:
        return (
            max(0, int(result.get("posted", 0))),
            max(0, int(result.get("pending", 0))),
            max(0, int(result.get("failed", 0))),
        )
    except (TypeError, ValueError) as exc:
        raise TypeError(f"invalid review flush counters: {result!r}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Flush pending G10 JDs to Discord")
    parser.add_argument("--wait-seconds", type=int, default=0,
                        help="Wait up to this many seconds for a review webhook")
    parser.add_argument("--poll-seconds", type=int, default=15)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()

    wait_deadline = time.time() + max(0, args.wait_seconds)
    announced_wait = False
    max_attempts = max(1, args.max_attempts)

    # Waiting is only for webhook configuration.  Once a webhook is available,
    # successful batches are drained even when there are more rows than one
    # --limit batch.
    while True:
        values = dotenv_values(ENV_PATH)
        webhook = (values.get("DISCORD_REVIEW_WEBHOOK_URL") or "").strip()
        if not webhook:
            if args.wait_seconds and not announced_wait:
                print("[g10-review] waiting for DISCORD_REVIEW_WEBHOOK_URL in .env", flush=True)
                announced_wait = True
            if time.time() >= wait_deadline:
                print("[g10-review] webhook not configured; cards remain pending", flush=True)
                return 2
            time.sleep(max(1, args.poll_seconds))
            continue

        # Ensure delivery functions see the value without ever printing it.
        os.environ["DISCORD_REVIEW_WEBHOOK_URL"] = webhook
        load_dotenv(ENV_PATH, override=True)

        try:
            from pulseops_outreach.send_engine import flush_pending_review_cards
        except Exception as exc:
            print(
                "[g10-review] delivery module unavailable; existing review rows "
                f"remain pending ({type(exc).__name__})",
                flush=True,
            )
            return 1

        failed_rounds = 0
        last_pending: int | None = None
        while True:
            try:
                raw_result = flush_pending_review_cards(
                    run_id="g10-review-watcher", limit=max(1, args.limit)
                )
                posted, pending, failed = _counts(raw_result)
            except Exception as exc:
                # Do not invent a success state for an import/runtime failure.
                # The DB row is intentionally untouched and remains retryable.
                print(
                    "[g10-review] delivery failed; review rows remain pending "
                    f"({type(exc).__name__})",
                    flush=True,
                )
                return 1

            print(
                f"[g10-review] posted={posted} pending={pending} failed={failed}",
                flush=True,
            )
            if pending == 0 and failed == 0:
                return 0
            if pending == 0 and failed > 0:
                print("[g10-review] delivery reported failures; cards were not all confirmed", flush=True)
                return 1

            if failed == 0 and posted > 0:
                # Another batch may remain because --limit is intentionally a
                # batch size, not a reason to report pending rows as posted.
                if last_pending is not None and pending >= last_pending:
                    print("[g10-review] no pending-count progress; cards remain pending", flush=True)
                    return 1
                last_pending = pending
                continue

            if failed == 0:
                print("[g10-review] no delivery progress; cards remain pending", flush=True)
                return 1

            failed_rounds += 1
            if failed_rounds >= max_attempts:
                print("[g10-review] delivery attempts exhausted; cards remain pending", flush=True)
                return 1
            time.sleep(max(1, args.poll_seconds))


if __name__ == "__main__":
    sys.exit(main())
