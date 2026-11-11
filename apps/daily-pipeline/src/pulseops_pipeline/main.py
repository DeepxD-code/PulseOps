"""
main.py — PulseOps Daily Pipeline Orchestrator

Phases:
  0  GitHub resume sync (flagging cv_candidates, never writing cv.md)
  1  Scrape (LinkedIn + Google Jobs + TheirStack)
  2  Semantic dedup + location filter
  3  Stage 1 domain hard filter (zero LLM cost)
  4  Stage 2 domain soft filter (Gemini, ≤150 tokens, 5s timeout)
  5  Full 6-block LLM evaluation (Gemini → Groq → OpenAI cascade)
  6  Resume build (PDF + HTML via Playwright)
  7  Send engine (all 10 guardrails, G7/G8 → QUEUE)
  8  Telegram notifications + audit summary
  9  IMAP reply check + interview prep triggers + follow-up engine + TSV export

Usage:
  python main.py                   Full daily pipeline
  python main.py --simulate        Offline dry-run, zero API calls
  python main.py --force           Re-evaluate already-seen jobs
  python main.py --dashboard       Launch Flask web dashboard
  python main.py --pause-sends     Halt all outreach
  python main.py --resume-sends    Re-enable outreach

Non-negotiables enforced here:
  #1  cv.md is the only file a human ever edits
  #2  No application without passing all 10 guardrails (send_engine.py)
  #3  Every autonomous action logged to append-only audit log
  #4  Memory never auto-modifies cv.md
  #5  Simulation mode works with zero API keys, always
  #6  Source failures never silent (Telegram alert after 3 consecutive zeros)
  #7  profile.yml is generated, never manually edited
  #8  No LLM call before Stage 1 hard filter passes
  #9  Referral check always before cold email (in send_engine)
  #10 Feedback loop only from phone_screen+ (in db_manager.get_successful_bullets)
"""

import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
try:
    from pulseops_config.paths import repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parents[4]

SIMULATED_SOURCE_PREFIX = "SIMULATED:"


def _source_is_simulated(source: object) -> bool:
    """Return whether a source is explicitly marked as simulated."""
    return str(source or "").strip().upper().startswith(SIMULATED_SOURCE_PREFIX)


def _source_is_mock(source: object) -> bool:
    """Recognise legacy mock labels before they reach persistence."""
    value = str(source or "").strip()
    if _source_is_simulated(value):
        value = value[len(SIMULATED_SOURCE_PREFIX):].strip()
    return value.lower() == "mock" or value.lower().startswith(("mock:", "mock-"))


def _mark_simulated_job(job: dict) -> dict:
    """Mark a job before persistence without discarding its source name."""
    raw_source = str(job.get("source") or "Mock").strip() or "Mock"
    if _source_is_simulated(raw_source):
        original_source = raw_source[len(SIMULATED_SOURCE_PREFIX):].strip() or "Mock"
    else:
        original_source = raw_source
    job.setdefault("source_original", original_source)
    job["source"] = f"{SIMULATED_SOURCE_PREFIX}{original_source}"
    job["simulated"] = True
    return job


def _mark_simulated_jobs(jobs: list[dict] | None) -> list[dict]:
    return [_mark_simulated_job(job) for job in (jobs or []) if isinstance(job, dict)]


def _use_isolated_simulation_db() -> None:
    """Keep simulation rows out of the live jobs/outreach database."""
    from pulseops_store import db_manager as db

    live_path = Path(os.getenv("PULSEOPS_DB", str(ROOT / "pulseops.db"))).resolve()
    configured = os.getenv("PULSEOPS_SIMULATION_DB", "").strip()
    simulation_path = (
        Path(configured).resolve()
        if configured
        else (ROOT / "data" / "pulseops-simulation.db").resolve()
    )
    if simulation_path == live_path:
        raise RuntimeError(
            "PULSEOPS_SIMULATION_DB must not point at the live PULSEOPS_DB"
        )
    db.DB_PATH = simulation_path
    db.DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _send_pause_active(reader) -> bool:
    """Read the pause switch fail-closed if the DB cannot be consulted."""
    try:
        return bool(reader())
    except Exception:
        return True


def _protect_pending_email_queue() -> None:
    """Keep legacy pending e-mail rows out of the browser-apply status set."""
    try:
        from pulseops_store.db_manager import (
            get_job,
            get_pending_queue_items,
            is_protected_job_status,
            update_job_status,
        )

        for item in get_pending_queue_items(limit=1000):
            try:
                job_id = int(item.get("job_id", 0))
            except (TypeError, ValueError):
                continue
            if job_id <= 0:
                continue
            job = get_job(job_id)
            if not job:
                continue
            if not is_protected_job_status(job.get("status")):
                update_job_status(job_id, "EmailQueued")
    except Exception as e:
        print(f"  [!] Could not protect pending e-mail queue rows: {e}")


def _header(title: str) -> None:
    print(f"\n{'=' * 62}\n  {title}\n{'=' * 62}")


def _load_settings() -> dict:
    defaults = {
        "scoring":    {"send_threshold": 88, "pdf_threshold": 75, "notify_threshold": 70},
        "guardrails": {"daily_send_cap": 5, "company_cooldown_days": 30,
                        "send_window_start": "09:00", "send_window_end": "18:00",
                        "send_timezone": "Asia/Kolkata", "domain_daily_limit": 2,
                        "bounce_pause_threshold": 2, "min_send_gap_minutes": 8},
        "sourcing":   {"max_age_days": 7, "location": "India"},
        "followup":   {"enabled": True, "day": 5, "max_per_application": 1},
    }
    try:
        import yaml
        for p in [ROOT / "config" / "settings.yml",
                   ROOT / "config" / "settings.yml.example",
                   ROOT / "packages" / "pulse-config" / "config" / "settings.yml.example"]:
            if p.exists():
                with open(p) as f:
                    data = yaml.safe_load(f) or {}
                    if data.get("scoring"):
                        return data
                    # file exists but empty/invalid — try next fallback
                    continue
    except ImportError:
        pass
    return defaults


def _load_profile() -> dict:
    try:
        import yaml
        for p in [ROOT / "config" / "profile.yml",
                  ROOT / "config" / "profile.yml.example",
                  ROOT / "packages" / "pulse-config" / "config" / "profile.yml.example"]:
            if p.exists():
                with open(p) as f:
                    data = yaml.safe_load(f) or {}
                    if data:
                        return data
        print("[!] profile.yml not found — run: python doctor.py --init (using empty profile)")
        return {}
    except ImportError:
        return {}


def _mock_evaluation(title: str, company: str) -> dict:
    kw   = ["java", "python", "backend", "c++", "go", "spring", "grpc", "kafka"]
    score = 88 if any(k in title.lower() for k in kw) else 65
    grade = "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "D"
    return {
        "match_percentage": score, "letter_grade": grade,
        "text_summary": f"[Sim] Strong backend match for {title} at {company}.",
        "bullet_adjustments": [
            {"original": "Built API service",
             "tailored": "Engineered REST API handling 10k RPS with Java + Spring Boot, reducing P99 latency by 40%"}
        ],
        "skill_gap": ["System Design", "Distributed Systems"],
        "tailored_skills": ["Java", "Spring Boot", "PostgreSQL", "Docker"],
        "recruiter_message": f"Hi, very interested in {title} at {company}. Strong Java/backend background.",
        "recruiter_email": (f"Subject: Application — {title} @ {company}\n\n"
                             f"Hi,\n\nI'd love to discuss the {title} role at {company}.\n\n"
                             "I have strong experience with Java, Spring Boot, gRPC, PostgreSQL, "
                             "and Kubernetes, and I'd be a great fit for your backend team.\n\n"
                             "Best regards"),
        "contact_email": "", "inferred_domain": f"{company.lower().replace(' ', '')}.com",
        "domain_confidence": "low",
        "level_strategy": "Position as high-potential new grad with production-grade project experience.",
        "comp_research": "Entry-level backend engineer India: INR 8–18 LPA (Bangalore/Hyderabad).",
        "star_stories": [
            {"question": "Tell me about a technical challenge you solved.",
             "answer": ("S: Legacy API timing out under load. T: Needed 3× throughput in 2 weeks. "
                         "A: Rewrote with Java + connection pooling + Redis cache. "
                         "R: P99 latency dropped from 800ms to 210ms. "
                         "Reflection: Would instrument earlier next time.")}
        ],
        "negotiation_notes": "Counter below INR 10 LPA with project impact metrics. Cite Bangalore median.",
        "email_variant_used": "technical_lead",
        "engine": "simulation", "tokens_used": 0, "eval_duration_ms": 500,
    }


def _finish(run_id: str, stats: dict, start: float, settings: dict) -> None:
    from pulseops_store import audit_log
    from pulseops_store.db_manager import save_run_stats

    duration = int(time.time() - start)
    stats["duration_seconds"] = duration
    save_run_stats(run_id, "daily", stats)
    audit_log.write_run_end(run_id, stats)

    _header("Run Complete")
    for label, val in [
        ("Sourced",       stats.get("sourced", 0)),
        ("After dedup",   stats.get("after_dedup", 0)),
        ("After filters", stats.get("after_soft_filter", 0)),
        ("Evaluated",     stats.get("evaluated", 0)),
        ("PDFs built",    stats.get("matched_pdf", 0)),
        ("Sent",          stats.get("sent", 0)),
        ("Queued",        stats.get("queued", 0)),
        ("Skipped",       stats.get("skipped", 0)),
        ("Tokens used",   stats.get("tokens_used", 0)),
        ("Duration",      f"{duration}s"),
    ]:
        print(f"  {label:<18} {val}")


# ── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    if sys.platform.startswith("win"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    parser = argparse.ArgumentParser(description="PulseOps Daily Pipeline")
    parser.add_argument("--simulate",     action="store_true", help="Offline dry-run (no API calls)")
    parser.add_argument("--sources",      default="", metavar="LIST",
                        help="Comma-separated source names to source from this run "
                             "(e.g. --sources=himalayas). Default: every source.")
    parser.add_argument("--force",        action="store_true", help="Re-evaluate already-seen jobs")
    parser.add_argument("--dashboard",    action="store_true", help="Launch Flask dashboard")
    parser.add_argument("--pause-sends",  action="store_true", help="Halt all outreach")
    parser.add_argument("--resume-sends", action="store_true", help="Re-enable outreach")
    args = parser.parse_args()

    if args.dashboard:
        from dashboard.app import run_server
        run_server()
        sys.exit(0)

    if args.simulate and not (args.pause_sends or args.resume_sends):
        _use_isolated_simulation_db()

    from pulseops_store.db_manager import get_send_paused, init_db, set_send_paused
    init_db()
    if not args.simulate:
        _protect_pending_email_queue()

    if args.pause_sends:
        set_send_paused(True)
        print("[OK] Auto-sends PAUSED.")
        sys.exit(0)
    if args.resume_sends:
        set_send_paused(False)
        print("[OK] Auto-sends RESUMED.")
        sys.exit(0)

    from pulseops_core.exceptions import (
        AllEnginesFailedError,
        EvaluationError,
        SourceError,
    )
    from pulseops_store import audit_log
    from pulseops_store.db_manager import (
        enqueue_send,
        get_job_for_identity,
        is_job_processed,
        is_protected_job_status,
        record_source_health,
        save_job,
        update_job_paths,
        update_job_status,
    )

    run_id    = audit_log.generate_run_id()
    run_start = time.time()
    settings  = _load_settings()

    send_threshold   = settings["scoring"]["send_threshold"]
    pdf_threshold    = settings["scoring"]["pdf_threshold"]
    notify_threshold = settings["scoring"]["notify_threshold"]

    _header(f"PulseOps Daily Run [{run_id}]")
    print(f"  Mode:  {'SIMULATION' if args.simulate else 'LIVE'}")
    print(f"  Start: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if _send_pause_active(get_send_paused):
        print("  [!] Auto-sends are PAUSED or their setting is unreadable (fail-closed)")

    audit_log.write_run_start(run_id, run_type="daily")

    # Load notification channels early (needed for Phase 1 source health alerts)
    discord_webhook = os.getenv("DISCORD_WEBHOOK_URL", "")

    stats = {
        "sourced": 0, "after_dedup": 0, "after_location": 0,
        "after_hard_filter": 0, "after_soft_filter": 0,
        "evaluated": 0, "matched_pdf": 0,
        "sent": 0, "queued": 0, "skipped": 0, "uncertain": 0,
        "tokens_used": 0, "engines_used": {},
    }
    new_matches: list[dict] = []

    if not args.simulate:
        _header("Phase 0A: Deferred Email Queue")
        from pulseops_outreach.send_engine import process_pending_send_queue
        queue_result = process_pending_send_queue(
            settings=settings,
            run_id=run_id,
            limit=20,
        )
        stats["sent"] += int(queue_result.get("sent", 0))
        stats["queued"] += int(queue_result.get("deferred", 0))
        stats["skipped"] += int(queue_result.get("skipped", 0))
        stats["uncertain"] += int(queue_result.get("uncertain", 0))
        print(f"  [SendQueue] {queue_result}")

    # Live sourcing/evaluation requires its normal LLM cascade. Deferred email
    # work above is independent and must not be blocked by an evaluation key.
    if not args.simulate:
        missing = [k for k in ["GEMINI_API_KEY", "GROQ_API_KEY"] if not os.getenv(k)]
        if missing:
            print(f"\n[ERR] Missing API keys: {', '.join(missing)}")
            sys.exit(1)

    # ── PHASE 0 — GitHub Resume Sync ─────────────────────────────────────
    _header("Phase 0: GitHub Resume Sync")
    github_username = os.getenv("GITHUB_USERNAME", "")
    if github_username and not args.simulate:
        try:
            from pulseops_github.github_sync import sync_github
            ok, msg = sync_github(github_username)
            print(f"  [{'OK' if ok else '!'}] {msg}")
            audit_log.write(action="GITHUB_SYNC", run_id=run_id, extra={"ok": ok, "msg": msg})
        except Exception as e:
            print(f"  [!] GitHub sync failed (non-fatal): {e}")
    else:
        print("  [~] Skipped (no GITHUB_USERNAME or --simulate)")

    # ── PHASE 1 — Scrape ────────────────────────────────────────────────
    _header("Phase 1: Sourcing Jobs")
    raw_jobs: list[dict] = []

    try:
        from pulseops_core.scraper import PulseOpsScraper
        scraper = PulseOpsScraper()
    except ImportError:
        # Scraper not yet built — use inline mock
        class PulseOpsScraper:  # type: ignore[no-redef]
            def get_mock_listings(self):
                return [
                    {"title": "Backend Intern (Java)", "company": "Vercel",
                     "link": "https://vercel.com/careers/b1", "source": "Mock",
                     "description": "Backend intern role. Java, Spring Boot, gRPC, PostgreSQL, Kubernetes, Docker. Remote friendly. Apply: hr@vercel.com"},
                    {"title": "Software Engineer Intern", "company": "Stripe",
                     "link": "https://stripe.com/careers/b2", "source": "Mock",
                     "description": "Intern backend software engineer. Python, Go, distributed systems, Redis, Kafka."},
                    {"title": "Senior Frontend Developer", "company": "Meta",
                     "link": "https://meta.com/careers/b3", "source": "Mock",
                     "description": "Senior React developer, 5+ years exp. Angular, Vue, TypeScript. CSS expertise required."},
                    {"title": "Platform Engineer Intern", "company": "Notion",
                     "link": "https://notion.so/careers/b4", "source": "Mock",
                     "description": "Platform/infra intern. Go, Kubernetes, Docker, Terraform, AWS, CI/CD pipelines."},
                ]
            def fetch_linkedin(self): return []
            def fetch_google_jobs(self): return []
            def fetch_theirstack(self): return []
            def fetch_himalayas(self): return []
        scraper = PulseOpsScraper()

    if args.simulate:
        raw_jobs = _mark_simulated_jobs(scraper.get_mock_listings())
        print(f"  [~] Simulation: {len(raw_jobs)} mock jobs (source-marked, no live send)")
        stats["sourced"] = len(raw_jobs)
    else:
        # A single board can be refreshed on its own. The two paid sources
        # (Google Jobs, TheirStack) are quota-bound and slow, and a free board
        # like Himalayas is worth a dedicated run without spending them.
        wanted = {
            value.strip().lower()
            for value in str(getattr(args, "sources", "") or "").split(",")
            if value.strip()
        }
        for source_name, fetch_fn in [
            ("LinkedIn",    scraper.fetch_linkedin),
            ("Google Jobs", scraper.fetch_google_jobs),
            ("TheirStack",  scraper.fetch_theirstack),
            ("Himalayas",   scraper.fetch_himalayas),
        ]:
            if wanted and source_name.lower() not in wanted and source_name.lower().replace(" ", "-") not in wanted:
                print(f"  [-] {source_name}: not selected for this run")
                continue
            try:
                jobs = fetch_fn()
                consecutive = record_source_health(source_name, run_id, len(jobs))
                raw_jobs.extend(jobs)
                print(f"  [+] {source_name}: {len(jobs)} jobs")
                audit_log.write_source_health(run_id, source_name, len(jobs), consecutive)
                if consecutive >= 3:
                    try:
                        from pulseops_notify.notifier import send_source_health_alert
                        send_source_health_alert(source_name, consecutive, run_id=run_id)
                    except Exception as e:
                        print(f"  [!] Source health alert failed (Telegram): {e}")
                    if discord_webhook:
                        try:
                            from pulseops_notify.discord import send_discord_source_health_alert
                            send_discord_source_health_alert(source_name, consecutive,
                                                              webhook_url=discord_webhook, run_id=run_id)
                        except Exception as e:
                            print(f"  [!] Source health alert failed (Discord): {e}")
            except SourceError as e:
                print(f"  [X] {source_name} failed: {e}")
                record_source_health(source_name, run_id, 0, str(e))
        stats["sourced"] = len(raw_jobs)

    print(f"\n  Total sourced: {stats['sourced']}")
    if not raw_jobs:
        print("[!] No jobs sourced. Exiting.")
        _finish(run_id, stats, run_start, settings)
        sys.exit(0)

    # ── PHASE 2 — Dedup + Location ───────────────────────────────────────
    _header("Phase 2: Dedup + Location Filter")
    try:
        from pulseops_eval.deduplicator import deduplicate
        deduped = deduplicate(raw_jobs, run_id=run_id)
    except ImportError:
        # Dedup not yet built — pass through with basic exact dedup
        seen, deduped = set(), []
        for j in raw_jobs:
            key = (j["title"].lower().strip(), j["company"].lower().strip())
            if key not in seen:
                seen.add(key)
                deduped.append(j)
    stats["after_dedup"] = len(deduped)
    print(f"  After dedup:    {len(deduped)} (dropped {stats['sourced'] - len(deduped)})")

    try:
        from pulseops_eval.location_filter import filter_by_location
        located = filter_by_location(deduped, settings.get("sourcing", {}))
    except ImportError:
        located = deduped  # pass through
    stats["after_location"] = len(located)
    print(f"  After location: {len(located)} (dropped {len(deduped) - len(located)})")

    # ── PHASE 3 — Hard Filter (Stage 1, zero LLM) ───────────────────────
    _header("Phase 3: Domain Hard Filter (Stage 1)")
    profile = _load_profile()
    hard_passed: list[dict] = []

    try:
        from pulseops_eval.domain_filter import hard_filter
        for job in located:
            result = hard_filter(job, profile)
            if result.passed:
                hard_passed.append(job)
            else:
                audit_log.write_filter_reject(run_id, job.get("company", ""),
                                               job.get("title", ""), 1, result.reason)
    except ImportError:
        # domain_filter not yet built — basic seniority/exclude pass-through
        exclude_titles = {"senior", "lead", "principal", "staff", "director",
                           "manager", "vp", "react", "angular", "frontend"}
        for job in located:
            title_lower = job.get("title", "").lower()
            desc_lower  = job.get("description", "").lower()
            if any(ex in title_lower for ex in exclude_titles):
                audit_log.write_filter_reject(run_id, job.get("company", ""),
                                               job.get("title", ""), 1, "basic title exclude")
            else:
                hard_passed.append(job)

    stats["after_hard_filter"] = len(hard_passed)
    print(f"  After hard filter: {len(hard_passed)} (rejected {len(located) - len(hard_passed)})")

    # ── PHASE 4 — Soft Filter (Stage 2, cheap LLM) ──────────────────────
    _header("Phase 4: Domain Soft Filter (Stage 2)")
    soft_passed: list[dict] = []

    if args.simulate:
        soft_passed = hard_passed
        print(f"  [~] Simulation: all {len(hard_passed)} pass soft filter")
    else:
        try:
            from pulseops_eval.domain_filter import soft_filter
            for job in hard_passed:
                result = soft_filter(job, profile)
                if result.passed:
                    soft_passed.append(job)
                else:
                    audit_log.write_filter_reject(run_id, job.get("company", ""),
                                                   job.get("title", ""), 2, result.reason)
        except ImportError:
            soft_passed = hard_passed

    stats["after_soft_filter"] = len(soft_passed)
    print(f"  After soft filter: {len(soft_passed)} (rejected {len(hard_passed) - len(soft_passed)})")

    # -- Himalayas: find these roles on the employer's own board ---------------
    #
    # Himalayas mediates the application itself: its `applicationLink` points
    # back at himalayas.app on every posting measured, no description carries an
    # employer URL, and himalayas.app answers any automated browser with
    # Cloudflare's managed check and HTTP 403. A row that also exists on the
    # employer's own ATS is therefore the only kind that can be applied to, and
    # the company slug in the listing is the only handle for finding it.
    #
    # This runs after filtering, not during sourcing: six companies cost about a
    # minute to probe, which is not a price worth paying for the rows about to be
    # discarded. Measured on the 2026-11-11 sample: 4 of 13 companies had a
    # probeable board and 1 carried the same role.
    himalayas_rows = [j for j in soft_passed if str(j.get("source") or "") == "Himalayas"]
    if himalayas_rows and not args.simulate:
        try:
            from pulseops_core.scraper import resolve_himalayas_employer_link
            board_cache: dict = {}
            recovered = 0
            for job in himalayas_rows:
                found = resolve_himalayas_employer_link(job.get("link", ""), job.get("title", ""), board_cache)
                if found:
                    job["link"] = found
                    recovered += 1
                    print(f"  [+] {job.get('company')} — employer board carries "
                          f"\"{str(job.get('title'))[:48]}\"")
            print(f"  Himalayas: {recovered}/{len(himalayas_rows)} found on the employer's own board "
                  f"(the rest are discovery-only; their site refuses automated browsers)")
        except ImportError:
            pass
        except Exception as e:  # noqa: BLE001 - resolution must never stop a run
            print(f"  [!] Himalayas employer-board resolution failed: {str(e)[:120]}")

    if not soft_passed:
        print("[!] No jobs passed domain filters. Exiting.")
        _finish(run_id, stats, run_start, settings)
        sys.exit(0)

    # ── PHASE 5-7 — Evaluate + Build + Send ─────────────────────────────
    _header("Phase 5–7: Evaluate + Resume + Send Engine")

    try:
        from pulseops_eval.analyzer import evaluate_job, reset_circuit_breakers
        reset_circuit_breakers()
        has_evaluator = True
    except ImportError:
        has_evaluator = False

    try:
        from pulseops_memory.context_loader import load_context
        has_context_loader = True
    except ImportError:
        has_context_loader = False

    try:
        from pulseops_core.cv_parser import parse_cv
        cv_data = parse_cv(str(ROOT / "cv.md")) if (ROOT / "cv.md").exists() else None
    except (ImportError, Exception):
        cv_data = None

    for idx, job in enumerate(soft_passed, 1):
        # Mark before the processed-row check and before save_job.  A mock
        # source therefore remains identifiable even if it reaches this loop
        # through a non-standard scraper or a caller-provided fixture.
        if args.simulate or _source_is_simulated(job.get("source", "")) or _source_is_mock(job.get("source", "")):
            _mark_simulated_job(job)
        title   = job.get("title", "Unknown")
        company = job.get("company", "Unknown")
        link    = job.get("link", "")
        source  = job.get("source", "?")
        simulated_job = _source_is_simulated(source)
        send_paused = False
        if not simulated_job:
            send_paused = _send_pause_active(get_send_paused)

        print(f"\n  [{idx}/{len(soft_passed)}] {title} @ {company}")

        already_processed = is_job_processed(title, company, link)
        if already_processed:
            existing = get_job_for_identity(title, company, link)
            if existing and is_protected_job_status(existing.get("status")):
                print(
                    "    [~] Existing job is protected "
                    f"({existing.get('status')}); skipping re-evaluation"
                )
                continue
        if already_processed and (not args.force or simulated_job):
            print("    [~] Already processed — skipping" +
                  (" (simulation rows are never overwritten)" if simulated_job else " (use --force to re-evaluate)"))
            continue

        # Phase 5 — Evaluation
        try:
            if args.simulate or simulated_job or not has_evaluator:
                eval_result = _mock_evaluation(title, company)
                eval_result["simulated"] = True
            else:
                memory_ctx = load_context(company=company) if has_context_loader else ""
                eval_result = evaluate_job(
                    job=job, cv_data=cv_data, memory_context=memory_ctx,
                    profile=profile, settings=settings,
                )

            score    = eval_result["match_percentage"]
            grade    = eval_result["letter_grade"]
            engine   = eval_result.get("engine", "simulation")
            tokens   = eval_result.get("tokens_used", 0)
            duration = eval_result.get("eval_duration_ms", 0)

            # A live run can still fall back to the mock evaluator when the
            # optional evaluator package is unavailable.  Never let that
            # fallback create a sendable row.
            if engine == "simulation" and not simulated_job:
                _mark_simulated_job(job)
                source = job["source"]
                simulated_job = True
                if is_job_processed(title, company, link):
                    print("    [~] Existing row collision — skipping simulated persistence")
                    continue

            print(f"    Score: {score}  Grade: {grade}  Engine: {engine}")
            stats["evaluated"] += 1
            stats["tokens_used"] += tokens
            stats["engines_used"][engine] = stats["engines_used"].get(engine, 0) + 1
            audit_log.write_eval(run_id, company, title, score, grade, engine, tokens, duration)

        except (AllEnginesFailedError, EvaluationError) as e:
            print(f"    [X] Evaluation failed: {e}")
            continue
        except Exception as e:
            print(f"    [X] Unexpected evaluation error: {e}")
            continue

        # Save a simulation row only with an explicit non-live status/source.
        # save_job is never allowed to upsert over an existing row in this
        # mode (the collision checks above enforce that invariant).
        job_id = save_job(
            title=title, company=company, link=link, source=source, run_id=run_id,
            score=score, letter_grade=grade,
            status=("Simulated" if simulated_job else
                    "SendPaused" if send_paused else "Evaluated"),
            posted_at=job.get("posted_at", ""),
            location_raw=job.get("location_raw", ""),
            location_resolved=job.get("location_resolved", ""),
            text_summary=eval_result.get("text_summary", ""),
            skill_gap_list=eval_result.get("skill_gap", []),
            bullet_adjustments_list=eval_result.get("bullet_adjustments", []),
            tailored_skills=eval_result.get("tailored_skills", []),
            star_stories=eval_result.get("star_stories", []),
            level_strategy=eval_result.get("level_strategy", ""),
            comp_research=eval_result.get("comp_research", ""),
            negotiation_notes=eval_result.get("negotiation_notes", ""),
            recruiter_message=eval_result.get("recruiter_message", ""),
            recruiter_email=eval_result.get("recruiter_email", ""),
            contact_email=eval_result.get("contact_email", ""),
            inferred_domain=eval_result.get("inferred_domain", ""),
            domain_confidence=eval_result.get("domain_confidence", ""),
            email_variant_used=eval_result.get("email_variant_used", ""),
            eval_engine=engine, eval_tokens=tokens, eval_duration_ms=duration,
        )

        # Phase 6 — Resume Build.  Simulation uses the builder's HTML-only
        # mode; it never updates a live job path or creates a PDF.
        pdf_path = report_path = ""
        if score >= pdf_threshold:
            stats["matched_pdf"] += 1
            try:
                from pulseops_core.resume_builder import build_resume
                pdf_path, report_path = build_resume(
                    cv_data=cv_data, eval_result=eval_result,
                    company=company, role=title,
                    jd_text=job.get("description", ""),
                    profile=profile,
                    simulate=args.simulate or simulated_job or send_paused,
                )
                print(f"    [PDF] {pdf_path or report_path}")
                if not simulated_job and not send_paused:
                    update_job_paths(job_id, pdf_path=pdf_path, report_path=report_path)
                elif simulated_job:
                    print("    [SIM] HTML-only resume; no live DB path update")
                else:
                    print("    [PAUSE] HTML-only resume; no live DB path update")
            except Exception as e:
                print(f"    [!] Resume build failed (non-fatal): {e}")

        # Phase 7 — Send Engine.  Do not call decide_send in simulation:
        # its G10 path can read/write the contact cache and perform network
        # lookups even when simulate=True.
        send_decision: dict | None = None
        if score >= notify_threshold:
            if simulated_job:
                send_decision = {
                    "action": "SKIP",
                    "reason": "simulation: send/review disabled",
                    "guardrail": "SIMULATION",
                }
            elif send_paused or _send_pause_active(get_send_paused):
                if not send_paused:
                    send_paused = True
                    update_job_status(job_id, "SendPaused")
                send_decision = {
                    "action": "SKIP",
                    "reason": "auto-sends are paused",
                    "guardrail": "PAUSE",
                }
            else:
                try:
                    from pulseops_outreach.send_engine import decide_send
                    send_decision = decide_send(
                        job_id=job_id, job=job, eval_result=eval_result,
                        settings=settings, run_id=run_id, simulate=False,
                        pdf_path=pdf_path,
                    )
                except (ImportError, Exception) as e:
                    print(f"    [!] Send engine error (non-fatal): {e}")
                    send_decision = {
                        "action": "SKIP",
                        "reason": f"send engine error: {e}",
                        "guardrail": "ERROR",
                    }

            action = send_decision["action"]
            reason = send_decision.get("reason", "")
            print(f"    [Send] {action}" + (f": {reason}" if reason else ""))
            audit_log.write_send_decision(run_id, company, title, action, reason)

            if action == "SEND":
                stats["sent"] += 1
            elif action == "QUEUE":
                stats["queued"] += 1
                # This is an e-mail overflow queue, not a browser-job queue.
                # Mark first so an interrupted enqueue cannot leave an
                # Evaluated row eligible for unattended browser consumption.
                update_job_status(job_id, "EmailQueued")
                enqueue_send(job_id, score, reason)
            else:
                stats["skipped"] += 1

        if score >= notify_threshold:
            new_matches.append({
                "job": job, "job_id": job_id,
                "title": title, "company": company,
                "score": score, "grade": grade,
                "pdf_path": pdf_path, "report_path": report_path,
                "eval_result": eval_result, "send_decision": send_decision,
            })

    # ── PHASE 8 — Notifications ──────────────────────────────────────────
    _header("Phase 8: Notifications")
    telegram_token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "")

    if args.simulate:
        print("  [SIM] Telegram notifications skipped")
    elif telegram_token and telegram_chat_id:
        try:
            from pulseops_notify.notifier import send_audit_summary, send_match_card
            send_audit_summary(stats, new_matches, run_id, telegram_token, telegram_chat_id, settings)
            for m in new_matches:
                try:
                    send_match_card(
                        job=m["job"], eval_result=m["eval_result"],
                        send_decision=m["send_decision"], pdf_path=m.get("pdf_path", ""),
                        bot_token=telegram_token, chat_id=telegram_chat_id, run_id=run_id,
                    )
                except Exception as e:
                    print(f"  [!] Match card failed for {m['company']}: {e}")
            print(f"  [OK] {len(new_matches)} match card(s) + audit summary sent (Telegram)")
        except Exception as e:
            print(f"  [!] Telegram notifications failed (non-fatal): {e}")
    else:
        print("  [~] Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID")

    if args.simulate:
        print("  [SIM] Discord notifications skipped")
    elif discord_webhook:
        try:
            from pulseops_notify.discord import send_discord_match_card, send_discord_summary
            send_discord_summary(stats, new_matches, run_id, discord_webhook, settings)
            for m in new_matches:
                try:
                    send_discord_match_card(
                        job=m["job"], eval_result=m["eval_result"],
                        send_decision=m["send_decision"], pdf_path=m.get("pdf_path", ""),
                        webhook_url=discord_webhook, run_id=run_id,
                    )
                except Exception as e:
                    print(f"  [!] Discord match card failed for {m['company']}: {e}")
            print(f"  [OK] {len(new_matches)} match card(s) + audit summary sent (Discord)")
        except Exception as e:
            print(f"  [!] Discord notifications failed (non-fatal): {e}")
    else:
        print("  [~] Discord not configured — set DISCORD_WEBHOOK_URL")

    # ── PHASE 9 — Reply Check + Interview Prep + Follow-ups + TSV ────────
    _header("Phase 9: Reply Check + Interview Prep + Follow-ups")

    if args.simulate:
        # These helpers can read IMAP/SMTP-adjacent state, send notifications,
        # ingest platform jobs, or write follow-up/export state.  None belongs
        # in an offline run, even when their implementations accept a
        # simulate/dry_run flag.
        print("  [SIM] Reply checks, interview prep, follow-ups, export, and digest skipped")
    else:
        # 9a: IMAP reply + bounce + platform ingest (email_watcher runs hourly too)
        try:
            from pulseops_notify.email_watcher import run_watcher
            w = run_watcher(dry_run=False)
            print(f"  [OK] Watcher: bounces_fixed {w.get('bounces_fixed',0)}, platform_jobs {w.get('platform_jobs_ingested',0)}")
        except Exception as e:
            print(f"  [!] Watcher failed (non-fatal): {e}")
        try:
            from pulseops_notify.reply_detector import check_for_replies
            n_replies = check_for_replies(run_id=run_id, simulate=False,
                                           bot_token=telegram_token, chat_id=telegram_chat_id,
                                           webhook_url=discord_webhook)
            print(f"  [OK] Reply check: {n_replies} new reply/replies")
        except Exception as e:
            print(f"  [!] IMAP reply check failed (non-fatal): {e}")

        # 9b: Interview prep auto-trigger
        try:
            from pulseops_notify.interview_prep import check_and_send_prep_packs
            n_prep = check_and_send_prep_packs(run_id=run_id, bot_token=telegram_token,
                                                chat_id=telegram_chat_id,
                                                webhook_url=discord_webhook)
            print(f"  [OK] Interview prep packs: {n_prep} sent")
        except Exception as e:
            print(f"  [!] Interview prep trigger failed (non-fatal): {e}")

        # 9c: Day-5 follow-ups
        if settings.get("followup", {}).get("enabled", True):
            try:
                from pulseops_outreach.followup_engine import process_followups
                n_fu = process_followups(run_id=run_id, settings=settings, simulate=False)
                print(f"  [OK] Follow-ups sent: {n_fu}")
            except Exception as e:
                print(f"  [!] Follow-up engine failed (non-fatal): {e}")

        # 9d: TSV export
        try:
            from pulseops_store.tsv_exporter import export
            export(run_id=run_id)
        except Exception as e:
            print(f"  [!] TSV export failed (non-fatal): {e}")

        # 9e: Weekly digest (if Sunday 09:00 IST)
        try:
            from pulseops_notify.weekly_digest import send_weekly_digest, should_send_digest
            if should_send_digest():
                print("  [OK] It's Sunday 09:00 IST — sending weekly digest…")
                send_weekly_digest(bot_token=telegram_token, chat_id=telegram_chat_id,
                                   run_id=run_id, webhook_url=discord_webhook)
        except Exception as e:
            print(f"  [!] Weekly digest failed (non-fatal): {e}")

    _finish(run_id, stats, run_start, settings)


if __name__ == "__main__":
    main()
