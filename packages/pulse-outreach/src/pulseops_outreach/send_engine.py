"""
outreach/send_engine.py — All 10 send guardrails (PulseOps Phase 7)

Spec (exact order, fail-fast):
  G1  ScoreCheck            score >= SEND_THRESHOLD (88)
  G2  SemanticDuplicateCheck not already applied to this role
  G3  BlacklistCheck        company/domain not in blacklist.txt
  G4  ReferralCheck         no contact at company → SKIP + Telegram alert
  G5  CooldownCheck         company not contacted in last 30 days
  G6  DomainLimitCheck      company domain < 2 emails today
  G7  DailyCapCheck         total sends today < 5  → QUEUE (not SKIP)
  G8  SendWindowCheck       current time within 09:00-18:00 IST → QUEUE (not SKIP)
  G9  BounceCheck           domain not bounce-paused
  G10 ContactEmailCheck     contact email found OR domain inferred

Return value:
  {"action": "SEND"|"QUEUE"|"SKIP", "reason": str, "guardrail": str|None}

Actions:
  SEND  — all guardrails passed, email has been sent (or simulated)
  QUEUE — capped/window blocked; enqueued for next run at score priority
  SKIP  — permanent block this run (logged, never retried for this job)

Error contract:
  decide_send() never raises — catches all exceptions and returns SKIP with reason.
  Individual _check_*() functions may raise typed SendGuardrailError subclasses;
  these are caught and translated to the appropriate action in decide_send().
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from pulseops_core.exceptions import (
    BlacklistMatchError, BounceThresholdReachedError, CooldownActiveError,
    DailyCapReachedError, DomainDailyLimitError, NoContactEmailError,
    OutsideSendWindowError, ReferralContactExistsError, ScoreBelowThresholdError,
    SemanticDuplicateError, SendGuardrailError,
)
from pulseops_store import audit_log
from pulseops_store import db_manager as db

ROOT = Path(__file__).resolve().parent.parent


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_blacklist() -> list[str]:
    p = ROOT / "config" / "blacklist.txt"
    if not p.exists():
        return []
    return [
        line.strip().lower()
        for line in p.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _load_contacts() -> list[dict]:
    p = ROOT / "config" / "contacts.yml"
    if not p.exists():
        return []
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        return data.get("contacts", [])
    except Exception:
        return []


def _normalise(name: str) -> str:
    return db.normalise_company(name)


def _infer_domain(eval_result: dict, company: str) -> str:
    """Returns best-guess domain string (may be low-confidence)."""
    explicit = eval_result.get("inferred_domain", "")
    if explicit:
        return explicit.strip().lower()
    # Slugify company name as last resort
    slug = re.sub(r"[^a-z0-9]", "", company.lower())
    return f"{slug}.com"


def _current_ist() -> datetime:
    try:
        return datetime.now(ZoneInfo("Asia/Kolkata"))
    except Exception:
        return datetime.now()


# ── Individual guardrail checks ───────────────────────────────────────────────

def _check_g1_score(score: int, threshold: int) -> None:
    if score < threshold:
        raise ScoreBelowThresholdError(
            f"G1: score {score} < threshold {threshold}"
        )


def _check_g2_duplicate(job_id: int, company: str, title: str) -> None:
    """
    Semantic duplicate: already sent to this (company, title) combo.
    Uses outreach table: if a 'sent' row exists for same company_normalised
    AND the job titles overlap ≥70%, it's a duplicate.
    """
    norm = _normalise(company)
    recent = db.get_recent_outreach(days=365)  # full history
    for row in recent:
        if row.get("status") != "sent":
            continue
        if row.get("company_normalised", "") != norm:
            continue
        # Title token overlap
        title_words = set(title.lower().split())
        row_title   = (row.get("job_title") or "").lower().split()
        if not row_title:
            continue
        overlap = len(title_words & set(row_title)) / max(len(title_words | set(row_title)), 1)
        if overlap >= 0.70:
            raise SemanticDuplicateError(
                f"G2: already applied to '{title}' at {company} (overlap {overlap:.0%})"
            )


def _check_g3_blacklist(company: str, domain: str) -> None:
    entries = _load_blacklist()
    company_l = company.lower()
    domain_l  = domain.lower()
    for entry in entries:
        if entry in company_l or entry in domain_l:
            raise BlacklistMatchError(f"G3: '{entry}' matched blacklist for {company}/{domain}")


def _check_g4_referral(company: str) -> dict | None:
    """
    Returns the matching contact dict if one exists (caller fires Telegram alert).
    Raises ReferralContactExistsError.
    """
    contacts = _load_contacts()
    norm     = _normalise(company)
    for contact in contacts:
        c_company = _normalise(contact.get("company", ""))
        c_domain  = contact.get("domain", "").lower()
        if c_company == norm or c_domain in company.lower():
            raise ReferralContactExistsError(
                f"G4: contact '{contact.get('name')}' exists at {company} — use referral instead"
            )
    return None


def _check_g5_cooldown(company: str, cooldown_days: int) -> None:
    norm    = _normalise(company)
    last    = db.get_last_outreach_for_company(norm)
    if not last:
        return
    sent_at_str = last.get("sent_at", "")
    if not sent_at_str:
        return
    try:
        sent_at = datetime.fromisoformat(sent_at_str)
        # Normalise both sides to naive-comparable UTC offsets: if sent_at has
        # no tzinfo (written by an older DB row) compare naive-to-naive in IST,
        # otherwise strip tzinfo after converting to IST.
        now_ist = _current_ist()
        if sent_at.tzinfo is None:
            now_cmp = datetime(now_ist.year, now_ist.month, now_ist.day,
                               now_ist.hour, now_ist.minute, now_ist.second)
        else:
            now_cmp = now_ist.replace(tzinfo=None)
            sent_at = sent_at.astimezone(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)
        if now_cmp - sent_at < timedelta(days=cooldown_days):
            days_left = cooldown_days - (now_cmp - sent_at).days
            raise CooldownActiveError(
                f"G5: {company} contacted {(now_cmp - sent_at).days}d ago "
                f"(cooldown {cooldown_days}d, {days_left}d remaining)"
            )
    except ValueError:
        pass  # unparseable date — allow send


def _check_g6_domain_limit(domain: str, limit: int) -> None:
    count = db.get_outreach_count_for_domain_today(domain)
    if count >= limit:
        raise DomainDailyLimitError(
            f"G6: domain '{domain}' already received {count}/{limit} emails today"
        )


def _check_g7_daily_cap(cap: int) -> None:
    count = db.get_outreach_count_today()
    if count >= cap:
        raise DailyCapReachedError(
            f"G7: daily cap reached ({count}/{cap} sends today)"
        )


def _check_g8_send_window(start_str: str, end_str: str, tz_name: str) -> None:
    now = _current_ist()
    try:
        start = now.replace(hour=int(start_str.split(":")[0]),
                             minute=int(start_str.split(":")[1]), second=0, microsecond=0)
        end   = now.replace(hour=int(end_str.split(":")[0]),
                             minute=int(end_str.split(":")[1]), second=0, microsecond=0)
        if not (start <= now <= end):
            raise OutsideSendWindowError(
                f"G8: current time {now.strftime('%H:%M')} IST is outside "
                f"send window {start_str}–{end_str}"
            )
    except (IndexError, ValueError) as e:
        pass  # malformed window config — allow send


def _check_g9_bounce(domain: str) -> None:
    recent   = db.get_recent_outreach(days=30)
    bounces  = sum(1 for r in recent if r.get("domain") == domain
                   and r.get("status") == "bounced")
    threshold = 2
    if bounces >= threshold:
        raise BounceThresholdReachedError(
            f"G9: domain '{domain}' has {bounces} bounces (threshold {threshold}) — paused"
        )


import re as _re

def _scrape_company_emails(domain: str, company: str = "") -> list[str]:
    """Scrape company homepage + /contact /careers /about for info@ / careers@ / jobs@."""
    if not domain or "." not in domain or domain == "unknown.com":
        return []
    candidates = []
    for cand in [f"https://{domain}", f"https://www.{domain}", f"https://{domain}/contact", f"https://{domain}/careers", f"https://{domain}/about", f"https://{domain}/jobs"]:
        try:
            import requests
            r = requests.get(cand, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200 and len(r.text) > 800:
                for m in _re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+\.[a-z]{2,}", r.text, _re.IGNORECASE):
                    m_low = m.lower()
                    if any(k in m_low for k in ["info@", "careers@", "jobs@", "hr@", "contact@", "hiring@", "talent@", "recruit"]):
                        candidates.append(m)
                if candidates:
                    break
        except Exception:
            continue
    # dedupe, prefer info/careers/jobs/hr
    seen = set()
    ranked = []
    for e in candidates:
        if e.lower() not in seen:
            seen.add(e.lower())
            ranked.append(e)
    # prioritize
    def _pri(e: str) -> int:
        e_low = e.lower()
        if "careers@" in e_low: return 0
        if "jobs@" in e_low: return 1
        if "hiring@" in e_low: return 2
        if "hr@" in e_low: return 3
        if "info@" in e_low: return 4
        return 5
    ranked.sort(key=_pri)
    return ranked

def _linkedin_people_emails(company: str, domain: str) -> list[str]:
    """DEPRECATED (boss round-3): pattern generation disabled — always returns []."""
    return []
    if not company or not domain:
        return []
    candidates = []
    # 1. Scrape company site team/about for names
    for cand in [f"https://{domain}/team", f"https://{domain}/about", f"https://www.{domain}/team", f"https://{domain}/about-us"]:
        try:
            import requests
            r = requests.get(cand, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200 and len(r.text) > 1000:
                # Find names like "John Doe - CEO" near team section
                for m in _re.findall(r"([A-Z][a-z]+ [A-Z][a-z]+).*?(CEO|Founder|CTO|Recruiter|HR|Talent)", r.text):
                    name = m[0] if isinstance(m, tuple) else m
                    parts = name.lower().split()
                    if len(parts) >= 2:
                        # common patterns: firstname@, firstname.lastname@, f.lastname@
                        for pat in [f"{parts[0]}@{domain}", f"{parts[0]}.{parts[-1]}@{domain}", f"{parts[0][0]}.{parts[-1]}@{domain}"]:
                            candidates.append(pat)
                if candidates:
                    break
        except Exception:
            continue
    # 2. Fallback: generate for common founder patterns if no names found (use LinkedIn search hint)
    # We don't call LinkedIn API (needs auth) — generate plausible hiring contacts
    if not candidates and domain != "unknown.com":
        for prefix in ["hiring", "talent", "hr", "recruiting", "jobs", "founders"]:
            candidates.append(f"{prefix}@{domain}")
    return list(dict.fromkeys(candidates))[:3]

def _check_g10_contact(
    contact_email: str,
    domain: str,
    confidence: str,
    company: str = "",
    recruiter_email_draft: str = "",
    simulate: bool = False,
) -> str:
    """
    G10: Returns the best available email address to send to.

    Priority order (verified-only, boss round-2):
      1. Explicit email from JD text (LLM-extracted)
      2. Scrape company website for info@/careers@/jobs@/hr@ (real page)
      3. Raise NoContactEmailError (no pattern/contact@ guesses)
    """
    # Priority 1: explicit email found in JD
    if contact_email and "@" in contact_email:
        return contact_email.strip()

    # Priority 2: scrape company website for info@/careers@ etc. (your request: research company)
    scraped = _scrape_company_emails(domain, company)
    if scraped:
        print(f"  [G10] scraped company site: {scraped[0]} from {domain}")
        return scraped[0]

    raise NoContactEmailError(
        f"G10: no verified email found for '{company}' domain '{domain}' "
        f"(JD: none, Hunter.io: none/low-confidence)"
    )


# ── Email variant selection ──────────────────────────────────────────────────

def _select_variant() -> str:
    """Weighted random selection from email_variants table."""
    import random
    weights = db.get_variant_weights()
    variants = list(weights.keys())
    wvals    = [weights[v] for v in variants]
    return random.choices(variants, weights=wvals, k=1)[0]


# ── Main decide_send ─────────────────────────────────────────────────────────

def decide_send(
    job_id: int,
    job: dict,
    eval_result: dict,
    settings: dict,
    run_id: str = "",
    simulate: bool = False,
    pdf_path: str = "",
) -> dict:
    """
    Run all 10 guardrails in order. Returns {"action", "reason", "guardrail"}.
    Never raises — all exceptions are caught and translated to SKIP/QUEUE.
    """
    guardrails = settings.get("guardrails", {})
    scoring    = settings.get("scoring", {})

    send_threshold  = scoring.get("send_threshold",       88)
    cooldown_days   = guardrails.get("company_cooldown_days", 30)
    daily_cap       = guardrails.get("daily_send_cap",    5)
    domain_limit    = guardrails.get("domain_daily_limit", 2)
    window_start    = guardrails.get("send_window_start", "09:00")
    window_end      = guardrails.get("send_window_end",   "18:00")
    tz_name         = guardrails.get("send_timezone",     "Asia/Kolkata")
    min_gap         = guardrails.get("min_send_gap_minutes", 8)

    score          = eval_result.get("match_percentage", 0)
    company        = job.get("company", "")
    title          = job.get("title", "")
    contact_email  = eval_result.get("contact_email", "")
    recruiter_email_text = eval_result.get("recruiter_email", "")
    domain         = _infer_domain(eval_result, company)
    confidence     = eval_result.get("domain_confidence", "low")

    def _result(action: str, reason: str, guardrail: str | None = None) -> dict:
        return {"action": action, "reason": reason, "guardrail": guardrail}

    # ── G1: Score ────────────────────────────────────────────────────────
    try:
        _check_g1_score(score, send_threshold)
    except ScoreBelowThresholdError as e:
        return _result("SKIP", str(e), "G1")

    # ── G2: Semantic duplicate ────────────────────────────────────────────
    try:
        _check_g2_duplicate(job_id, company, title)
    except SemanticDuplicateError as e:
        return _result("SKIP", str(e), "G2")

    # ── G3: Blacklist ─────────────────────────────────────────────────────
    try:
        _check_g3_blacklist(company, domain)
    except BlacklistMatchError as e:
        return _result("SKIP", str(e), "G3")

    # ── G4: Referral ──────────────────────────────────────────────────────
    try:
        _check_g4_referral(company)
    except ReferralContactExistsError as e:
        # Fire Telegram referral alert (non-fatal if Telegram not configured)
        contacts = _load_contacts()
        norm = _normalise(company)
        contact_match = next(
            (c for c in contacts if _normalise(c.get("company","")) == norm), {}
        )
        try:
            from pulseops_notify.notifier import send_referral_alert
            send_referral_alert(company, title, contact_match, run_id=run_id)
        except Exception as te:
            print(f"  [!] Referral alert failed (non-fatal): {te}")
        return _result("SKIP", str(e), "G4")

    # ── G5: Cooldown ──────────────────────────────────────────────────────
    try:
        _check_g5_cooldown(company, cooldown_days)
    except CooldownActiveError as e:
        return _result("SKIP", str(e), "G5")

    # ── G6: Domain daily limit ────────────────────────────────────────────
    try:
        _check_g6_domain_limit(domain, domain_limit)
    except DomainDailyLimitError as e:
        return _result("SKIP", str(e), "G6")

    # ── G7: Daily cap → QUEUE (not SKIP) ─────────────────────────────────
    try:
        _check_g7_daily_cap(daily_cap)
    except DailyCapReachedError as e:
        return _result("QUEUE", str(e), "G7")

    # ── G8: Send window → QUEUE (not SKIP) ───────────────────────────────
    try:
        _check_g8_send_window(window_start, window_end, tz_name)
    except OutsideSendWindowError as e:
        return _result("QUEUE", str(e), "G8")

    # ── G9: Bounce pause ──────────────────────────────────────────────────
    try:
        _check_g9_bounce(domain)
    except BounceThresholdReachedError as e:
        return _result("SKIP", str(e), "G9")

    # ── G10: Contact email (+ Hunter.io fallback) ────────────────────────
    send_to: str = ""
    try:
        send_to = _check_g10_contact(
            contact_email=contact_email,
            domain=domain,
            confidence=confidence,
            company=company,
            recruiter_email_draft=recruiter_email_text,
            simulate=simulate,
        )
    except NoContactEmailError as e:
        return _result("SKIP", str(e), "G10")

    actual_to = send_to or contact_email
    if not actual_to:
        return _result("SKIP",
                       f"G10: no verified email address for '{company}' "
                       f"(domain '{domain}', confidence '{confidence}')", "G10")

    # ── All guardrails passed — SEND ─────────────────────────────────────
    variant = eval_result.get("email_variant_used") or _select_variant()

    if simulate:
        print(f"    [SendEngine/Sim] SEND → {actual_to} via {variant}")
        _record_send(job_id, company, domain, actual_to, recruiter_email_text,
                      variant, run_id, simulate=True)
        return _result("SEND", f"simulated → {actual_to}", None)

    # Live send
    try:
        from pulseops_outreach.email_sender import send_cold_email
        sent = send_cold_email(
            to_email=actual_to,
            email_text=recruiter_email_text,
            attachment_path=pdf_path,
            min_gap_minutes=min_gap,
            simulate=False,
        )
        if sent:
            _record_send(job_id, company, domain, actual_to, recruiter_email_text,
                          variant, run_id, simulate=False)
            return _result("SEND", f"sent → {actual_to}", None)
        else:
            # AUTO_SEND_EMAILS=false
            return _result("SKIP", "AUTO_SEND_EMAILS=false — send not enabled", None)
    except Exception as e:
        return _result("SKIP", f"SMTP failure: {e}", None)


def _record_send(job_id: int, company: str, domain: str, to_email: str,
                  email_text: str, variant: str, run_id: str, simulate: bool) -> None:
    """Persist outreach row and update variant stats after a successful send."""
    # Parse subject from email_text
    subject = "Application"
    if email_text:
        for line in email_text.splitlines():
            if line.lower().startswith("subject:"):
                subject = line.split(":", 1)[1].strip()
                break

    db.save_outreach(
        job_id=job_id, company=company, contact_email=to_email,
        subject=subject, body=email_text,
        status="sent" if not simulate else "simulated",
        email_variant=variant, domain=domain,
    )
    db.update_job_status(job_id, "Sent")
    try:
        db.record_variant_send(variant)
        # Recompute weights after every 10th send
        total = db.get_outreach_count_today()
        if total % 10 == 0:
            db.recompute_variant_weights()
    except Exception:
        pass
    audit_log.write_send_decision(run_id, company, "", "SEND",
                                   f"{'simulated' if simulate else 'live'} → {to_email}")
