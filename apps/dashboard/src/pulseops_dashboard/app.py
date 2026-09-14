"""
dashboard/app.py — PulseOps Flask Dashboard (Phase 10)

Read-only-by-default web view over the same pulseops.db the daily pipeline
writes to. Manual status overrides and pause/resume are the only writes —
everything else (sends, evaluations, resumes) stays in main.py's hands.

Routes:
  GET  /                       Dashboard SPA shell
  GET  /api/jobs               Job table (filter by status, search)
  POST /api/jobs/<id>/status   Manual status override (human-in-the-loop)
  GET  /api/stats              Funnel counts + callback rate by score band/variant
  GET  /api/queue              Pending send_queue items (cap/window overflow)
  GET  /api/memory             Active memories + pending cv_candidates
  GET  /api/audit              Tail of the current month's audit log
  GET  /api/digest             On-demand weekly digest preview (text)
  GET  /api/source-health      Per-source consecutive-zero tracking
  POST /api/run                Spawn main.py as a subprocess (simulate or live)
  GET  /api/run/stream         SSE stream of the running pipeline's stdout
  POST /api/pause              Pause auto-sends
  POST /api/resume             Resume auto-sends
  GET  /pdf/<filename>         Serve a generated resume PDF
  GET  /api/health             doctor.py --check, JSON-encoded

Run: python main.py --dashboard   (or: python dashboard/app.py)
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # allow `python dashboard/app.py` standalone

app = Flask(__name__, template_folder="templates")

_log_queue: queue.Queue[str] = queue.Queue(maxsize=2000)
_running_process: subprocess.Popen | None = None
_process_lock = threading.Lock()


# ── Helpers ──────────────────────────────────────────────────────────────

def _db():
    from pulseops_store import db_manager
    db_manager.init_db()
    return db_manager


def _since(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).isoformat()


def _require_token():
    want = os.getenv("DASHBOARD_TOKEN", "")
    if not want:
        return None  # auth disabled (local-only default); run_server binds 127.0.0.1
    got = request.headers.get("X-Token", "")
    if got != want:
        return jsonify({"success": False, "error": "unauthorized"}), 401
    return None


# ── Page ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Jobs ─────────────────────────────────────────────────────────────────

@app.route("/api/jobs", methods=["GET"])
def get_jobs():
    try:
        db = _db()
        status = request.args.get("status", "")
        q = request.args.get("q", "").lower().strip()
        limit = int(request.args.get("limit", 300))

        if status:
            jobs = db.get_jobs_by_status([status], limit=limit)
        else:
            jobs = db.get_all_jobs(limit=limit)

        if q:
            jobs = [j for j in jobs
                    if q in (j.get("title", "") or "").lower()
                    or q in (j.get("company", "") or "").lower()]

        return jsonify({"success": True, "jobs": jobs, "count": len(jobs)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/jobs/<int:job_id>/status", methods=["POST"])
def set_job_status(job_id):
    auth = _require_token()
    if auth:
        return auth
    try:
        db = _db()
        new_status = (request.json or {}).get("status", "").strip()
        if not new_status:
            return jsonify({"success": False, "error": "Missing 'status'"}), 400
        db.update_job_status(job_id, new_status)
        try:
            from pulseops_store import audit_log
            audit_log.write("DASHBOARD_STATUS_OVERRIDE", extra={
                "job_id": job_id, "new_status": new_status,
            })
        except Exception:
            pass
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/jobs/<int:job_id>/mark-outreach", methods=["POST"])
def mark_outreach(job_id):
    """
    Logs a manually-sent LinkedIn DM (or referral follow-through) against
    this job. This is the primary way outreach gets tracked in dm_first
    mode — see persistence/db_manager.py:log_manual_outreach for why this
    matters beyond record-keeping (G5 cooldown visibility + callback-rate
    calibration data).
    """
    auth = _require_token()
    if auth:
        return auth
    try:
        db = _db()
        body = request.json or {}
        channel = (body.get("channel") or "linkedin_dm").strip()
        notes = (body.get("notes") or "").strip()

        job = db.get_job(job_id)
        if not job:
            return jsonify({"success": False, "error": f"Job {job_id} not found"}), 404

        outreach_id = db.log_manual_outreach(
            job_id=job_id, company=job.get("company", ""),
            channel=channel, notes=notes,
            domain=job.get("inferred_domain", ""),
        )
        try:
            from pulseops_store import audit_log
            audit_log.write("MANUAL_OUTREACH_LOGGED", extra={
                "job_id": job_id, "channel": channel,
            })
        except Exception:
            pass
        return jsonify({"success": True, "outreach_id": outreach_id})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Stats / funnel ───────────────────────────────────────────────────────

@app.route("/api/stats", methods=["GET"])
def get_stats():
    try:
        db = _db()
        since_iso = _since(7)

        all_jobs = db.get_all_jobs(limit=5000)
        funnel = {}
        for j in all_jobs:
            s = j.get("status", "Sourced")
            funnel[s] = funnel.get(s, 0) + 1

        last_runs = db.get_last_n_runs(7)
        score_bands = db.get_callback_rate_by_score_band(since_iso)
        variants = db.get_callback_rate_by_variant(since_iso)
        top_gaps = db.get_top_skill_gaps(since_iso, top_n=8)
        send_paused = db.get_send_paused()
        channel_breakdown = db.get_outreach_channel_breakdown(since_iso)

        return jsonify({
            "success": True,
            "funnel": funnel,
            "total_jobs": len(all_jobs),
            "last_runs": last_runs,
            "score_bands": score_bands,
            "variants": variants,
            "top_skill_gaps": [{"skill": s, "count": c} for s, c in top_gaps],
            "send_paused": send_paused,
            "outreach_channels": channel_breakdown,
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/source-health", methods=["GET"])
def get_source_health():
    try:
        db = _db()
        return jsonify({"success": True, "sources": db.get_source_health_summary()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Queue ────────────────────────────────────────────────────────────────

@app.route("/api/queue", methods=["GET"])
def get_queue():
    try:
        db = _db()
        return jsonify({"success": True, "items": db.get_pending_queue_items(100)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Memory ───────────────────────────────────────────────────────────────

@app.route("/api/memory", methods=["GET"])
def get_memory():
    try:
        db = _db()
        return jsonify({
            "success": True,
            "active": db.get_active_memories(limit=50),
            "cv_candidates": db.get_cv_candidates(),
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Audit log ────────────────────────────────────────────────────────────

@app.route("/api/audit", methods=["GET"])
def get_audit():
    try:
        limit = int(request.args.get("limit", 100))
        month = datetime.now().strftime("%Y-%m")
        log_path = ROOT / "logs" / f"audit_{month}.jsonl"
        if not log_path.exists():
            return jsonify({"success": True, "entries": []})
        lines = log_path.read_text(encoding="utf-8").splitlines()
        entries = []
        for line in lines[-limit:]:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        entries.reverse()
        return jsonify({"success": True, "entries": entries})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Weekly digest preview ────────────────────────────────────────────────

@app.route("/api/digest", methods=["GET"])
def get_digest():
    try:
        from pulseops_notify.weekly_digest import build_digest
        text = build_digest(_since(7))
        return jsonify({"success": True, "digest": text})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Pipeline run (subprocess + SSE) ──────────────────────────────────────

def _enqueue_output(proc: subprocess.Popen) -> None:
    for line in iter(proc.stdout.readline, ""):
        try:
            _log_queue.put_nowait(line)
        except queue.Full:
            pass
    proc.stdout.close()
    _log_queue.put("[SYSTEM_PROCESS_FINISHED]\n")


@app.route("/api/run", methods=["POST"])
def run_pipeline():
    auth = _require_token()
    if auth:
        return auth
    global _running_process
    with _process_lock:
        if _running_process and _running_process.poll() is None:
            return jsonify({"success": False, "error": "A pipeline run is already in progress."}), 409

        while not _log_queue.empty():
            try:
                _log_queue.get_nowait()
            except queue.Empty:
                break

        body = request.json or {}
        simulate = bool(body.get("simulate", True))  # default safe: simulate
        force = bool(body.get("force", False))

        cmd = [sys.executable, str(ROOT / "main.py")]
        if simulate:
            cmd.append("--simulate")
        if force:
            cmd.append("--force")

        _log_queue.put(f"[*] Starting: {' '.join(cmd)}\n")
        try:
            _running_process = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, cwd=str(ROOT), env=os.environ.copy(),
            )
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500

        t = threading.Thread(target=_enqueue_output, args=(_running_process,), daemon=True)
        t.start()
        return jsonify({"success": True, "message": "Pipeline started."})


@app.route("/api/run/stream", methods=["GET"])
def stream_logs():
    def event_stream():
        while True:
            try:
                line = _log_queue.get(timeout=25)
            except queue.Empty:
                yield ": ping\n\n"
                continue
            if line == "[SYSTEM_PROCESS_FINISHED]\n":
                yield "data: [FINISHED]\n\n"
                break
            yield f"data: {line.rstrip(chr(10))}\n\n"

    return Response(event_stream(), mimetype="text/event-stream")


# ── Pause / resume ───────────────────────────────────────────────────────

@app.route("/api/pause", methods=["POST"])
def pause_sends():
    auth = _require_token()
    if auth:
        return auth
    try:
        db = _db()
        db.set_send_paused(True)
        return jsonify({"success": True, "send_paused": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/resume", methods=["POST"])
def resume_sends():
    auth = _require_token()
    if auth:
        return auth
    try:
        db = _db()
        db.set_send_paused(False)
        return jsonify({"success": True, "send_paused": False})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── PDF serving ──────────────────────────────────────────────────────────

@app.route("/pdf/<path:filename>")
def serve_pdf(filename):
    pdf_dir = ROOT / "output" / "pdf"
    return send_from_directory(str(pdf_dir), filename, as_attachment=False)


# ── Health (doctor.py wrapper) ───────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def get_health():
    try:
        db = _db()
        checks = {
            "cv_md_exists": (ROOT / "cv.md").exists(),
            "profile_yml_exists": (ROOT / "config" / "profile.yml").exists(),
            "settings_yml_exists": (ROOT / "config" / "settings.yml").exists(),
            "db_exists": (ROOT / "pulseops.db").exists(),
            "send_paused": db.get_send_paused(),
            "gemini_key_set": bool(os.getenv("GEMINI_API_KEY")),
            "groq_key_set": bool(os.getenv("GROQ_API_KEY") or os.getenv("XAI_API_KEY")),
            "telegram_configured": bool(os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID")),
            "discord_configured": bool(os.getenv("DISCORD_WEBHOOK_URL")),
            "smtp_configured": bool(os.getenv("SMTP_EMAIL") and os.getenv("SMTP_PASSWORD")),
            "auto_send_emails": os.getenv("AUTO_SEND_EMAILS", "false").lower() == "true",
        }
        return jsonify({"success": True, "checks": checks})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def run_server(host: str = "127.0.0.1", port: int = 5000) -> None:
    print(f"[*] PulseOps dashboard: http://{host}:{port}")
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    run_server()
