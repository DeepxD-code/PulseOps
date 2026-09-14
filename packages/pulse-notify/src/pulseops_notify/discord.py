"""
notifications/discord.py — Discord webhook dispatcher (PulseOps Phase 9 extension)

Sends all 7 notification types via Discord webhooks (rich embeds):
  - send_discord_message         — generic text summary (weekly digest, system messages)
  - send_discord_summary         — daily run summary with funnel stats
  - send_discord_match_card      — per-job match card with score, AI analysis, PDF
  - send_discord_source_health_alert — non-negotiable #6, 3 consecutive zeros
  - send_discord_referral_alert  — G4 referral check fired (contact exists)
  - send_discord_reply_alert     — new recruiter reply detected
  - send_discord_prep_pack       — interview prep pack (phone_screen trigger)

Return convention matches notifier.py:
  - False  -> Discord not configured (no webhook URL). Non-fatal.
  - True   -> message sent successfully.
  - raises TelegramError -> Discord WAS configured but the API call failed.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

import requests
from pulseops_core.exceptions import TelegramError
from pulseops_store import audit_log

DISCORD_API = "https://discord.com/api/webhooks/{webhook_id}/{webhook_token}"
MAX_EMBED_DESCRIPTION = 4000
MAX_FIELD_VALUE = 1024
MAX_FIELDS = 25

ROOT = Path(__file__).resolve().parent.parent

# ── Embed color palette (by grade / severity) ───────────────────────────────

COLOR_A = 0x2ECC71   # Green  — grade A (90+)
COLOR_B = 0x3498DB   # Blue   — grade B (80-89)
COLOR_C = 0xF39C12   # Yellow — grade C (70-79)
COLOR_D = 0xE74C3C   # Red    — grade D/F (<70)
COLOR_INFO = 0x95A5A6    # Gray  — system messages
COLOR_WARN = 0xE67E22    # Orange — alerts
COLOR_SUCCESS = 0x27AE60 # Dark green — success
COLOR_ERROR = 0xC0392B   # Dark red — errors


def _grade_color(grade: str) -> int:
    return {"A": COLOR_A, "B": COLOR_B, "C": COLOR_C, "D": COLOR_D, "F": COLOR_D}.get(grade, COLOR_INFO)


# ── Webhook URL parsing ─────────────────────────────────────────────────────

def _parse_webhook_url(url: str) -> tuple[str, str] | None:
    """Extract (webhook_id, webhook_token) from a Discord webhook URL."""
    url = url.strip()
    if not url:
        return None
    # Format: https://discord.com/api/webhooks/{id}/{token}
    # or:     https://discordapp.com/api/webhooks/{id}/{token}
    parts = url.rstrip("/").split("/")
    try:
        # Find 'webhooks' in the path and take the next two segments
        idx = len(parts) - 1
        token = parts[idx]
        webhook_id = parts[idx - 1]
        if webhook_id.isdigit() and token:
            return webhook_id, token
    except (IndexError, ValueError):
        pass
    return None


def _get_webhook_credentials(webhook_url: str | None = None) -> tuple[str, str] | None:
    """Return (webhook_id, webhook_token) or None if not configured."""
    url = webhook_url or os.getenv("DISCORD_WEBHOOK_URL", "")
    if not url:
        print("  [Discord] Not configured — set DISCORD_WEBHOOK_URL. Skipping.")
        return None
    creds = _parse_webhook_url(url)
    if not creds:
        print("  [Discord] Invalid DISCORD_WEBHOOK_URL format. Skipping.")
        return None
    return creds


# ── Low-level Discord API ───────────────────────────────────────────────────

def _post_webhook(webhook_id: str, webhook_token: str, payload: dict,
                  files: dict | None = None) -> dict:
    """POST to Discord webhook. Returns parsed JSON response."""
    url = DISCORD_API.format(webhook_id=webhook_id, webhook_token=webhook_token)
    try:
        if files:
            resp = requests.post(url, data={"payload_json": json.dumps(payload)},
                                 files=files, timeout=30)
        else:
            resp = requests.post(url, json=payload, timeout=15)
    except requests.RequestException as e:
        raise TelegramError(f"Discord webhook request failed: {e}") from e

    try:
        data = resp.json()
    except ValueError:
        snippet = (resp.text or "")[:200].replace("\n", " ")
        raise TelegramError(
            f"Discord non-JSON response (HTTP {resp.status_code}): {snippet or 'empty body'}"
        )

    if resp.status_code in (200, 204):
        return data
    raise TelegramError(
        f"Discord webhook rejected (HTTP {resp.status_code}): "
        f"{data.get('message', resp.text[:200])}"
    )


def _truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len - 50] + "\n\n*[Truncated for length]*"


def _strip_html(text: str) -> str:
    """Remove HTML tags from Telegram-formatted text for Discord plain text."""
    import re
    text = re.sub(r'<b>(.*?)</b>', r'**\1**', text)
    text = re.sub(r'<i>(.*?)</i>', r'*\1*', text)
    text = re.sub(r'<code>(.*?)</code>', r'`\1`', text)
    text = re.sub(r'<a href="(.*?)">(.*?)</a>', r'[\2](\1)', text)
    text = re.sub(r'<[^>]+>', '', text)
    return text.strip()


def _escape_md(text: str) -> str:
    """Escape Discord markdown characters."""
    for ch in ['*', '_', '~', '|', '`', '>']:
        text = text.replace(ch, f'\\{ch}')
    return text


# ── Generic summary ─────────────────────────────────────────────────────────

def send_discord_message(summary_text: str, webhook_url: str | None = None,
                         run_id: str = "") -> bool:
    """Send a generic text summary to Discord (weekly digest, system messages)."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    clean = _strip_html(summary_text)
    embeds = [{
        "title": "📋 PulseOps — Summary",
        "description": _truncate(clean, MAX_EMBED_DESCRIPTION),
        "color": COLOR_INFO,
        "footer": {"text": f"PulseOps • Run {run_id}" if run_id else "PulseOps"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "summary", True)
        print("  [Discord] Summary sent.")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] {e}")
        audit_log.write_discord_message(run_id, "summary", False, str(e))
        raise


# ── Daily audit summary ─────────────────────────────────────────────────────

def send_discord_summary(stats: dict, new_matches: list, run_id: str,
                         webhook_url: str | None = None,
                         settings: dict | None = None) -> bool:
    """Daily run summary with funnel stats, sent/queued/skipped breakdown."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    from pulseops_store import db_manager as db

    daily_cap = 5
    if settings:
        daily_cap = settings.get("guardrails", {}).get("daily_send_cap", 5)

    sent_today = db.get_outreach_count_today()
    queued_items = db.get_pending_queue_items(limit=10)
    since_run_start = datetime.now().strftime("%Y-%m-%dT00:00:00")
    replies_today = db.get_reply_count_since(since_run_start)

    sent_lines, skipped_lines = [], []
    for m in new_matches:
        decision = (m.get("send_decision") or {}).get("action", "")
        score, grade = m["score"], m.get("grade", "")
        company, title = m["company"], m["title"]
        contact = (m.get("eval_result") or {}).get("contact_email", "") or ""
        if decision == "SEND":
            target = f" → {contact}" if contact else ""
            sent_lines.append(f"[{grade}] {score}% — {company}, {title}{target}")
        elif decision == "SKIP":
            reason = (m.get("send_decision") or {}).get("reason", "")
            skipped_lines.append(f"{company} ({reason})" if reason else company)

    # Build embed fields
    fields = [
        {"name": "📊 Pipeline", "value": (
            f"**Sourced:** {stats.get('sourced', 0)}  →  "
            f"**Filtered:** {stats.get('after_soft_filter', 0)}  →  "
            f"**Evaluated:** {stats.get('evaluated', 0)}\n"
            f"**PDFs built:** {stats.get('matched_pdf', 0)}"
        ), "inline": False},
        {"name": f"📨 Sent Today ({sent_today}/{daily_cap})",
         "value": "\n".join(f"• {line}" for line in sent_lines) if sent_lines else "• None",
         "inline": False},
    ]

    if queued_items:
        queued_text = "\n".join(
            f"• {q['job_company']} — {q['job_title']} ({q.get('reason', '')[:40]})"
            for q in queued_items[:5]
        )
        fields.append({"name": f"⏳ Queued ({len(queued_items)})", "value": queued_text, "inline": False})

    if skipped_lines:
        skipped_text = "\n".join(f"• {line}" for line in skipped_lines[:8])
        fields.append({"name": "⏭ Skipped This Run", "value": skipped_text, "inline": False})

    footer_parts = [f"📬 Replies: {replies_today}", f"🔋 Cap: {sent_today}/{daily_cap}"]
    if stats.get("tokens_used"):
        footer_parts.append(f"🧮 Tokens: {stats['tokens_used']}")
    if stats.get("duration_seconds") is not None:
        footer_parts.append(f"⏱ {stats['duration_seconds']}s")

    embeds = [{
        "title": f"🚀 PulseOps — Daily Run Complete [{run_id}]",
        "color": COLOR_SUCCESS,
        "fields": fields,
        "footer": {"text": " • ".join(footer_parts)},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "audit_summary", True)
        print("  [Discord] Audit summary sent.")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] {e}")
        audit_log.write_discord_message(run_id, "audit_summary", False, str(e))
        raise


# ── Per-job match card ──────────────────────────────────────────────────────

def send_discord_match_card(job: dict, eval_result: dict, send_decision: dict | None,
                            pdf_path: str = "", webhook_url: str | None = None,
                            run_id: str = "") -> bool:
    """Rich embed for a single job match: score, analysis, skill gap, DM draft, STAR preview."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    title   = job.get("title", "Unknown")
    company = job.get("company", "Unknown")
    link    = job.get("link", "")
    score   = eval_result.get("match_percentage", 0)
    grade   = eval_result.get("letter_grade", "")
    summary = eval_result.get("text_summary", "")
    skill_gap = eval_result.get("skill_gap", []) or []
    recruiter_message = eval_result.get("recruiter_message", "")
    contact_email = eval_result.get("contact_email", "")

    # Title and color
    embed_title = f"[{grade}] {score}% — {title}"
    color = _grade_color(grade)

    fields = []

    # Company + link
    company_text = f"**{company}**"
    if link:
        company_text += f" — [Listing]({link})"
    fields.append({"name": "🏢 Company", "value": company_text, "inline": False})

    # Summary
    if summary:
        fields.append({"name": "📝 Analysis", "value": _truncate(summary, MAX_FIELD_VALUE), "inline": False})

    # Skill gap
    if skill_gap:
        gap_text = "\n".join(f"• {s}" for s in skill_gap[:6])
        fields.append({"name": "⚠️ Skill Gap", "value": _truncate(gap_text, MAX_FIELD_VALUE), "inline": True})

    # Contact
    if contact_email:
        fields.append({"name": "📧 Contact", "value": contact_email, "inline": True})

    # Send decision
    if send_decision:
        action = send_decision.get("action", "")
        reason = send_decision.get("reason", "")
        icon = {"SEND": "✅", "QUEUE": "⏳", "SKIP": "⏭"}.get(action, "•")
        decision_text = f"{icon} **{action}**"
        if reason:
            decision_text += f" — {reason}"
        fields.append({"name": "Send Decision", "value": _truncate(decision_text, MAX_FIELD_VALUE), "inline": False})

    # LinkedIn DM draft
    if recruiter_message:
        dm_clean = _truncate(_strip_html(recruiter_message), MAX_FIELD_VALUE)
        fields.append({"name": "💬 LinkedIn DM Draft", "value": f"```\n{dm_clean}\n```", "inline": False})

    # STAR+R preview for A/B grades
    if grade in ("A", "B"):
        star_stories = eval_result.get("star_stories", []) or []
        if star_stories:
            s = star_stories[0]
            q = (s.get("question") or "").strip()
            a = (s.get("answer") or "").strip()[:400]
            if q and a:
                star_text = f"**{q}**\n{a}" + ("…" if len(s.get("answer", "")) > 400 else "")
                fields.append({
                    "name": "⭐ STAR+R Preview",
                    "value": _truncate(star_text, MAX_FIELD_VALUE),
                    "inline": False,
                })

    embeds = [{
        "title": _truncate(embed_title, 256),
        "url": link if link else None,
        "color": color,
        "fields": fields[:MAX_FIELDS],
        "footer": {"text": f"PulseOps • {grade} Grade • {score}% match"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        # Send embed
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})

        # Attach PDF if available
        if pdf_path and os.path.exists(pdf_path):
            try:
                _post_webhook(
                    webhook_id, webhook_token,
                    {"content": f"📄 **{company} — {title}** resume:"},
                    files={"file": (os.path.basename(pdf_path), open(pdf_path, "rb"), "application/pdf")},
                )
            except Exception as e:
                print(f"  [Discord] PDF attachment failed (non-fatal): {e}")

        audit_log.write_discord_message(run_id, "match_card", True, f"{company}/{title}")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] match card for {company}/{title}: {e}")
        audit_log.write_discord_message(run_id, "match_card", False, str(e))
        raise


# ── Source health alert (non-negotiable #6) ────────────────────────────────

def send_discord_source_health_alert(source_name: str, consecutive: int,
                                     webhook_url: str | None = None,
                                     run_id: str = "") -> bool:
    """Alert when a source returns 0 jobs for 3+ consecutive runs."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    embeds = [{
        "title": "⚠️ Source Health Alert",
        "color": COLOR_WARN,
        "fields": [
            {"name": "🔌 Source", "value": f"**{source_name}**", "inline": True},
            {"name": "📉 Consecutive Zero Runs", "value": f"**{consecutive}**", "inline": True},
            {"name": "Action Required", "value": (
                f"This source has returned 0 jobs for **{consecutive} runs** in a row. "
                "Check API keys, query config, and rate limits."
            ), "inline": False},
        ],
        "footer": {"text": f"PulseOps • Run {run_id}" if run_id else "PulseOps"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "source_health_alert", True, source_name)
        return True
    except TelegramError as e:
        print(f"  [Discord Error] source health alert: {e}")
        audit_log.write_discord_message(run_id, "source_health_alert", False, str(e))
        raise


# ── Referral alert (G4) ────────────────────────────────────────────────────

def send_discord_referral_alert(company: str, title: str, contact: dict,
                                webhook_url: str | None = None,
                                run_id: str = "") -> bool:
    """G4: a contact exists at this company — cold email blocked, referral suggested."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    name = contact.get("name", "Unknown")
    relationship = contact.get("relationship", "")
    linkedin = contact.get("linkedin", "")
    notes = contact.get("notes", "")
    last_contact = contact.get("last_contact", "")

    fields = [
        {"name": "💼 Role", "value": title, "inline": False},
        {"name": "🏢 Company", "value": company, "inline": False},
    ]

    contact_text = f"**{name}**"
    if relationship:
        contact_text += f" ({relationship})"
    fields.append({"name": "🤝 Contact", "value": contact_text, "inline": False})

    if linkedin:
        fields.append({"name": "🔗 LinkedIn", "value": f"[Profile]({linkedin})", "inline": True})
    if last_contact:
        fields.append({"name": "📅 Last Contact", "value": last_contact, "inline": True})
    if notes:
        fields.append({"name": "📝 Notes", "value": _truncate(notes, MAX_FIELD_VALUE), "inline": False})

    # Copy-paste referral message
    first_name = name.split()[0] if " " in name else name
    referral_msg = (
        f"Hey {first_name}, hope you're doing well! "
        f"I saw {company} is hiring for {title} and thought I'd reach out. "
        "Would you be open to a referral or sharing any tips about the role? "
        "Happy to send my resume over. Thanks!"
    )
    fields.append({
        "name": "📝 Copy-Paste This",
        "value": f"```\n{referral_msg}\n```",
        "inline": False,
    })

    embeds = [{
        "title": "👋 Referral Opportunity — Cold Email Skipped",
        "color": COLOR_WARN,
        "fields": fields[:MAX_FIELDS],
        "description": (
            "A direct referral converts far better than a cold email. "
            "G4 blocked the automated send."
        ),
        "footer": {"text": f"PulseOps • Run {run_id}" if run_id else "PulseOps"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "referral_alert", True, f"{company}/{name}")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] referral alert: {e}")
        audit_log.write_discord_message(run_id, "referral_alert", False, str(e))
        raise


# ── Reply alert ─────────────────────────────────────────────────────────────

def send_discord_reply_alert(reply: dict, webhook_url: str | None = None,
                             run_id: str = "") -> bool:
    """New recruiter reply detected via IMAP."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    fields = [
        {"name": "📧 From", "value": reply.get("sender_email", "Unknown"), "inline": False},
        {"name": "📝 Subject", "value": reply.get("subject", ""), "inline": False},
        {"name": "📅 Received", "value": reply.get("received_at", ""), "inline": True},
    ]

    snippet = reply.get("snippet", "")[:300]
    if snippet:
        fields.append({"name": "💬 Preview", "value": f"*\"{snippet}\"*", "inline": False})

    embeds = [{
        "title": "🎉 Recruiter Reply Detected!",
        "color": COLOR_SUCCESS,
        "fields": fields,
        "description": "Check your inbox soon!",
        "footer": {"text": f"PulseOps • Run {run_id}" if run_id else "PulseOps"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "reply_alert", True, reply.get("sender_email", ""))
        return True
    except TelegramError as e:
        print(f"  [Discord Error] reply alert: {e}")
        audit_log.write_discord_message(run_id, "reply_alert", False, str(e))
        raise


# ── Interview prep pack ────────────────────────────────────────────────────

def send_discord_prep_pack(company: str, title: str, star_stories: list,
                           comp_research: str, negotiation_notes: str,
                           skill_gap: list, level_strategy: str = "",
                           webhook_url: str | None = None,
                           run_id: str = "") -> bool:
    """Full interview prep pack triggered at phone_screen stage."""
    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    fields = []

    if level_strategy:
        fields.append({"name": "🎯 Level Strategy", "value": _truncate(level_strategy, MAX_FIELD_VALUE), "inline": False})

    if star_stories:
        for i, s in enumerate(star_stories[:3], 1):
            q = (s.get("question") or "").strip()
            a = (s.get("answer") or "").strip()
            if q and a:
                story_text = f"**{q}**\n{_truncate(a, 800)}"
                fields.append({"name": f"⭐ Story {i}", "value": story_text, "inline": False})

    if comp_research:
        fields.append({"name": "💰 Comp Research", "value": _truncate(comp_research, MAX_FIELD_VALUE), "inline": False})

    if negotiation_notes:
        fields.append({"name": "🤝 Negotiation Notes", "value": _truncate(negotiation_notes, MAX_FIELD_VALUE), "inline": False})

    if skill_gap:
        gap = ", ".join(skill_gap[:6])
        fields.append({"name": "⚠️ Skill Gap", "value": gap, "inline": False})

    embeds = [{
        "title": f"🎙️ Interview Prep — {title} @ {company}",
        "color": COLOR_INFO,
        "fields": fields[:MAX_FIELDS],
        "footer": {"text": f"PulseOps • Run {run_id}" if run_id else "PulseOps"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "prep_pack", True, f"{company}/{title}")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] prep pack: {e}")
        audit_log.write_discord_message(run_id, "prep_pack", False, str(e))
        raise


# ── Weekly digest ───────────────────────────────────────────────────────────

def send_discord_weekly_digest(webhook_url: str | None = None,
                               run_id: str = "") -> bool:
    """Build and send the weekly digest to Discord."""
    from datetime import timedelta

    from pulseops_notify.weekly_digest import build_digest

    since = (datetime.now() - timedelta(days=7)).isoformat()
    message = build_digest(since)

    clean = _strip_html(message)

    embeds = [{
        "title": "📋 PulseOps — Weekly Digest",
        "description": _truncate(clean, MAX_EMBED_DESCRIPTION),
        "color": COLOR_INFO,
        "footer": {"text": "PulseOps weekly digest • Next run: Sunday 09:00 IST"},
        "timestamp": datetime.utcnow().isoformat(),
    }]

    creds = _get_webhook_credentials(webhook_url)
    if not creds:
        return False
    webhook_id, webhook_token = creds

    try:
        _post_webhook(webhook_id, webhook_token, {"embeds": embeds})
        audit_log.write_discord_message(run_id, "weekly_digest", True)
        print("  [Discord] Weekly digest sent.")
        return True
    except TelegramError as e:
        print(f"  [Discord Error] weekly digest: {e}")
        audit_log.write_discord_message(run_id, "weekly_digest", False, str(e))
        raise
