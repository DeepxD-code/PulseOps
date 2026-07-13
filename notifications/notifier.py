"""
notifications/notifier.py — Telegram dispatcher (PulseOps Phase 9)

Telegram is the primary interface for the headless pipeline. This module
sends:
  - send_audit_summary   — "Telegram Audit Mode" daily run summary
  - send_match_card      — per-job match card (score, AI analysis, PDF)
  - send_source_health_alert — non-negotiable #6, 3 consecutive zeros
  - send_referral_alert  — G4 referral check fired (contact exists)
  - send_reply_alert     — new recruiter reply detected
  - send_prep_pack       — interview prep pack (phone_screen trigger)
  - send_telegram_summary — generic HTML message (weekly digest, etc.)

Return convention:
  - False  -> Telegram not configured (no token/chat_id). Non-fatal, no
              exception — this is a config state, not a failure.
  - True   -> message (and attachment, if any) sent successfully.
  - raises TelegramError -> Telegram WAS configured but the API call failed.
              Per exceptions.py this is non-fatal; callers catch it and
              continue the pipeline (audit_log records the attempt either way).
"""

import os
import html
import requests
from datetime import datetime

from exceptions import TelegramError
from persistence import audit_log

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
MAX_MESSAGE_LEN = 4000


def _credentials(bot_token: str | None, chat_id: str | None) -> tuple[str, str] | None:
    token = bot_token or os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat = chat_id or os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        print("  [Telegram] Not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Skipping.")
        return None
    return token, chat


def _truncate(msg: str) -> str:
    if len(msg) > MAX_MESSAGE_LEN:
        return msg[:MAX_MESSAGE_LEN - 60] + "\n\n<i>[Truncated for length]</i>"
    return msg


def _post(token: str, method: str, **kwargs) -> requests.Response:
    url = TELEGRAM_API.format(token=token, method=method)
    try:
        return requests.post(url, timeout=kwargs.pop("timeout", 15), **kwargs)
    except requests.RequestException as e:
        raise TelegramError(f"Telegram '{method}' request failed: {e}") from e


def _safe_json(resp: requests.Response) -> dict:
    """
    Telegram normally returns JSON, but a blocked egress proxy, DNS failure
    page, or 5xx can return HTML/empty bodies. Never let .json() crash —
    fold any non-JSON response into a TelegramError with useful context.
    """
    try:
        return resp.json()
    except ValueError as e:
        snippet = (resp.text or "")[:200].replace("\n", " ")
        raise TelegramError(
            f"Non-JSON response (HTTP {resp.status_code}): {snippet or 'empty body'}"
        ) from e


def _send_html(token: str, chat: str, message: str) -> bool:
    resp = _post(token, "sendMessage", json={
        "chat_id": chat, "text": _truncate(message),
        "parse_mode": "HTML", "disable_web_page_preview": False,
    })
    data = _safe_json(resp)
    if resp.status_code == 200 and data.get("ok"):
        return True
    raise TelegramError(f"sendMessage rejected (HTTP {resp.status_code}): "
                         f"{data.get('description', resp.text)}")


def _send_document(token: str, chat: str, file_path: str, caption: str = "") -> bool:
    if not file_path or not os.path.exists(file_path):
        raise TelegramError(f"PDF not found at {file_path}")
    with open(file_path, "rb") as f:
        resp = _post(
            token, "sendDocument",
            data={"chat_id": chat, "caption": caption[:1024], "parse_mode": "HTML"},
            files={"document": (os.path.basename(file_path), f, "application/pdf")},
            timeout=30,
        )
    data = _safe_json(resp)
    if resp.status_code == 200 and data.get("ok"):
        return True
    raise TelegramError(f"sendDocument rejected (HTTP {resp.status_code}): "
                         f"{data.get('description', resp.text)}")


# ── Generic summary (weekly digest, system messages) ───────────────────────

def send_telegram_summary(summary_text: str, bot_token: str | None = None,
                           chat_id: str | None = None, run_id: str = "") -> bool:
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds
    try:
        ok = _send_html(token, chat, summary_text)
        audit_log.write_telegram_message(run_id, "summary", ok)
        print("  [Telegram] Summary sent.")
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] {e}")
        audit_log.write_telegram_message(run_id, "summary", False, str(e))
        raise


# ── Daily audit summary ──────────────────────────────────────────────────────

def send_audit_summary(stats: dict, new_matches: list, run_id: str,
                        bot_token: str | None = None, chat_id: str | None = None,
                        settings: dict | None = None) -> bool:
    """
    Renders the 'Telegram Audit Mode' summary:
      🚀 PulseOps — Daily Run Complete
      📨 Sent Today (n/cap)
      • [grade] score% — Company, Title → contact_email
      ⏳ Queued (n)
      ⏭ Skipped: ...
      📬 Replies: n
      🔋 Cap: n/cap used today
    """
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds

    from persistence import db_manager as db

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
        company, title = html.escape(m["company"]), html.escape(m["title"])
        contact = html.escape((m.get("eval_result") or {}).get("contact_email", "") or "")
        if decision == "SEND":
            target = f" → {contact}" if contact else ""
            sent_lines.append(f"• [{grade}] {score}% — {company}, {title}{target}")
        elif decision == "SKIP":
            reason = html.escape((m.get("send_decision") or {}).get("reason", ""))
            skipped_lines.append(f"• {company} ({reason})" if reason else f"• {company}")

    lines = [
        f"🚀 <b>PulseOps — Daily Run Complete</b> <code>[{run_id}]</code>",
        "====================================",
        f"📊 Sourced: <b>{stats.get('sourced', 0)}</b>  "
        f"→ Filtered: <b>{stats.get('after_soft_filter', 0)}</b>  "
        f"→ Evaluated: <b>{stats.get('evaluated', 0)}</b>",
        f"📁 PDFs built: <b>{stats.get('matched_pdf', 0)}</b>",
        "====================================",
        f"📨 <b>Sent Today ({sent_today}/{daily_cap})</b>",
    ]
    lines += sent_lines if sent_lines else ["• None"]

    if queued_items:
        lines.append("====================================")
        lines.append(f"⏳ <b>Queued ({len(queued_items)})</b> — processed next run")
        for q in queued_items[:5]:
            lines.append(f"• {html.escape(q['job_company'])} — {html.escape(q['job_title'])} "
                         f"({html.escape(q.get('reason','')[:40])})")

    if skipped_lines:
        lines.append("====================================")
        lines.append(f"⏭ <b>Skipped this run</b>")
        lines += skipped_lines[:8]

    lines.append("====================================")
    lines.append(f"📬 Replies today: <b>{replies_today}</b>")
    lines.append(f"🔋 Cap: <b>{sent_today}/{daily_cap}</b> used today")
    if stats.get("tokens_used"):
        lines.append(f"🧮 LLM tokens used: <b>{stats['tokens_used']}</b>")
    if stats.get("duration_seconds") is not None:
        lines.append(f"⏱ Duration: <b>{stats['duration_seconds']}s</b>")

    message = "\n".join(lines)
    try:
        ok = _send_html(token, chat, message)
        audit_log.write_telegram_message(run_id, "audit_summary", ok)
        print("  [Telegram] Audit summary sent.")
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] {e}")
        audit_log.write_telegram_message(run_id, "audit_summary", False, str(e))
        raise


# ── Per-job match card ───────────────────────────────────────────────────────

def send_match_card(job: dict, eval_result: dict, send_decision: dict | None,
                     pdf_path: str = "", bot_token: str | None = None,
                     chat_id: str | None = None, run_id: str = "") -> bool:
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds

    title   = html.escape(job.get("title", "Unknown"))
    company = html.escape(job.get("company", "Unknown"))
    link    = job.get("link", "")
    escaped_link = html.escape(link) if link else ""
    score   = eval_result.get("match_percentage", 0)
    grade   = eval_result.get("letter_grade", "")
    summary = eval_result.get("text_summary", "")
    skill_gap = eval_result.get("skill_gap", []) or []
    recruiter_message = eval_result.get("recruiter_message", "")
    contact_email = eval_result.get("contact_email", "")

    lines = [
        f"📊 <b>[{grade}] {score}%</b> — {title}",
        f"🏢 <b>{company}</b>" + (f" — <a href=\"{escaped_link}\">Listing</a>" if escaped_link else ""),
        "====================================",
        f"📝 <i>{html.escape(summary)}</i>" if summary else "",
    ]
    if skill_gap:
        gap_lines = "\n".join(f"• {html.escape(s)}" for s in skill_gap[:6])
        lines += ["====================================", "⚠️ <b>Skill Gap:</b>", gap_lines]
    if recruiter_message:
        lines += ["====================================",
                   f"💬 <b>LinkedIn DM:</b>\n<code>{html.escape(recruiter_message)}</code>"]
    if contact_email:
        lines += ["====================================", f"📧 Contact: {html.escape(contact_email)}"]

    if send_decision:
        action = send_decision.get("action", "")
        reason = send_decision.get("reason", "")
        icon = {"SEND": "✅", "QUEUE": "⏳", "SKIP": "⏭"}.get(action, "•")
        lines += ["====================================",
                   f"{icon} <b>Send decision:</b> {action}" + (f" — {html.escape(reason)}" if reason else "")]

    # Early STAR+R preview for A/B grades — just the first story so it's scannable.
    # The full prep pack (all stories + comp + negotiation) fires separately at phone_screen.
    if grade in ("A", "B"):
        star_stories = eval_result.get("star_stories", []) or []
        if star_stories:
            s = star_stories[0]
            q = html.escape((s.get("question") or "").strip())
            a = html.escape((s.get("answer") or "").strip()[:400])
            if q and a:
                lines += [
                    "====================================",
                    "⭐ <b>STAR+R preview</b> <i>(full pack at phone_screen)</i>",
                    f"<b>{q}</b>",
                    a + ("…" if len(s.get("answer", "")) > 400 else ""),
                ]

    message = "\n".join(line for line in lines if line)

    try:
        ok = _send_html(token, chat, message)
        if pdf_path and os.path.exists(pdf_path):
            _send_document(token, chat, pdf_path, caption=f"{company} — {title}")
        audit_log.write_telegram_message(run_id, "match_card", ok, f"{company}/{title}")
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] match card for {company}/{title}: {e}")
        audit_log.write_telegram_message(run_id, "match_card", False, str(e))
        raise


# ── Source health alert (non-negotiable #6) ────────────────────────────────

def send_source_health_alert(source_name: str, consecutive: int,
                               bot_token: str | None = None, chat_id: str | None = None,
                               run_id: str = "") -> bool:
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds
    message = (
        f"⚠️ <b>Source Health Alert</b>\n"
        f"====================================\n"
        f"🔌 Source: <b>{html.escape(source_name)}</b>\n"
        f"📉 Consecutive zero-result runs: <b>{consecutive}</b>\n"
        f"====================================\n"
        f"<i>This source has returned 0 jobs for {consecutive} runs in a row. "
        f"Check API keys, query config, and rate limits.</i>"
    )
    try:
        ok = _send_html(token, chat, message)
        audit_log.write_telegram_message(run_id, "source_health_alert", ok, source_name)
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] source health alert: {e}")
        audit_log.write_telegram_message(run_id, "source_health_alert", False, str(e))
        raise


# ── Referral alert (G4) ──────────────────────────────────────────────────────

def send_referral_alert(company: str, title: str, contact: dict,
                         bot_token: str | None = None, chat_id: str | None = None,
                         run_id: str = "") -> bool:
    """G4: a contact exists at this company — cold email blocked, referral suggested instead."""
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds

    name = html.escape(contact.get("name", "Unknown"))
    relationship = html.escape(contact.get("relationship", ""))
    linkedin = contact.get("linkedin", "")
    notes = html.escape(contact.get("notes", ""))
    last_contact = html.escape(contact.get("last_contact", ""))

    message = (
        f"👋 <b>Referral Opportunity — Cold Email Skipped</b>\n"
        f"====================================\n"
        f"💼 <b>Role:</b> {html.escape(title)}\n"
        f"🏢 <b>Company:</b> {html.escape(company)}\n"
        f"====================================\n"
        f"🤝 <b>You know:</b> {name}" + (f" ({relationship})" if relationship else "") + "\n"
    )
    if linkedin:
        message += f"🔗 <a href=\"{html.escape(linkedin)}\">LinkedIn profile</a>\n"
    if last_contact:
        message += f"📅 Last contact: {last_contact}\n"
    if notes:
        message += f"📝 {notes}\n"

    # Generate an immediately-actionable referral request they can copy-paste
    first_name = name.split()[0] if " " in name else name
    message += (
        "====================================\n"
        "<i>A direct referral converts far better than a cold email. "
        "Reach out to this contact instead \u2014 G4 blocked the automated send.</i>\n"
        "====================================\n"
        "📝 <b>Copy-paste this to them:</b>\n"
        f"<code>Hey {first_name}, hope you're doing well! "
        f"I saw {html.escape(company)} is hiring for {html.escape(title)} and thought I'd reach out. "
        "Would you be open to a referral or sharing any tips about the role? "
        "Happy to send my resume over. Thanks!</code>"
    )

    try:
        ok = _send_html(token, chat, message)
        audit_log.write_telegram_message(run_id, "referral_alert", ok, f"{company}/{name}")
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] referral alert: {e}")
        audit_log.write_telegram_message(run_id, "referral_alert", False, str(e))
        raise


# ── Reply alert ──────────────────────────────────────────────────────────────

def send_reply_alert(reply: dict, bot_token: str | None = None,
                      chat_id: str | None = None, run_id: str = "") -> bool:
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds

    message = (
        f"🎉 <b>Recruiter Reply Detected!</b>\n"
        f"====================================\n"
        f"📧 <b>From:</b> {html.escape(reply['sender_email'])}\n"
        f"📝 <b>Subject:</b> {html.escape(reply['subject'])}\n"
        f"📅 <b>Received:</b> {html.escape(reply['received_at'])}\n"
        f"====================================\n"
        f"💬 <b>Preview:</b>\n<i>\"{html.escape(reply.get('snippet','')[:300])}\"</i>\n"
        f"====================================\n"
        f"⚠️ <i>Reply in your inbox soon!</i>"
    )
    try:
        ok = _send_html(token, chat, message)
        audit_log.write_telegram_message(run_id, "reply_alert", ok, reply["sender_email"])
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] reply alert: {e}")
        audit_log.write_telegram_message(run_id, "reply_alert", False, str(e))
        raise


# ── Interview prep pack ─────────────────────────────────────────────────────

def send_prep_pack(company: str, title: str, star_stories: list, comp_research: str,
                    negotiation_notes: str, skill_gap: list, level_strategy: str = "",
                    bot_token: str | None = None, chat_id: str | None = None,
                    run_id: str = "") -> bool:
    """Triggered when outcome.stage == 'phone_screen'. Delivers prep pack to Telegram."""
    creds = _credentials(bot_token, chat_id)
    if not creds:
        return False
    token, chat = creds

    lines = [
        f"🎙️ <b>Interview Prep Pack</b>",
        f"💼 {html.escape(title)} @ <b>{html.escape(company)}</b>",
        "====================================",
    ]
    if level_strategy:
        lines += [f"🎯 <b>Level Strategy:</b>\n<i>{html.escape(level_strategy)}</i>", "===================================="]
    if star_stories:
        lines.append("⭐ <b>STAR+R Stories:</b>")
        for i, s in enumerate(star_stories[:3], 1):
            q = html.escape(s.get("question", ""))
            a = html.escape(s.get("answer", ""))
            lines.append(f"\n<b>{i}. {q}</b>\n{a}")
        lines.append("====================================")
    if comp_research:
        lines += [f"💰 <b>Comp Research:</b>\n{html.escape(comp_research)}", "===================================="]
    if negotiation_notes:
        lines += [f"🤝 <b>Negotiation Notes:</b>\n{html.escape(negotiation_notes)}", "===================================="]
    if skill_gap:
        gap = ", ".join(html.escape(s) for s in skill_gap[:6])
        lines.append(f"⚠️ <b>Skill Gap to address:</b> {gap}")

    message = "\n".join(lines)
    try:
        ok = _send_html(token, chat, message)
        audit_log.write_prep_pack_sent(run_id, company, title)
        audit_log.write_telegram_message(run_id, "prep_pack", ok, f"{company}/{title}")
        return ok
    except TelegramError as e:
        print(f"  [Telegram Error] prep pack: {e}")
        audit_log.write_telegram_message(run_id, "prep_pack", False, str(e))
        raise
