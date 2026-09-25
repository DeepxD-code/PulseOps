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

import json
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from pulseops_core import scraper as _scraper_policy
from pulseops_core.exceptions import (
    BlacklistMatchError,
    BounceThresholdReachedError,
    CooldownActiveError,
    DailyCapReachedError,
    DomainDailyLimitError,
    NoContactEmailError,
    OutsideSendWindowError,
    ReferralContactExistsError,
    ScoreBelowThresholdError,
    SemanticDuplicateError,
)
from pulseops_store import audit_log
from pulseops_store import db_manager as db

from pulseops_outreach.email_sender import is_untrusted_domain

try:
    from pulseops_config.paths import repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parents[4]


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


_JOB_URL_KEYS = (
    "job_url", "job_link", "apply_url", "apply_link", "application_url",
    "job_apply_url", "source_job_url", "source_url", "source_link", "posting_url",
    "url", "link",
)


def _actual_job_urls(eval_result: dict, job_url: str | dict = "") -> list[str]:
    """Collect URL-bearing fields that identify the source posting."""
    values: list[str] = []
    if isinstance(job_url, str) and job_url.strip():
        values.append(job_url)
    elif isinstance(job_url, dict):
        for key in _JOB_URL_KEYS:
            value = job_url.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value)

    nested_job = eval_result.get("job")
    if isinstance(nested_job, dict):
        for key in _JOB_URL_KEYS:
            value = nested_job.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value)

    for key in _JOB_URL_KEYS:
        value = eval_result.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value)
    return values


def _domain_eval_with_job_url(eval_result: dict, job: dict) -> dict:
    """Attach the source URL without changing the legacy infer call shape."""
    if not isinstance(job, dict):
        return eval_result
    for key in _JOB_URL_KEYS:
        value = job.get(key)
        if isinstance(value, str) and value.strip():
            enriched = dict(eval_result)
            # Keep the source posting URL visible to _infer_domain even when
            # the evaluator supplied a different URL-shaped field.
            if isinstance(eval_result.get("job_url"), str) and eval_result.get("job_url"):
                enriched["source_job_url"] = value
            else:
                enriched["job_url"] = value
            return enriched
    return eval_result


def _infer_domain(eval_result: dict, company: str, job_url: str | dict = "") -> str:
    """Return a verified-looking company domain, never a portal/ATS host.

    A job URL is treated as source metadata, not as a company-domain signal.
    This matters for tenant-hosted ATS boards (for example
    ``acme.wd1.myworkdayjobs.com``) where the host is not a company mailbox.
    Low- or medium-confidence (or missing-confidence) explicit domains are
    rejected; only high/verified/certain company domains may reach SMTP.
    """
    for source_url in _actual_job_urls(eval_result, job_url):
        # A non-empty URL that cannot be normalised is not trusted either.
        if is_untrusted_domain(source_url):
            return ""

    confidence = str(eval_result.get("domain_confidence", "")).strip().lower()
    if confidence not in {"high", "verified", "certain"}:
        return ""

    raw_explicit = eval_result.get("inferred_domain", "")
    has_explicit = raw_explicit is not None and str(raw_explicit).strip() != ""
    try:
        explicit = db.normalise_domain(raw_explicit)
    except Exception:
        explicit = ""
    if has_explicit:
        if not explicit or explicit == "unknown.com" or is_untrusted_domain(explicit):
            return ""
        return explicit

    # A guessed/medium-confidence value is not enough to manufacture a domain
    # from the company name.  Only an explicit high-confidence fallback keeps
    # the historical slug behaviour.
    if confidence not in {"high", "verified", "certain"}:
        return ""

    # Keep the historical high-confidence slug fallback for callers that do
    # not provide an explicit domain, but never use it for a guessed medium/low
    # result or when the posting came from a known ATS/portal.
    slug = re.sub(r"[^a-z0-9]", "", str(company or "").lower())
    if slug:
        candidate = f"{slug}.com"
        if not is_untrusted_domain(candidate):
            return candidate
    return ""


def _email_for_domain(email: str, domain: str) -> str:
    """Return a normalised address only when its domain exactly matches."""
    try:
        target = db.normalise_domain(domain)
    except Exception:
        return ""
    if not target or target == "unknown.com" or is_untrusted_domain(target):
        return ""
    try:
        if not db.email_matches_domain(email, domain):
            return ""
        normalised = db.normalise_email(email)
    except Exception:
        return ""
    try:
        return normalised if db.email_matches_domain(normalised, domain) else ""
    except Exception:
        return ""


def _email_candidates(text: str) -> list[str]:
    """Extract syntactically valid addresses from free-form JD/search text."""
    if not isinstance(text, str) or not text:
        return []
    # Do not use the old ``...\\.\\w+\\.\\w+\\.`` expression: it required two
    # dots after @ and consequently missed ordinary info@company.com values.
    pattern = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+"
    found: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(pattern, text):
        candidate = raw.rstrip(".,;:!?)]}>\"'")
        normalised = db.normalise_email(candidate)
        if normalised and normalised.lower() not in seen:
            seen.add(normalised.lower())
            found.append(normalised)
    return found


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

    ``outreach`` stores the company but not the job title.  The old code read
    ``row['job_title']`` from an unjoined ``outreach.*`` result, so it could
    never detect a duplicate.  The DB helper now joins the historical row to
    its job and searches all time, not just the last year.
    """
    norm = _normalise(company)
    sent_rows = db.get_sent_outreach_with_jobs()
    title_words = set(re.findall(r"[a-z0-9]+", str(title or "").lower()))
    if not title_words:
        return

    for row in sent_rows:
        if str(row.get("status", "")).lower() != "sent":
            continue
        row_company = (
            row.get("company_normalised")
            or row.get("job_company_normalised")
            or _normalise(row.get("company", ""))
        )
        if _normalise(str(row_company or "")) != norm:
            continue
        row_title = row.get("job_title") or row.get("title") or ""
        row_words = set(re.findall(r"[a-z0-9]+", str(row_title).lower()))
        if not row_words:
            continue
        overlap = len(title_words & row_words) / max(len(title_words | row_words), 1)
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
    except (IndexError, ValueError):
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


def _contact_priority(email: str) -> int:
    """Prefer generic recruiting aliases while retaining any valid address."""
    local = email.rsplit("@", 1)[0].lower()
    for index, alias in enumerate(("careers", "jobs", "hiring", "hr", "info", "contact", "talent")):
        if local == alias or local.startswith(alias + ".") or local.startswith(alias + "-"):
            return index
    if "recruit" in local:
        return 7
    return 8


def _scrape_company_emails(
    domain: str, company: str = "", simulate: bool = False
) -> list[str]:
    """Do not crawl user-controlled company sites for contacts.

    A DNS pre-check followed by a second resolver lookup in ``requests`` is
    vulnerable to rebinding. Until a DNS-pinned transport is available, G10
    deliberately relies only on explicit JD addresses, its validated cache,
    and the fixed-host SearchAPI endpoint. Unverified jobs are routed to the
    human-review queue instead.
    """
    return []


_SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"
_SEARCHAPI_HOSTS = frozenset({"www.searchapi.io", "searchapi.io"})


def _searchapi_company_emails(
    domain: str, company: str = "", simulate: bool = False
) -> list[str]:
    """Return published addresses whose domain exactly equals ``domain``.

    SearchAPI is a fixed HTTPS trust boundary.  Its requests still go through
    the shared public URL policy, so an API key is never sent to an automatic
    redirect and a redirect to an unsafe destination is rejected before a
    second request.
    """
    import os

    try:
        target = db.normalise_domain(domain)
    except Exception:
        return []
    api_key = os.getenv("SEARCHAPI_API_KEY", "")
    if (
        simulate
        or not api_key
        or not target
        or target == "unknown.com"
        or is_untrusted_domain(target)
    ):
        return []

    try:
        texts: list[str] = []
        queries = [f"site:{target} contact OR email OR careers"]
        if company:
            queries.append(f'"{company}" (info@ OR careers@ OR jobs@ OR hr@)')
        for query in queries[:2]:
            try:
                response = _scraper_policy.safe_get(
                    _SEARCHAPI_URL,
                    params={"engine": "google", "q": query, "api_key": api_key},
                    timeout=15,
                    allowed_hosts=_SEARCHAPI_HOSTS,
                    require_https=True,
                    allow_redirects=False,
                )
                if response.status_code != 200:
                    continue
                payload = response.json()
                for item in (payload.get("organic_results", []) or [])[:5]:
                    if not isinstance(item, dict):
                        continue
                    texts.append(
                        f"{item.get('title', '')} {item.get('snippet', '')} "
                        f"{item.get('description', '')}"
                    )
            except Exception:
                continue

        found: list[str] = []
        for text in texts:
            for candidate in _email_candidates(text):
                valid = _email_for_domain(candidate, target)
                if valid:
                    found.append(valid)
        ranked: list[str] = []
        seen: set[str] = set()
        for candidate in found:
            key = candidate.lower()
            if key not in seen:
                seen.add(key)
                ranked.append(candidate)
        ranked.sort(key=_contact_priority)
        if ranked:
            print(f"  [G10] SearchApi found published: {ranked[0]} for {company}")
        return ranked
    except Exception as e:
        print(f"  [G10] SearchApi lookup failed (non-fatal): {e}")
        return []


def _linkedin_people_emails(company: str, domain: str) -> list[str]:
    """Deprecated: never generate/fabricate people addresses."""
    return []


def _check_g10_contact(
    contact_email: str,
    domain: str,
    confidence: str,
    company: str = "",
    recruiter_email_draft: str = "",
    simulate: bool = False,
) -> str:
    """
    Return the best verified address for the target company domain.

    Cache and explicit JD/LLM values are accepted only after syntax and exact
    domain validation.  Simulation is deliberately offline: it may read a
    valid cache entry, but it never performs HTTP lookups or writes a cache
    entry.  Live site/search results are filtered again before they can be
    persisted.
    """
    try:
        target_domain = db.normalise_domain(domain)
    except Exception:
        target_domain = ""
    if (
        not target_domain
        or target_domain == "unknown.com"
        or is_untrusted_domain(target_domain)
    ):
        raise NoContactEmailError(
            f"G10: no verified company domain for '{company}' (got {domain!r})"
        )

    # Priority 0: domain cache (read-only, including in simulation).
    try:
        hit = db.get_domain_contact(target_domain)
        if hit:
            cached_email = _email_for_domain(hit.get("email", ""), target_domain)
            if cached_email:
                print(f"  [G10] cache hit: {cached_email} ({hit.get('source', 'cache')})")
                return cached_email
    except Exception as e:
        print(f"  [G10] cache read failed (non-fatal): {e}")

    # Priority 1: explicit JD/LLM address, or an address explicitly present in
    # the supplied recruiter draft.  A third-party address is ignored rather
    # than being used as a send target.
    explicit_candidates: list[str] = []
    if isinstance(contact_email, str):
        # The evaluator field is an address, not free-form prose.  Do not
        # salvage a valid-looking substring from a malformed value.
        explicit_candidates.append(contact_email)
    if recruiter_email_draft:
        explicit_candidates.extend(_email_candidates(recruiter_email_draft))
    for candidate in explicit_candidates:
        valid = _email_for_domain(candidate, target_domain)
        if valid:
            return valid

    if simulate:
        raise NoContactEmailError(
            f"G10: no verified email for '{company}' domain '{target_domain}' "
            "(simulation: network lookups disabled)"
        )

    # Priority 2: fixed-host SearchAPI result, again exact-domain matched
    # before use/cache. Company-site crawling is intentionally disabled until
    # a DNS-pinned transport is available.
    searched = _searchapi_company_emails(target_domain, company)
    if searched:
        candidate = _email_for_domain(searched[0], target_domain)
        if candidate:
            try:
                db.save_domain_contact(target_domain, candidate, "web-search")
            except Exception as e:
                print(f"  [G10] web-contact cache write failed (non-fatal): {e}")
            return candidate

    raise NoContactEmailError(
        f"G10: no verified email found for '{company}' domain '{target_domain}' "
        "(JD: none, company-site crawl: disabled, web lookup: none)"
    )


# ── Email variant selection ──────────────────────────────────────────────────

def _select_variant() -> str:
    """Weighted random selection from email_variants table."""
    import random
    weights = db.get_variant_weights()
    variants = list(weights.keys())
    wvals    = [weights[v] for v in variants]
    return random.choices(variants, weights=wvals, k=1)[0]


def _review_eval_from_job(job: dict) -> dict:
    """Build the subset needed by a Discord review card from a DB job row."""
    skill_gap = job.get("skill_gap", []) or []
    if isinstance(skill_gap, str):
        try:
            skill_gap = json.loads(skill_gap)
        except (TypeError, ValueError):
            skill_gap = [skill_gap] if skill_gap else []
    if not isinstance(skill_gap, list):
        skill_gap = []
    return {
        "match_percentage": job.get("score", 0) or 0,
        "letter_grade": job.get("letter_grade", "") or "",
        "text_summary": job.get("text_summary", "") or "",
        "skill_gap": skill_gap,
        "recruiter_message": job.get("recruiter_message", "") or "",
        "recruiter_email": job.get("recruiter_email", "") or "",
        "contact_email": job.get("contact_email", "") or "",
    }


def _route_g10_to_review(job_id: int, job: dict, eval_result: dict, reason: str,
                         domain: str, run_id: str = "", pdf_path: str = "",
                         simulate: bool = False) -> str:
    """Persist a G10 miss and deliver its JD to Discord when configured.

    Simulation returns only the ``review-sim`` marker.  Live delivery always
    retains the row until the exact ``outreach_id`` is marked posted; import,
    webhook, and transport failures are visible and non-fatal.
    """
    if simulate:
        print(f"  [discord:review-sim] job #{job_id} would be queued for human review")
        return "review-sim"

    # A posted row is a terminal state.  If this read fails, continue and let
    # the transactional ensure helper make the safe decision rather than
    # dropping the review entirely.  This is also safe with a stale DB module:
    # ``ensure_review_outreach`` can still preserve a pending row before we
    # attempt any delivery.
    try:
        if db.has_posted_review_card(job_id):
            print(f"  [discord:review-existing] job #{job_id} already has a posted review card")
            return "already-posted"
    except Exception as e:
        print(f"  [discord:pending] could not check review state: {e}")

    try:
        review_id = db.ensure_review_outreach(
            job_id=job_id,
            company=job.get("company", "Unknown"),
            domain=domain,
            reason=reason,
        )
    except Exception as e:
        print(f"  [discord:pending] could not persist review row: {e}")
        return "pending"

    # A concurrent worker may have completed the row between the first check
    # and ensure().  Do not send a second card in that case.
    try:
        if db.get_review_outreach_status(review_id) == "review_posted":
            print(f"  [discord:review-existing] job #{job_id} already has a posted review card")
            return "already-posted"
    except Exception as e:
        print(f"  [discord:pending] could not verify review row #{review_id}: {e}")

    import os
    if not os.getenv("DISCORD_REVIEW_WEBHOOK_URL", "").strip():
        print(f"  [discord:pending] job #{job_id} saved for human review; webhook not configured")
        return "pending"

    try:
        claimed = db.claim_review_card(review_id, job_id=job_id)
    except Exception as e:
        print(f"  [discord:failed] job #{job_id} could not claim review row #{review_id}: {e}")
        return "failed"
    if not claimed:
        status = db.get_review_outreach_status(review_id)
        if status == "review_posted":
            return "already-posted"
        print(f"  [discord:pending] job #{job_id} review row is already claimed/in flight")
        return "pending"

    delivered = False
    try:
        db_job = db.get_job(job_id) or {}
        card_job = {**db_job, **job, "job_id": job_id}
        if pdf_path:
            card_job["pdf_path"] = pdf_path
        card_eval = {**_review_eval_from_job(db_job), **eval_result}
        from pulseops_notify.discord import send_discord_review_card
        delivered = send_discord_review_card(
            job=card_job,
            eval_result=card_eval,
            reason=reason,
            pdf_path=pdf_path or card_job.get("pdf_path", ""),
            run_id=run_id,
        )
        if not delivered:
            db.release_review_card(review_id, "Discord delivery returned false")
            print(f"  [discord:pending] job #{job_id} review card was not delivered; row released")
            return "pending"

        marked = db.mark_review_card_posted(review_id, job_id=job_id)
        if marked is not False:
            return "posted"
        status = db.get_review_outreach_status(review_id)
        if status == "review_posted":
            return "posted"
        # Delivery succeeded but persistence is ambiguous. Keep review_sending
        # rather than releasing it, because a retry could duplicate the card.
        print(f"  [discord:failed] job #{job_id} card delivered but row #{review_id} was not marked")
        return "failed"
    except Exception as e:
        if not delivered:
            try:
                db.release_review_card(review_id, f"{type(e).__name__}: {e}")
            except Exception:
                pass
        print(f"  [discord:failed] job #{job_id} review card: {e}; row retained")
        return "failed"


def _pending_review_count() -> int:
    """Read the exact pending count, with a compatibility fallback."""
    counter = getattr(db, "count_pending_review_jobs", None)
    if callable(counter):
        return int(counter())
    return len(db.get_pending_review_jobs(limit=100))


# Serialise flushes inside one process. The database claim transaction provides
# the cross-process at-most-once delivery boundary; the lock avoids redundant
# local claims while cards are being drained.
_REVIEW_FLUSH_LOCK = threading.RLock()


def flush_pending_review_cards(run_id: str = "", limit: int = 20) -> dict:
    """Deliver pending G10 cards and report post-attempt state accurately."""
    import os

    result = {"pending": 0, "posted": 0, "failed": 0}
    if not os.getenv("DISCORD_REVIEW_WEBHOOK_URL", "").strip():
        result["pending"] = _pending_review_count()
        if result["pending"]:
            print(
                f"  [discord:pending] {result['pending']} G10 review job(s) await "
                "DISCORD_REVIEW_WEBHOOK_URL"
            )
        return result

    with _REVIEW_FLUSH_LOCK:
        try:
            from pulseops_notify.discord import send_discord_review_card
        except Exception as e:
            # An import/stale-module problem is visible and non-fatal.  No row
            # is deleted or marked, so a later healthy worker can retry it.
            result["pending"] = _pending_review_count()
            result["failed"] = result["pending"]
            print(
                "  [discord:failed] review delivery unavailable: "
                f"{type(e).__name__}; rows remain pending"
            )
            return result

        rows = db.get_pending_review_jobs(limit=max(1, int(limit)))
        seen_ids: set[int] = set()
        for row in rows:
            try:
                outreach_id = int(row["outreach_id"])
            except (KeyError, TypeError, ValueError):
                result["failed"] += 1
                print(f"  [discord:failed] pending row has no valid outreach_id: {row!r}")
                continue
            if outreach_id in seen_ids:
                continue
            seen_ids.add(outreach_id)

            try:
                claimed = db.claim_review_card(
                    outreach_id, job_id=int(row.get("job_id") or 0) or None
                )
            except Exception as e:
                result["failed"] += 1
                print(
                    f"  [discord:failed] could not claim pending outreach "
                    f"#{outreach_id}: {type(e).__name__}"
                )
                continue
            if not claimed:
                # Another process owns the delivery, or it completed first.
                continue

            job = dict(row)
            job["job_id"] = row.get("job_id")
            eval_result = _review_eval_from_job(row)
            delivered = False
            try:
                delivered = send_discord_review_card(
                    job=job,
                    eval_result=eval_result,
                    reason=row.get("review_reason") or "G10: no verified email",
                    pdf_path=row.get("pdf_path", "") or "",
                    run_id=run_id,
                )
                if not delivered:
                    db.release_review_card(outreach_id, "Discord delivery returned false")
                    result["failed"] += 1
                    print(
                        f"  [discord:pending] outreach #{outreach_id} was not delivered; "
                        "row released for retry"
                    )
                    continue

                marked = db.mark_review_card_posted(
                    outreach_id, job_id=int(row.get("job_id") or 0) or None
                )
                if marked is not False:
                    result["posted"] += 1
                else:
                    status = db.get_review_outreach_status(outreach_id)
                    if status == "review_posted":
                        result["posted"] += 1
                    else:
                        result["failed"] += 1
                        print(
                            f"  [discord:failed] outreach #{outreach_id} was delivered "
                            "but could not be marked; row remains pending"
                        )
            except Exception as e:
                if not delivered:
                    try:
                        db.release_review_card(
                            outreach_id, f"{type(e).__name__}: {e}"
                        )
                    except Exception:
                        pass
                result["failed"] += 1
                print(
                    f"  [discord:failed] pending outreach #{outreach_id}: "
                    f"{type(e).__name__}; row retained"
                )

        result["pending"] = _pending_review_count()
        return result


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
    # Global kill switch. Simulation stays completely database-free; every live
    # call, including deferred-queue processing, must see an explicit unpaused
    # value. Missing/malformed settings fail closed as QUEUE.
    if not simulate:
        try:
            if db.get_send_paused():
                return {
                    "action": "QUEUE",
                    "reason": "global send pause is active",
                    "guardrail": "PAUSE",
                }
        except Exception as exc:
            return {
                "action": "QUEUE",
                "reason": f"send pause state unavailable: {exc}",
                "guardrail": "PAUSE",
            }

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
    contact_email  = eval_result.get("contact_email", "") or job.get("contact_email", "")
    recruiter_email_text = (
        eval_result.get("recruiter_email", "") or job.get("recruiter_email", "")
    )
    domain         = _infer_domain(
        _domain_eval_with_job_url(eval_result, job), company
    )
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
        # Referral alerts are network side effects.  Simulation must remain
        # completely offline, so only live runs may notify.
        if not simulate:
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
        reason = str(e)
        route_state = _route_g10_to_review(
            job_id=job_id,
            job=job,
            eval_result=eval_result,
            reason=reason,
            domain=domain,
            run_id=run_id,
            pdf_path=pdf_path,
            simulate=simulate,
        )
        return _result("SKIP", f"{reason} [discord:{route_state}]", "G10")

    # Re-validate at the final boundary.  This protects the send path even if
    # a cache/helper or a future caller returns a malformed address.
    actual_to = _email_for_domain(send_to or contact_email, domain)
    if not actual_to:
        reason = (f"G10: no verified email address for '{company}' "
                  f"(domain '{domain}', confidence '{confidence}')")
        route_state = _route_g10_to_review(
            job_id=job_id,
            job=job,
            eval_result=eval_result,
            reason=reason,
            domain=domain,
            run_id=run_id,
            pdf_path=pdf_path,
            simulate=simulate,
        )
        return _result("SKIP", f"{reason} [discord:{route_state}]", "G10")

    # ── All guardrails passed — SEND ─────────────────────────────────────
    variant = eval_result.get("email_variant_used") or _select_variant()

    if simulate:
        # Simulation is a pure decision: no outreach row, job status, variant
        # statistic, audit write, SMTP call, or cache write is permitted.
        print(f"    [SendEngine/Sim] SEND -> {actual_to} via {variant}")
        return _result("SEND", f"simulated -> {actual_to}", None)

    # Live send
    try:
        from pulseops_outreach.email_sender import send_cold_email
        sent = send_cold_email(
            to_email=actual_to,
            email_text=recruiter_email_text,
            attachment_path=pdf_path,
            min_gap_minutes=min_gap,
            simulate=False,
            domain=domain,
        )
        if sent:
            _record_send(job_id, company, domain, actual_to, recruiter_email_text,
                          variant, run_id, simulate=False)
            return _result("SEND", f"sent -> {actual_to}", None)
        else:
            # AUTO_SEND_EMAILS=false
            return _result("SKIP", "AUTO_SEND_EMAILS=false — send not enabled", None)
    except Exception as e:
        return _result("SKIP", f"SMTP failure: {e}", None)


def _record_send(job_id: int, company: str, domain: str, to_email: str,
                  email_text: str, variant: str, run_id: str, simulate: bool) -> None:
    """Persist a live send; simulation is an explicit no-op.

    The guard is intentionally inside the writer as well as at the caller so a
    future call site cannot accidentally turn ``--simulate`` into a status or
    cache mutation.
    """
    if simulate:
        print(f"  [SendEngine/Sim] persistence skipped for {to_email}")
        return
    if not domain or is_untrusted_domain(domain) or not db.email_matches_domain(to_email, domain):
        raise NoContactEmailError(
            f"G10: refusing to persist an address outside company domain '{domain}'"
        )

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
        status="sent",
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
    audit_log.write_send_decision(run_id, company, "", "SEND", f"live -> {to_email}")


def process_pending_send_queue(
    settings: dict,
    run_id: str = "",
    limit: int = 20,
) -> dict:
    """Drain persisted G7/G8 deferrals with at-most-once queue claims.

    Pending is retained only for genuinely temporary conditions (pause, send
    window/cap, cooldown, domain limit, or auto-send not configured). Transport
    ambiguity becomes ``uncertain`` + ``NeedsVerification`` rather than an
    automatic retry that could send twice. Human-review outcomes become
    ``skipped`` + ``NeedsReview``.
    """
    result = {
        "claimed": 0,
        "sent": 0,
        "deferred": 0,
        "skipped": 0,
        "uncertain": 0,
    }
    try:
        resolved_stale = db.resolve_stale_processing_queue(timeout_minutes=60)
        if resolved_stale:
            result["uncertain"] += resolved_stale
            print(
                f"  [SendQueue] resolved {resolved_stale} abandoned claim(s) "
                "to uncertain; no automatic retry"
            )
    except Exception as exc:
        print(f"  [SendQueue] stale-claim reconciliation failed closed: {exc}")
    if limit <= 0:
        return result

    for _ in range(limit):
        item = db.claim_pending_queue_item()
        if not item:
            break
        result["claimed"] += 1
        queue_id = int(item.get("id", 0))
        try:
            job_id = int(item.get("job_id", 0))
        except (TypeError, ValueError):
            db.update_queue_status(queue_id, "skipped")
            result["skipped"] += 1
            continue
        if job_id <= 0:
            db.update_queue_status(queue_id, "skipped")
            result["skipped"] += 1
            continue

        job = db.get_job(job_id)
        if not job:
            db.update_queue_status(queue_id, "skipped")
            result["skipped"] += 1
            continue
        current_status = str(job.get("status", "") or "")
        if current_status not in {"Evaluated", "EmailQueued"}:
            db.update_queue_status(queue_id, "skipped")
            result["skipped"] += 1
            continue

        eval_result = {
            "match_percentage": int(job.get("score") or item.get("score") or 0),
            "grade": job.get("grade", ""),
            "job_strengths": job.get("job_strengths", ""),
            "skill_gap": job.get("skill_gap", ""),
            "contact_email": job.get("contact_email", ""),
            "recruiter_email": job.get("recruiter_email", ""),
            "inferred_domain": job.get("inferred_domain", ""),
            "domain_confidence": job.get("domain_confidence", "low"),
            "email_variant_used": job.get("email_variant_used", ""),
        }
        send_job = {
            "id": job_id,
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "link": job.get("link", ""),
            "description": job.get("description", ""),
            "source": job.get("source", ""),
            "status": current_status,
            "contact_email": job.get("contact_email", ""),
            "recruiter_email": job.get("recruiter_email", ""),
            "inferred_domain": job.get("inferred_domain", ""),
            "pdf_path": job.get("pdf_path", ""),
        }

        try:
            decision = decide_send(
                job_id=job_id,
                job=send_job,
                eval_result=eval_result,
                settings=settings,
                run_id=run_id,
                simulate=False,
                pdf_path=job.get("pdf_path", "") or "",
            )
        except Exception as exc:
            db.update_queue_status(queue_id, "uncertain")
            db.update_job_status(job_id, "NeedsVerification")
            result["uncertain"] += 1
            print(
                f"  [SendQueue] #{queue_id} job #{job_id} is uncertain "
                f"after {type(exc).__name__}: {exc}"
            )
            continue

        action = str(decision.get("action", "SKIP") or "SKIP").upper()
        reason = str(decision.get("reason", "") or "")
        guardrail = str(decision.get("guardrail", "") or "").upper()
        reason_lower = reason.lower()

        if action == "SEND":
            db.update_queue_status(queue_id, "sent")
            # decide_send normally records this itself. Keep the queue state
            # authoritative even if a future transport implementation forgets.
            latest = db.get_job(job_id) or {}
            if str(latest.get("status", "")) in {"Evaluated", "EmailQueued"}:
                db.update_job_status(job_id, "Sent")
            result["sent"] += 1
            continue

        temporary = (
            action == "QUEUE"
            or guardrail in {"PAUSE", "G5", "G6", "G7", "G8"}
            or "auto_send_emails=false" in reason_lower
        )
        if temporary:
            db.update_queue_status(queue_id, "pending")
            if current_status == "Evaluated":
                db.update_job_status(job_id, "EmailQueued")
            result["deferred"] += 1
            # Pause/window/cap/auto-disabled apply globally; do not churn every
            # remaining row through the same guardrail in this invocation.
            if (
                guardrail in {"PAUSE", "G7", "G8"}
                or "auto_send_emails=false" in reason_lower
            ):
                break
            continue

        uncertain = reason_lower.startswith("smtp failure") or "sendmail" in reason_lower
        if uncertain:
            db.update_queue_status(queue_id, "uncertain")
            db.update_job_status(job_id, "NeedsVerification")
            result["uncertain"] += 1
            continue

        db.update_queue_status(queue_id, "skipped")
        db.update_job_status(job_id, "NeedsReview")
        result["skipped"] += 1
        print(
            f"  [SendQueue] #{queue_id} job #{job_id} resolved to human review "
            f"({guardrail or 'GUARDRAIL'}: {reason})"
        )

    return result
