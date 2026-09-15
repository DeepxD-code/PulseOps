"""
notifications/weekly_digest.py — Sunday 09:00 IST weekly funnel digest (PulseOps Phase 9)

Sent by main_weekly.py (or if triggered manually).
Covers:
  - 7-day funnel: sourced → evaluated → matched → sent → callbacks
  - Callback rate by score band (70-79, 80-89, 90+)
  - Callback rate by email variant
  - Top 5 skill gaps this week
  - Pending follow-ups due this week
  - CV staleness warning (cv.md > 30 days old)
  - Stale queue items alert (send_queue pending > 3 days)
  - Anomaly flags:
      • 0 callbacks after 20+ sends → suggest reviewing threshold/email quality
      • 0 sends after 5+ runs → send threshold may be too high
"""

import html
from datetime import datetime, timedelta
from pathlib import Path

from pulseops_core.exceptions import TelegramError
from pulseops_store import audit_log
from pulseops_store import db_manager as db

from pulseops_notify import notifier

try:
    from pulseops_config.paths import repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parents[4]


def _format_rate(d: dict) -> str:
    sent = d.get("sent", 0)
    callbacks = d.get("callbacks", 0)
    pct = f"{(callbacks / sent * 100):.0f}%" if sent else "—"
    return f"{callbacks}/{sent} ({pct})"


def _load_outreach_mode() -> str:
    import yaml
    for p in [ROOT / "config" / "settings.yml", ROOT / "config" / "settings.yml.example"]:
        if p.exists():
            try:
                with open(p) as f:
                    return (yaml.safe_load(f) or {}).get("outreach", {}).get("mode", "dm_first")
            except Exception:
                pass
    return "dm_first"


def build_digest(since_iso: str) -> str:
    """Builds the full weekly digest HTML string."""
    outreach_mode = _load_outreach_mode()

    # ── Run stats funnel ─────────────────────────────────────────────────
    runs = db.get_run_stats_since(since_iso)
    total_sourced   = sum(r["stats"].get("sourced", 0) for r in runs)
    total_evaluated = sum(r["stats"].get("evaluated", 0) for r in runs)
    total_pdf       = sum(r["stats"].get("matched_pdf", 0) for r in runs)
    total_sent      = sum(r["stats"].get("sent", 0) for r in runs)
    run_count       = len(runs)

    # ── Callbacks (outcomes in this window) ──────────────────────────────
    outcomes = db.get_outcomes_since(since_iso)
    total_callbacks = len(set(o["job_id"] for o in outcomes if o.get("job_id")))

    # ── Score band rates ─────────────────────────────────────────────────
    band_rates = db.get_callback_rate_by_score_band(since_iso)

    # ── Variant rates ─────────────────────────────────────────────────────
    variant_rates = db.get_callback_rate_by_variant(since_iso)

    # ── Skill gaps ────────────────────────────────────────────────────────
    skill_gaps = db.get_top_skill_gaps(since_iso, top_n=5)

    # ── Pending follow-ups ───────────────────────────────────────────────
    followup_due = db.get_followup_candidates(day_threshold=5)

    # ── CV staleness ─────────────────────────────────────────────────────
    cv_path = ROOT / "cv.md"
    cv_stale = False
    cv_age_days = 0
    if cv_path.exists():
        cv_age_days = (datetime.now() - datetime.fromtimestamp(cv_path.stat().st_mtime)).days
        cv_stale = cv_age_days > 30

    # ── Stale queue ──────────────────────────────────────────────────────
    stale_queue = db.get_stale_queue_items(days=3)

    # ── Anomaly flags ────────────────────────────────────────────────────
    anomalies = []
    if total_sent >= 20 and total_callbacks == 0:
        anomalies.append("⚡ 0 callbacks after 20+ sends — review score threshold or email quality")
    if outreach_mode != "dm_first" and run_count >= 5 and total_sent == 0:
        anomalies.append("⚡ 0 sends after 5+ runs — SEND_THRESHOLD may be too high")
    elif outreach_mode == "dm_first" and run_count >= 5 and total_pdf == 0:
        anomalies.append(
            "⚡ 0 matched jobs (PDF-eligible) after 5+ runs — in dm_first mode, "
            "'Sent' is expected to stay low without HUNTER_API_KEY; check "
            "PDF/notify thresholds instead of the send threshold."
        )
    if cv_stale:
        anomalies.append(f"⚡ cv.md last updated {cv_age_days} days ago — consider refreshing")
    if stale_queue:
        anomalies.append(f"⚡ {len(stale_queue)} send_queue items stuck > 3 days — check guardrails")

    # ── Build message ────────────────────────────────────────────────────
    mode_note = (
        " <i>(dm_first — cold-email 'Sent' stays low by design; "
        "'PDFs built' is your real weekly output)</i>"
        if outreach_mode == "dm_first" else ""
    )
    lines = [
        "📋 <b>PulseOps — Weekly Digest</b>",
        f"📅 Week ending {datetime.now().strftime('%A %b %d, %Y')}",
        "====================================",
        f"📊 <b>7-Day Funnel</b>{mode_note}",
        f"  Sourced:    <b>{total_sourced}</b>",
        f"  Evaluated:  <b>{total_evaluated}</b>",
        f"  PDFs built: <b>{total_pdf}</b>",
        f"  Sent:       <b>{total_sent}</b>",
        f"  Callbacks:  <b>{total_callbacks}</b>",
        f"  Runs:       <b>{run_count}</b>",
        "====================================",
        "🎯 <b>Callback Rate by Score Band</b>",
    ]
    for band, data in band_rates.items():
        lines.append(f"  {band}: {_format_rate(data)}")

    lines += [
        "====================================",
        "✉️ <b>Callback Rate by Email Variant</b>",
    ]
    if variant_rates:
        for variant, data in variant_rates.items():
            lines.append(f"  {html.escape(variant)}: {_format_rate(data)}")
    else:
        lines.append("  No data yet")

    lines += ["====================================", "⚠️ <b>Top Skill Gaps This Week</b>"]
    if skill_gaps:
        for skill, count in skill_gaps:
            lines.append(f"  • {html.escape(skill)} ({count} jobs)")
    else:
        lines.append("  None detected")

    if followup_due:
        lines += ["====================================",
                   f"📬 <b>Follow-ups Due ({len(followup_due)})</b>"]
        for f in followup_due[:5]:
            lines.append(f"  • {html.escape(f.get('company',''))} — {html.escape(f.get('job_title',''))}")

    if anomalies:
        lines += ["====================================", "🚨 <b>Anomaly Flags</b>"]
        lines += [f"  {a}" for a in anomalies]

    # Threshold calibration note — surfaces once real callback data exists
    if total_callbacks > 0 and band_rates:
        cb_bands = {b: d for b, d in band_rates.items() if d.get("sent", 0) >= 3}
        if cb_bands:
            best = max(cb_bands, key=lambda b: cb_bands[b].get("rate", 0))
            worst = min(cb_bands, key=lambda b: cb_bands[b].get("rate", 0))
            lines += [
                "====================================",
                "🎛 <b>Threshold Calibration</b> <i>(SEND_THRESHOLD=88 is a hypothesis)</i>",
                f"  Best callback band: <b>{best}</b> ({_format_rate(cb_bands[best])})",
                f"  Weakest band: <b>{worst}</b> ({_format_rate(cb_bands[worst])})",
                "  <i>Adjust SEND_THRESHOLD in config/settings.yml based on "
                "which band actually converts.</i>",
            ]
    elif total_sent >= 5 and total_callbacks == 0:
        lines += [
            "====================================",
            "🎛 <b>Threshold Calibration</b>",
            f"  {total_sent} sends so far, 0 callbacks. Too early to calibrate — "
            "keep running for 2-3 more weeks before adjusting SEND_THRESHOLD.",
        ]

    lines += [
        "====================================",
        "<i>PulseOps weekly digest. Next run: Sunday 09:00 IST</i>",
    ]
    return "\n".join(lines)


def send_weekly_digest(
    bot_token: str | None = None,
    chat_id: str | None = None,
    run_id: str = "",
    webhook_url: str | None = None,
) -> bool:
    """
    Build and send the weekly digest covering the last 7 days.
    Returns True on success, False if Telegram is unconfigured.
    Raises TelegramError on API failure.
    """
    since = (datetime.now() - timedelta(days=7)).isoformat()
    message = build_digest(since)

    try:
        ok = notifier.send_telegram_summary(message, bot_token=bot_token,
                                              chat_id=chat_id, run_id=run_id)
        audit_log.write_digest_sent(run_id, bool(ok))
    except TelegramError:
        audit_log.write_digest_sent(run_id, False)
        raise

    # Discord digest
    if webhook_url:
        try:
            from pulseops_notify.discord import send_discord_weekly_digest
            send_discord_weekly_digest(webhook_url=webhook_url, run_id=run_id)
        except Exception as e:
            print(f"  [!] Discord weekly digest failed (non-fatal): {e}")

    return bool(ok)


def should_send_digest(timezone_name: str = "Asia/Kolkata") -> bool:
    """
    Returns True if the current local time is Sunday between 09:00 and 09:15 IST.
    (15-minute window prevents double-sends from cron timing drift.)
    """
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo(timezone_name))
    except Exception:
        now = datetime.now()
    return now.weekday() == 6 and now.hour == 9 and now.minute < 15
