"""
main_weekly.py — PulseOps Weekly Portal Scan Orchestrator (Phase 11)

Runs the Naukri / Instahyre / Wellfound India / ATS-board deep scan
(portal/scan.mjs) and feeds the results through the exact same Phase
2-9 pipeline main.py uses for the daily API sources: dedup, location
filter, Stage 1+2 domain filter, full evaluation, resume build, send
guardrails, Telegram notifications.

Why a separate entry point instead of folding into main.py: the portal
scan is heavyweight (real browser, dozens of page loads, ~minutes not
seconds) and meant to run once a week (Sunday morning per
config/settings.yml `portal.run_day`), not on every daily cron tick.
Keeping it separate also means a slow/flaky portal scan can never block
the daily send pipeline.

Usage:
  python main_weekly.py                 Live: liveness check → scan → evaluate → send
  python main_weekly.py --simulate       Offline: mock portal data, zero network/API calls
  python main_weekly.py --skip-liveness  Skip the pre-flight URL check
  python main_weekly.py --force          Re-evaluate jobs already seen
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# google-genai 2.24 warns once per process that `models.generate_content` with
# automatic function calling is deprecated in favour of `chats.send_message`.
# Six call sites use it (analyzer, domain_filter, profile_builder, memory_parser,
# github_sync, verify_key2) and they still work, so this is a deprecation notice
# rather than a fault.
#
# It is silenced here because it is actively harmful in this pipeline: it goes to
# stderr, PowerShell surfaces stderr as a NativeCommandError, and a deprecation
# notice rendered as an error is indistinguishable from a real failure in the run
# log. It cost a full diagnostic cycle once already - the weekly run looked dead
# when it had in fact completed and moved 5 rows.
#
# Migrating the six call sites to chats.send_message is the real fix and is left
# deliberately undone here: it changes response handling at six production LLM
# call sites, and the only provider with working credit is the Groq fallback, so
# a partial migration would be untestable.
import logging as _logging

# The SDK's logger is "google_genai.models" - underscore, not dotted. Targeting
# "google.genai" silences a logger that does not exist and changes nothing.
for _name in ("google_genai", "google_genai.models"):
    _logging.getLogger(_name).setLevel(_logging.ERROR)
try:
    from pulseops_config.paths import repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parents[4]
TEMP_PORTAL_JSON = ROOT / "temp_portal_jobs.json"
SIMULATED_SOURCE_PREFIX = "SIMULATED:"


def _source_is_simulated(source: object) -> bool:
    """Return whether a source is already explicitly marked as simulated."""
    return str(source or "").strip().upper().startswith(SIMULATED_SOURCE_PREFIX)


def _source_is_mock(source: object) -> bool:
    """Recognise legacy mock labels before they reach persistence."""
    value = str(source or "").strip()
    if _source_is_simulated(value):
        value = value[len(SIMULATED_SOURCE_PREFIX):].strip()
    return value.lower() == "mock" or value.lower().startswith(("mock:", "mock-"))


def _mark_simulated_job(job: dict) -> dict:
    """Mark a job in-place while retaining the original source name.

    The prefix is deliberately stored in ``source`` (rather than only in an
    in-memory flag) so a row can never be mistaken for a live sourcing result
    if it is later inspected or exported.  ``source_original`` is retained for
    audit/debugging and is never used as a replacement for the marked source.
    """
    raw_source = str(job.get("source") or "Portal").strip() or "Portal"
    if _source_is_simulated(raw_source):
        original_source = raw_source[len(SIMULATED_SOURCE_PREFIX):].strip() or "Portal"
    else:
        original_source = raw_source
    job.setdefault("source_original", original_source)
    job["source"] = f"{SIMULATED_SOURCE_PREFIX}{original_source}"
    job["simulated"] = True
    return job


def _mark_simulated_jobs(jobs: list[dict] | None) -> list[dict]:
    """Mark valid job dictionaries without changing their source metadata."""
    return [_mark_simulated_job(job) for job in (jobs or []) if isinstance(job, dict)]


def _use_isolated_simulation_db() -> None:
    """Point simulation persistence away from the live jobs/outreach DB."""
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


def main() -> None:
    if sys.platform.startswith("win"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    parser = argparse.ArgumentParser(description="PulseOps Weekly Portal Scan")
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--skip-liveness", action="store_true")
    args = parser.parse_args()

    if args.simulate:
        _use_isolated_simulation_db()

    from pulseops_store import audit_log
    from pulseops_store.db_manager import (
        enqueue_send,
        get_job_for_identity,
        get_send_paused,
        init_db,
        is_job_processed,
        is_protected_job_status,
        save_job,
        update_job_status,
    )

    init_db()
    if not args.simulate:
        _protect_pending_email_queue()
    run_id = audit_log.generate_run_id()
    run_start = time.time()

    _header(f"PulseOps Weekly Portal Scan [{run_id}]")
    print(f"  Mode: {'SIMULATION' if args.simulate else 'LIVE'}")
    print(f"  Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    audit_log.write_run_start(run_id, run_type="weekly")

    settings = _load_settings()
    pdf_threshold = settings["scoring"]["pdf_threshold"]
    notify_threshold = settings["scoring"]["notify_threshold"]

    stats = {
        "sourced": 0, "after_dedup": 0, "after_location": 0,
        "after_hard_filter": 0, "after_soft_filter": 0,
        "evaluated": 0, "matched_pdf": 0,
        "sent": 0, "queued": 0, "skipped": 0, "uncertain": 0,
        "portals_dead": 0, "portals_auth_skipped": 0, "portals_failed": 0,
        "tokens_used": 0, "engines_used": {},
    }
    new_matches = []

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

    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "")

    # ── Phase 0: Liveness check ─────────────────────────────────────────
    _header("Phase 0: Portal Liveness Check")
    dead_portals: list[dict] = []
    if args.skip_liveness or args.simulate:
        print("  [~] Skipped")
    else:
        dead_portals = _run_liveness_check()
        if dead_portals is None:
            print("  [!] Liveness check failed closed; refusing to start the scan")
            _finish(run_id, stats, run_start)
            sys.exit(1)
        stats["portals_dead"] = len(dead_portals)
        if dead_portals:
            print(f"  [!] {len(dead_portals)} enabled portal(s) appear unreachable:")
            for d in dead_portals:
                print(f"      - {d.get('name', 'unknown')}: {d.get('url', '')}")
            if not args.simulate and telegram_token and telegram_chat_id:
                from pulseops_notify.notifier import send_telegram_summary
                msg = "⚠️ <b>PulseOps Weekly Scan — Dead Portals</b>\n" + "\n".join(
                    f"• {d.get('name', 'unknown')}: {d.get('url', '')}" for d in dead_portals
                )
                send_telegram_summary(msg, telegram_token, telegram_chat_id)
        else:
            print("  [OK] All enabled, non-auth portals reachable")

    # ── Phase 1: Run the Playwright scan ────────────────────────────────
    _header("Phase 1: Portal Scan (Playwright)")
    raw_jobs, skipped_portals, failed_portals = _run_scan(
        simulate=args.simulate,
        dead_portals=dead_portals,
    )
    if args.simulate:
        # Mark at the ingestion boundary, before dedup or any persistence.
        raw_jobs = _mark_simulated_jobs(raw_jobs)
    stats["sourced"] = len(raw_jobs)
    stats["portals_auth_skipped"] = len(skipped_portals)
    stats["portals_failed"] = len(failed_portals)

    print(f"  Sourced:       {len(raw_jobs)} job(s)")
    print(f"  Auth-skipped:  {len(skipped_portals)} portal(s)")
    print(f"  Failed:        {len(failed_portals)} portal(s)")
    # Name them. A count of skipped sources is undiagnosable: it hides which
    # half of the configured coverage was never even looked at, which is the
    # whole reason a scan can look healthy while sourcing almost nothing.
    for label, group in (("auth-skipped", skipped_portals), ("failed", failed_portals)):
        for entry in group:
            name = entry.get("name") if isinstance(entry, dict) else entry
            reason = entry.get("reason", "") if isinstance(entry, dict) else ""
            print(f"    - {label}: {name}{(' — ' + str(reason)[:80]) if reason else ''}")

    if not args.simulate:
        from pulseops_store.db_manager import record_source_health
        for f in failed_portals:
            record_source_health(f"Portal:{f.get('name', 'unknown')}", run_id, 0, f.get("error", ""))

    if not args.simulate and skipped_portals and telegram_token and telegram_chat_id:
        from pulseops_notify.notifier import send_telegram_summary
        msg = "🔒 <b>PulseOps Weekly Scan — Auth Required</b>\nThese portals need a logged-in session; scan them by hand:\n" + "\n".join(
            f"• {s.get('name', 'unknown')}: {s.get('url', '')}" for s in skipped_portals
        )
        send_telegram_summary(msg, telegram_token, telegram_chat_id)
    elif args.simulate and skipped_portals:
        print("  [SIM] Auth/disabled portal notices are local only")

    if not raw_jobs:
        print("[!] No jobs sourced from portal scan. Exiting.")
        _finish(run_id, stats, run_start)
        sys.exit(0)

    # ── Phase 2: Dedup + Location (same modules as the daily pipeline) ──
    _header("Phase 2: Dedup + Location Filter")
    from pulseops_eval.deduplicator import deduplicate
    from pulseops_eval.location_filter import filter_by_location

    deduped = deduplicate(raw_jobs, run_id=run_id)
    stats["after_dedup"] = len(deduped)
    print(f"  After dedup:    {len(deduped)} (dropped {stats['sourced'] - len(deduped)})")

    located = filter_by_location(deduped, settings.get("sourcing", {}), run_id=run_id)
    stats["after_location"] = len(located)
    print(f"  After location: {len(located)} (dropped {len(deduped) - len(located)})")

    # ── Phase 3-4: Domain filter ─────────────────────────────────────────
    _header("Phase 3: Domain Hard Filter (Stage 1)")
    from pulseops_eval.domain_filter import hard_filter, soft_filter
    profile = _load_profile()
    hard_passed = []
    for job in located:
        result = hard_filter(job, profile)
        if result.passed:
            hard_passed.append(job)
        else:
            audit_log.write_filter_reject(run_id, job.get("company", ""),
                                          job.get("title", ""), 1, result.reason)
    stats["after_hard_filter"] = len(hard_passed)
    print(f"  After hard filter: {len(hard_passed)} (rejected {len(located) - len(hard_passed)})")

    _header("Phase 4: Domain Soft Filter (Stage 2)")
    soft_passed = []
    for job in hard_passed:
        if args.simulate:
            soft_passed.append(job)
            continue
        result = soft_filter(job, profile)
        if result.passed:
            soft_passed.append(job)
        else:
            audit_log.write_filter_reject(run_id, job.get("company", ""),
                                          job.get("title", ""), 2, result.reason)
    stats["after_soft_filter"] = len(soft_passed)
    print(f"  After soft filter: {len(soft_passed)} (rejected {len(hard_passed) - len(soft_passed)})")

    if not soft_passed:
        print("[!] No jobs passed domain filters. Exiting.")
        _finish(run_id, stats, run_start)
        sys.exit(0)

    # ── Phase 5-7: Evaluate + Resume + Send ─────────────────────────────
    _header("Phase 5-7: Evaluate + Build + Send")
    from pulseops_core.cv_parser import parse_cv
    from pulseops_eval.analyzer import evaluate_job, reset_circuit_breakers
    from pulseops_memory.context_loader import load_context

    reset_circuit_breakers()
    try:
        cv_data = parse_cv(str(ROOT / "cv.md")) if (ROOT / "cv.md").exists() else None
    except Exception as e:
        print(f"  [!] CV parse failed ({e}) — using empty context (simulate mode)")
        cv_data = None

    for idx, job in enumerate(soft_passed, 1):
        # A marker is applied before the processed-row check and therefore
        # before any possible save_job call.  This also protects a live run
        # that encounters a mock-labelled source in its input.
        if args.simulate or _source_is_simulated(job.get("source", "")) or _source_is_mock(job.get("source", "")):
            _mark_simulated_job(job)
        title, company, link = job.get("title", "Unknown"), job.get("company", "Unknown"), job.get("link", "")
        source = job.get("source", "Portal")
        simulated_job = _source_is_simulated(source)
        send_paused = False
        if not simulated_job:
            send_paused = _send_pause_active(get_send_paused)
        print(f"\n  [{idx}/{len(soft_passed)}] {title} @ {company}  ({source})")

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
            print("    [~] Already processed" + (" (simulation rows are never overwritten)" if simulated_job else ""))
            continue

        try:
            if args.simulate or simulated_job:
                eval_result = _mock_evaluation(title, company)
                eval_result["simulated"] = True
            else:
                memory_ctx = load_context(company=company)
                eval_result = evaluate_job(job=job, cv_data=cv_data, memory_context=memory_ctx,
                                           profile=profile, settings=settings)

            score = eval_result["match_percentage"]
            grade = eval_result["letter_grade"]
            engine = eval_result.get("engine", "simulation")
            tokens = eval_result.get("tokens_used", 0)
            duration = eval_result.get("eval_duration_ms", 0)

            # A missing/failed evaluator can fall back to simulation even in
            # a nominally live run.  Treat that exactly like --simulate so a
            # mock result can never become a sendable/live job.
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

            job_id = save_job(
                title=title, company=company, link=link, source=source, run_id=run_id, score=score,
                letter_grade=grade, posted_at=job.get("posted_at", ""), location_raw=job.get("location_raw", ""),
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
                # Simulated/paused rows are deliberately kept out of the
                # browser-apply query (which only consumes Evaluated jobs).
                status=("Simulated" if simulated_job else
                        "SendPaused" if send_paused else "Evaluated"),
            )

            pdf_path = ""
            if score >= pdf_threshold:
                stats["matched_pdf"] += 1
                try:
                    from pulseops_core.resume_builder import build_resume
                    pdf_path, html_path = build_resume(
                        cv_data=cv_data, eval_result=eval_result, company=company,
                        role=title, jd_text=job.get("description", ""),
                        profile=profile,
                        simulate=args.simulate or simulated_job or send_paused,
                    )
                    print(f"    [PDF] {pdf_path or html_path}")
                    if not simulated_job and not send_paused:
                        from pulseops_store.db_manager import update_job_paths
                        update_job_paths(job_id, pdf_path=pdf_path, report_path=html_path)
                    elif simulated_job:
                        print("    [SIM] HTML-only resume; no live DB path update")
                    else:
                        print("    [PAUSE] HTML-only resume; no live DB path update")
                except Exception as e:
                    print(f"    [!] Resume build failed: {e}")

            send_decision = None
            if score >= notify_threshold:
                if simulated_job:
                    # Never invoke decide_send in simulation: even its
                    # simulate=True path performs G10 cache/network work.
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
                            settings=settings, run_id=run_id,
                            simulate=False, pdf_path=pdf_path,
                        )
                    except Exception as e:
                        print(f"    [!] Send engine: {e}")
                        send_decision = {
                            "action": "SKIP",
                            "reason": f"send engine error: {e}",
                            "guardrail": "ERROR",
                        }

                action, reason = send_decision["action"], send_decision.get("reason", "")
                print(f"    [Send] {action}" + (f": {reason}" if reason else ""))
                if action == "SEND":
                    stats["sent"] += 1
                elif action == "QUEUE":
                    stats["queued"] += 1
                    # send_queue is an e-mail overflow queue.  Mark the job
                    # before enqueueing so a crash cannot leave an Evaluated
                    # row that an unattended browser consumer could select.
                    update_job_status(job_id, "EmailQueued")
                    enqueue_send(job_id, score, reason)
                else:
                    stats["skipped"] += 1

                new_matches.append({
                    "job": job, "job_id": job_id, "title": title, "company": company,
                    "score": score, "grade": grade, "pdf_path": pdf_path,
                    "eval_result": eval_result, "send_decision": send_decision,
                })

        except Exception as e:
            # A dead LLM engine is the overwhelmingly common cause and it is not
            # per-job: 123 identical "All engines failed" lines is one quota
            # problem, not 123 problems. Count them so the summary can say so
            # instead of the run looking healthy while producing nothing.
            if "All engines failed" in str(e) or "circuit-broken" in str(e):
                stats["engine_failed"] = stats.get("engine_failed", 0) + 1
                if stats["engine_failed"] == 1:
                    print("    [!] an LLM engine is exhausted; see the CircuitBreaker line above.")
                    print("    [!] every remaining job will fail the same way. "
                          "Set GROQ_API_KEY or OPENAI_API_KEY in .env for a fallback.")
            else:
                print(f"    [X] Unexpected: {e}")

    # ── Phase 7b: G10 human-review delivery ──────────────────────────────
    _header("Phase 7b: G10 Human Review")
    if args.simulate:
        print("  [SIM] Discord review flush skipped")
    else:
        try:
            from pulseops_outreach.send_engine import flush_pending_review_cards
            review_result = flush_pending_review_cards(run_id=run_id, limit=20)
            print(f"  Discord review cards: {review_result['posted']} posted, "
                  f"{review_result['pending']} pending, {review_result['failed']} failed")
        except Exception as e:
            print(f"  [!] G10 review delivery failed (non-fatal): {e}")

    # ── Phase 8: Notifications ───────────────────────────────────────────
    _header("Phase 8: Telegram Notifications")
    if args.simulate:
        print("  [SIM] Telegram/Discord notifications skipped")
    elif telegram_token and telegram_chat_id:
        try:
            from pulseops_notify.notifier import send_audit_summary, send_match_card
            send_audit_summary(stats, new_matches, run_id, telegram_token, telegram_chat_id)
            for m in new_matches:
                send_match_card(job=m["job"], eval_result=m["eval_result"], send_decision=m["send_decision"],
                                pdf_path=m["pdf_path"], bot_token=telegram_token, chat_id=telegram_chat_id)
            print(f"  [OK] {len(new_matches)} match card(s) + audit summary sent")
        except Exception as e:
            print(f"  [!] Telegram error: {e}")
    else:
        print("  [~] Telegram not configured")

    _finish(run_id, stats, run_start)

    if not args.simulate:
        try:
            from pulseops_store.tsv_exporter import export
            export()
        except Exception:
            pass
    else:
        print("  [SIM] TSV export skipped")

    # A dead LLM cascade is a failed run even though every phase completed. The
    # browser-apply stage downstream consumes only Evaluated rows, so exiting 0
    # here hands it an empty queue and reports an empty run as a success.
    if _DEAD_ENGINE:
        sys.exit(3)


# ── Portal scan subprocess wiring ───────────────────────────────────────

def _portal_script(name: str) -> Path:
    """New Tier-2 location first, old flat layout as fallback."""
    for cand in [ROOT / "apps" / "weekly-scan" / name, ROOT / "portal" / name]:
        if cand.exists():
            return cand
    return ROOT / "apps" / "weekly-scan" / name


def _run_liveness_check() -> list[dict] | None:
    """Return dead enabled portals, or ``None`` when the check itself failed.

    ``check_liveness.mjs --json`` deliberately exits successfully when the
    check completes, even if the report contains dead portals.  Only a tool
    failure is represented by ``None``; valid dead records are passed to the
    scanner so it can skip exactly those portals.
    """
    # The check probes every enabled portal in a real browser, which takes
    # several minutes. A 120s cap killed it mid-run, and because a tool failure
    # is fail-closed the whole scan was refused — so it sourced nothing at all.
    # Overridable, and long enough for the slowest observed run (~7 minutes).
    try:
        liveness_timeout = int(os.environ.get("PULSEOPS_LIVENESS_TIMEOUT_S", "900"))
    except ValueError:
        liveness_timeout = 900
    try:
        result = subprocess.run(
            ["node", str(_portal_script("check_liveness.mjs")), "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(ROOT), timeout=liveness_timeout,
        )
        returncode = getattr(result, "returncode", 0)
        if returncode != 0:
            print(f"  [!] Liveness check exited {returncode}")
            return None
        out = (getattr(result, "stdout", "") or "").strip()
        if not out:
            print("  [!] Liveness check returned no JSON")
            return None
        data = json.loads(out)
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            print("  [!] Liveness check returned an invalid payload")
            return None
        dead: list[dict] = []
        flaky: list[dict] = []
        for record in data["results"]:
            if not isinstance(record, dict):
                continue
            # The Node tool emits booleans.  Requiring them prevents malformed
            # records (for example, a missing ``ok`` field) from being treated
            # as a real dead portal and accidentally skipped.
            if not (
                record.get("ok") is False
                and record.get("enabled") is True
                and record.get("requires_auth", False) in (False, None)
            ):
                continue
            # A portal is only skipped when the probe was definitive — the board
            # answered 404/410. Timeouts and 5xx are the network's mood, and
            # skipping on those silently deleted live boards from the funnel:
            # Anthropic answers 200 in well under a second, yet was skipped as
            # unreachable, which cost every job on it. Retryable failures are
            # reported and left enabled so the scanner still tries them.
            if record.get("dead_confidently") is False:
                flaky.append(record)
                print(
                    f"  [~] {record.get('name', 'unknown')}: probe did not settle "
                    f"after {record.get('attempts', '?')} attempts "
                    f"(status={record.get('status')} error={record.get('error')}) — "
                    f"leaving ENABLED so the scanner still tries it"
                )
                continue
            dead.append(record)
        if flaky:
            print(
                f"  [~] {len(flaky)} portal(s) failed inconclusively and were NOT skipped. "
                f"These are network conditions, not dead boards."
            )
        return dead
    except Exception as e:
        print(f"  [!] Liveness check failed to run: {e}")
        return None


def _remove_temp_portal_json() -> None:
    """Remove a previous scan hand-off so it can never be mistaken for fresh."""
    try:
        TEMP_PORTAL_JSON.unlink(missing_ok=True)
    except (OSError, TypeError) as e:
        print(f"  [!] Could not remove stale temp_portal_jobs.json: {e}")


def _run_scan(
    simulate: bool,
    dead_portals: list[dict] | None = None,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Run the scanner and accept only a successful, fresh hand-off.

    The JSON file is a process hand-off, not a durable result store.  Delete
    it before launch and require both a zero exit status and an mtime from
    this invocation.  A failed, timed-out, or stale scan therefore always
    returns zero jobs rather than replaying an earlier run.
    """
    _remove_temp_portal_json()
    scan_started = time.time()
    cmd = ["node", str(_portal_script("scan.mjs"))]
    if simulate:
        cmd.append("--mock")

    # Pass liveness failures to the Node scanner so it can skip them before a
    # browser navigation, rather than filtering their jobs after the fact.
    skip_values: set[str] = set()
    for portal in dead_portals or []:
        if not isinstance(portal, dict):
            continue
        # The scanner treats every --skip-portal value as a possible engine,
        # company, name, or URL.  Passing an engine/company alias could skip
        # healthy portals that merely share it, so use the portal URL (the
        # stable identity supplied by liveness) and only fall back to a name
        # for a malformed record with no URL.
        value = str(portal.get("url", "") or "").strip()
        if not value:
            value = str(portal.get("name", "") or "").strip()
        if value:
            skip_values.add(value)
    for value in sorted(skip_values):
        cmd.append(f"--skip-portal={value}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ROOT),
            timeout=900,
        )
        if result.returncode != 0:
            print(f"  [!] scan.mjs exited {result.returncode}: {(result.stderr or '')[-400:]}")
            _remove_temp_portal_json()
            return [], [], []
    except subprocess.TimeoutExpired:
        print("  [!] scan.mjs timed out after 15 minutes")
        _remove_temp_portal_json()
        return [], [], []
    except Exception as e:
        print(f"  [!] Could not launch scan.mjs: {e}")
        _remove_temp_portal_json()
        return [], [], []

    if not TEMP_PORTAL_JSON.exists():
        print("  [!] scan.mjs did not write temp_portal_jobs.json — treating as zero results")
        return [], [], []

    try:
        mtime = TEMP_PORTAL_JSON.stat().st_mtime
    except OSError as e:
        print(f"  [!] Could not stat temp_portal_jobs.json: {e}")
        _remove_temp_portal_json()
        return [], [], []

    # The hand-off must have been written during this invocation.  A tiny
    # timestamp allowance covers filesystems with coarse mtime resolution,
    # while a file left by an earlier run is still rejected.
    if mtime < scan_started - 0.05:
        print("  [!] scan.mjs output is stale — treating as zero results")
        _remove_temp_portal_json()
        return [], [], []

    try:
        data = json.loads(TEMP_PORTAL_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [!] Could not parse temp_portal_jobs.json: {e}")
        return [], [], []
    finally:
        _remove_temp_portal_json()

    if not isinstance(data, dict) or not isinstance(data.get("jobs", []), list):
        print("  [!] scan.mjs returned an invalid payload — treating as zero results")
        return [], [], []

    jobs = [job for job in data.get("jobs", []) if isinstance(job, dict)]
    for job in jobs:
        job.setdefault("description", "")
    if simulate:
        _mark_simulated_jobs(jobs)

    skipped = [item for item in data.get("skipped", []) if isinstance(item, dict)]
    failed = [item for item in data.get("failed", []) if isinstance(item, dict)]
    return jobs, skipped, failed


# ── Shared helpers (mirrors main.py) ─────────────────────────────────────

# Set by _finish() when the LLM cascade could not score a single job. Read back
# by the exit path so a dead quota is a failed run, not a quiet success.
_DEAD_ENGINE = False


def _finish(run_id: str, stats: dict, start: float) -> None:
    duration = int(time.time() - start)
    stats["duration_seconds"] = duration
    from pulseops_store import audit_log
    from pulseops_store.db_manager import save_run_stats
    save_run_stats(run_id, "weekly", stats)
    audit_log.write_run_end(run_id, stats)
    _header("Weekly Scan Complete")
    for k, v in [
        ("Sourced", stats["sourced"]), ("After dedup", stats["after_dedup"]),
        ("After filters", stats["after_soft_filter"]), ("Evaluated", stats["evaluated"]),
        ("PDFs built", stats["matched_pdf"]), ("Sent", stats["sent"]),
        ("Queued", stats["queued"]), ("Skipped", stats["skipped"]),
        ("Dead portals", stats["portals_dead"]), ("Auth-skipped", stats["portals_auth_skipped"]),
        ("Tokens used", stats["tokens_used"]), ("Duration", f"{duration}s"),
    ]:
        print(f"  {k:<18} {v}")

    # A run that sourced and filtered real jobs but evaluated NONE of them has
    # not succeeded, whatever the exit code says. Exiting 0 here is what made a
    # dead daily quota look like a normal run for 21 minutes before anyone
    # noticed Evaluated=0. Make it loud and make it a non-zero exit so the
    # automation reports the failure instead of quietly yielding an empty queue.
    engine_failed = int(stats.get("engine_failed", 0) or 0)
    if engine_failed and not stats["evaluated"]:
        print()
        print("  [FAILED] Every candidate job failed evaluation: the only configured LLM")
        print("           engine is out of quota, and no fallback key is present.")
        print(f"           {engine_failed} job(s) could not be scored in {duration}s.")
        print("           Add GROQ_API_KEY or OPENAI_API_KEY to .env to restore the cascade.")
        _DEAD_ENGINE = True
    elif engine_failed:
        print()
        print(f"  [WARN] {engine_failed} job(s) failed evaluation (LLM engine exhausted); "
              f"{stats['evaluated']} were scored successfully.")


def _load_settings() -> dict:
    import yaml
    for p in [ROOT / "config" / "settings.yml", ROOT / "config" / "settings.yml.example",
                ROOT / "packages" / "pulse-config" / "config" / "settings.yml.example"]:
        if p.exists():
            try:
                with open(p) as f:
                    data = yaml.safe_load(f) or {}
                    if data.get("scoring"):
                        return data
            except Exception:
                pass
    return {"scoring": {"send_threshold": 88, "pdf_threshold": 75, "notify_threshold": 70},
            "guardrails": {}, "sourcing": {}, "portal": {}}


def _load_profile() -> dict:
    import yaml
    for p in [ROOT / "config" / "profile.yml",
              ROOT / "config" / "profile.yml.example",
              ROOT / "packages" / "pulse-config" / "config" / "profile.yml.example"]:
        if p.exists():
            try:
                with open(p) as f:
                    data = yaml.safe_load(f) or {}
                    if data:
                        return data
            except Exception:
                continue
    print("[!] profile.yml not found — run: python doctor.py --init (using empty profile)")
    return {}


def _mock_evaluation(title: str, company: str) -> dict:
    score = 88 if any(k in title.lower() for k in ["java", "python", "backend", "c++", "go", "engineer"]) else 65
    grade = "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "D"
    return {
        "match_percentage": score, "letter_grade": grade,
        "text_summary": f"[Sim/Weekly] Backend match for {title} at {company}.",
        "bullet_adjustments": [{"original": "Built API service",
                                 "tailored": "Engineered REST API handling 10k RPS using Java + Spring Boot"}],
        "skill_gap": ["System Design"], "tailored_skills": ["Java", "Spring Boot", "PostgreSQL", "Docker"],
        "recruiter_message": f"Hi, interested in {title} at {company}.",
        "recruiter_email": f"Subject: Application — {title}\n\nHi,\n\nI'd love to discuss the {title} role.",
        "contact_email": "", "inferred_domain": f"{company.lower().replace(' ', '')}.com",
        "domain_confidence": "low",
        "level_strategy": "Position as high-potential new grad.",
        "comp_research": "Entry-level backend India: INR 8-18 LPA.",
        "star_stories": [{"question": "Tell me about a technical challenge.",
                           "answer": "S: Needed fast API. T: 2 week deadline. A: Java+Spring. R: Shipped on time."}],
        "negotiation_notes": "Counter below INR 10 LPA with project metrics.",
        "email_variant_used": "technical_lead",
        "engine": "simulation", "tokens_used": 0, "eval_duration_ms": 500,
    }


if __name__ == "__main__":
    main()
