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
ROOT = Path(__file__).parent
TEMP_PORTAL_JSON = ROOT / "temp_portal_jobs.json"


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

    from pulseops_store.db_manager import init_db, save_job, is_job_processed, enqueue_send
    from pulseops_store import audit_log

    init_db()
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
        "sent": 0, "queued": 0, "skipped": 0,
        "portals_dead": 0, "portals_auth_skipped": 0, "portals_failed": 0,
        "tokens_used": 0, "engines_used": {},
    }
    new_matches = []

    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "")

    # ── Phase 0: Liveness check ─────────────────────────────────────────
    _header("Phase 0: Portal Liveness Check")
    if args.skip_liveness or args.simulate:
        print("  [~] Skipped")
    else:
        dead = _run_liveness_check()
        stats["portals_dead"] = len(dead)
        if dead:
            print(f"  [!] {len(dead)} enabled portal(s) appear unreachable:")
            for d in dead:
                print(f"      - {d['name']}: {d['url']}")
            if telegram_token and telegram_chat_id:
                from pulseops_notify.notifier import send_telegram_summary
                msg = "⚠️ <b>PulseOps Weekly Scan — Dead Portals</b>\n" + "\n".join(
                    f"• {d['name']}: {d['url']}" for d in dead
                )
                send_telegram_summary(msg, telegram_token, telegram_chat_id)
        else:
            print("  [OK] All enabled, non-auth portals reachable")

    # ── Phase 1: Run the Playwright scan ────────────────────────────────
    _header("Phase 1: Portal Scan (Playwright)")
    raw_jobs, skipped_portals, failed_portals = _run_scan(simulate=args.simulate)
    stats["sourced"] = len(raw_jobs)
    stats["portals_auth_skipped"] = len(skipped_portals)
    stats["portals_failed"] = len(failed_portals)

    print(f"  Sourced:       {len(raw_jobs)} job(s)")
    print(f"  Auth-skipped:  {len(skipped_portals)} portal(s)")
    print(f"  Failed:        {len(failed_portals)} portal(s)")

    from pulseops_store.db_manager import record_source_health
    for f in failed_portals:
        record_source_health(f"Portal:{f['name']}", run_id, 0, f.get("error", ""))

    if skipped_portals and telegram_token and telegram_chat_id:
        from pulseops_notify.notifier import send_telegram_summary
        msg = "🔒 <b>PulseOps Weekly Scan — Auth Required</b>\nThese portals need a logged-in session; scan them by hand:\n" + "\n".join(
            f"• {s['name']}: {s['url']}" for s in skipped_portals
        )
        send_telegram_summary(msg, telegram_token, telegram_chat_id)

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
    from pulseops_eval.analyzer import evaluate_job, reset_circuit_breakers
    from pulseops_memory.context_loader import load_context
    from pulseops_core.cv_parser import parse_cv

    reset_circuit_breakers()
    try:
        cv_data = parse_cv(str(ROOT / "cv.md")) if (ROOT / "cv.md").exists() else None
    except Exception as e:
        print(f"  [!] CV parse failed ({e}) — using empty context (simulate mode)")
        cv_data = None

    for idx, job in enumerate(soft_passed, 1):
        title, company, link = job.get("title", "Unknown"), job.get("company", "Unknown"), job.get("link", "")
        source = job.get("source", "Portal")
        print(f"\n  [{idx}/{len(soft_passed)}] {title} @ {company}  ({source})")

        if not args.force and is_job_processed(title, company, link):
            print("    [~] Already processed")
            continue

        try:
            if args.simulate:
                eval_result = _mock_evaluation(title, company)
            else:
                memory_ctx = load_context(company=company)
                eval_result = evaluate_job(job=job, cv_data=cv_data, memory_context=memory_ctx,
                                           profile=profile, settings=settings)

            score = eval_result["match_percentage"]
            grade = eval_result["letter_grade"]
            engine = eval_result.get("engine", "simulation")
            tokens = eval_result.get("tokens_used", 0)
            duration = eval_result.get("eval_duration_ms", 0)

            print(f"    Score: {score}  Grade: {grade}  Engine: {engine}")
            stats["evaluated"] += 1
            stats["tokens_used"] += tokens
            stats["engines_used"][engine] = stats["engines_used"].get(engine, 0) + 1
            audit_log.write_eval(run_id, company, title, score, grade, engine, tokens, duration)

            job_id = save_job(
                title=title, company=company, link=link, source=source, run_id=run_id, score=score,
                posted_at=job.get("posted_at", ""), location_raw=job.get("location_raw", ""),
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
                status="Evaluated",
            )

            pdf_path = ""
            if score >= pdf_threshold:
                stats["matched_pdf"] += 1
                try:
                    from pulseops_core.resume_builder import build_resume
                    pdf_path, html_path = build_resume(
                        cv_data=cv_data, eval_result=eval_result, company=company,
                        role=title, simulate=args.simulate,
                    )
                    print(f"    [PDF] {pdf_path or html_path}")
                    from pulseops_store.db_manager import update_job_paths
                    update_job_paths(job_id, pdf_path=pdf_path, report_path=html_path)
                except Exception as e:
                    print(f"    [!] Resume build failed: {e}")

            send_decision = None
            if score >= notify_threshold:
                try:
                    from pulseops_outreach.send_engine import decide_send
                    send_decision = decide_send(job_id=job_id, job=job, eval_result=eval_result,
                                                settings=settings, run_id=run_id, simulate=args.simulate)
                    action, reason = send_decision["action"], send_decision.get("reason", "")
                    print(f"    [Send] {action}" + (f": {reason}" if reason else ""))
                    if action == "SEND":
                        stats["sent"] += 1
                    elif action == "QUEUE":
                        stats["queued"] += 1
                        enqueue_send(job_id, score, reason)
                    else:
                        stats["skipped"] += 1
                except Exception as e:
                    print(f"    [!] Send engine: {e}")
                    stats["skipped"] += 1

                new_matches.append({
                    "job": job, "job_id": job_id, "title": title, "company": company,
                    "score": score, "grade": grade, "pdf_path": pdf_path,
                    "eval_result": eval_result, "send_decision": send_decision,
                })

        except Exception as e:
            print(f"    [X] Unexpected: {e}")

    # ── Phase 8: Notifications ───────────────────────────────────────────
    _header("Phase 8: Telegram Notifications")
    if telegram_token and telegram_chat_id:
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

    try:
        from pulseops_store.tsv_exporter import export
        export()
    except Exception:
        pass


# ── Portal scan subprocess wiring ───────────────────────────────────────

def _run_liveness_check() -> list[dict]:
    """Runs check_liveness.mjs --json, returns the list of dead+enabled+non-auth portals."""
    try:
        result = subprocess.run(
            ["node", str(ROOT / "portal" / "check_liveness.mjs"), "--json"],
            capture_output=True, text=True, cwd=str(ROOT), timeout=120,
        )
        out = result.stdout.strip()
        # check_liveness.mjs prints the JSON as its only stdout in --json mode
        data = json.loads(out) if out else {"results": []}
        return [r for r in data.get("results", []) if not r["ok"] and r["enabled"] and not r["requires_auth"]]
    except Exception as e:
        print(f"  [!] Liveness check failed to run: {e}")
        return []


def _run_scan(simulate: bool) -> tuple[list[dict], list[dict], list[dict]]:
    """Runs portal/scan.mjs (live or --mock), returns (jobs, skipped_auth, failed)."""
    cmd = ["node", str(ROOT / "portal" / "scan.mjs")]
    if simulate:
        cmd.append("--mock")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=900)
        if result.returncode != 0:
            print(f"  [!] scan.mjs exited {result.returncode}: {result.stderr.strip()[-400:]}")
    except subprocess.TimeoutExpired:
        print("  [!] scan.mjs timed out after 15 minutes")
    except Exception as e:
        print(f"  [!] Could not launch scan.mjs: {e}")

    if not TEMP_PORTAL_JSON.exists():
        print("  [!] scan.mjs did not write temp_portal_jobs.json — treating as zero results")
        return [], [], []

    try:
        data = json.loads(TEMP_PORTAL_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [!] Could not parse temp_portal_jobs.json: {e}")
        return [], [], []
    finally:
        try:
            TEMP_PORTAL_JSON.unlink()
        except Exception:
            pass

    jobs = data.get("jobs", [])
    for j in jobs:
        j.setdefault("description", "")
    return jobs, data.get("skipped", []), data.get("failed", [])


# ── Shared helpers (mirrors main.py) ─────────────────────────────────────

def _finish(run_id: str, stats: dict, start: float) -> None:
    duration = int(time.time() - start)
    stats["duration_seconds"] = duration
    from pulseops_store.db_manager import save_run_stats
    from pulseops_store import audit_log
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


def _load_settings() -> dict:
    import yaml
    for p in [ROOT / "config" / "settings.yml", ROOT / "config" / "settings.yml.example"]:
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
              ROOT / "config" / "profile.yml.example"]:
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
