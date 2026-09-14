"""
notifications/interview_prep.py — Interview prep auto-trigger (PulseOps Phase 9)

When outcome.stage == 'phone_screen' AND prep_sent == 0:
  - Load STAR+R stories, comp research, negotiation notes, skill gap from job row
  - Call notifier.send_prep_pack()
  - Mark prep_sent = 1 in outcomes table
  - Audit log

Per spec: "auto-send prep pack to Telegram" — zero user action required.
Runs as part of Phase 9 in main.py after reply detection.
"""

import os
from pulseops_core.exceptions import TelegramError
from pulseops_store import db_manager as db
from pulseops_store import audit_log
from pulseops_notify import notifier


def check_and_send_prep_packs(
    run_id: str = "",
    bot_token: str | None = None,
    chat_id: str | None = None,
    webhook_url: str | None = None,
) -> int:
    """
    Fires prep packs for any outcomes at phone_screen stage with prep_sent=0.
    Returns count of prep packs successfully dispatched.
    """
    bot_token = bot_token or os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id   = chat_id   or os.getenv("TELEGRAM_CHAT_ID")
    webhook_url = webhook_url or os.getenv("DISCORD_WEBHOOK_URL", "")

    pending = db.get_outcomes_needing_prep()
    if not pending:
        print("  [~] No pending interview prep packs.")
        return 0

    sent = 0
    for outcome in pending:
        company  = outcome.get("company", "Unknown")
        title    = outcome.get("title", "Unknown")
        oid      = outcome["id"]

        # Job-level evaluation artifacts (may be absent for old rows)
        star_stories       = outcome.get("job_star_stories") or []
        comp_research      = outcome.get("job_comp_research") or ""
        negotiation_notes  = outcome.get("job_negotiation_notes") or ""
        skill_gap          = outcome.get("job_skill_gap") or []
        level_strategy     = outcome.get("job_level_strategy") or ""

        print(f"  [Prep] Sending prep pack: {title} @ {company}")
        try:
            notifier.send_prep_pack(
                company=company, title=title,
                star_stories=star_stories, comp_research=comp_research,
                negotiation_notes=negotiation_notes, skill_gap=skill_gap,
                level_strategy=level_strategy,
                bot_token=bot_token, chat_id=chat_id, run_id=run_id,
            )
            db.mark_prep_sent(oid)
            sent += 1
            print(f"  [OK] Prep pack sent for {company}/{title}")
        except TelegramError as e:
            # Non-fatal — Telegram may be unavailable; outcome stays prep_sent=0
            # so it will retry on the next run.
            print(f"  [!] Prep pack failed for {company}/{title}: {e}")

        # Discord notification
        if webhook_url:
            try:
                from pulseops_notify.discord import send_discord_prep_pack
                send_discord_prep_pack(
                    company=company, title=title,
                    star_stories=star_stories, comp_research=comp_research,
                    negotiation_notes=negotiation_notes, skill_gap=skill_gap,
                    level_strategy=level_strategy,
                    webhook_url=webhook_url, run_id=run_id,
                )
            except Exception as e:
                print(f"  [!] Prep pack failed (Discord) for {company}/{title}: {e}")

    return sent
