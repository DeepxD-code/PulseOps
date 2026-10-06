"""Run the full automation on a loop, and stop wasting runs on exhausted quota.

Written because the operator will be away and the pipeline has a real scheduling
problem: all three LLM engines are capped, and one evaluation prompt costs more
than a whole day of the free tier.

    Groq gpt-oss-20b   TPD limit   2,000 tokens
    Groq gpt-oss-120b  TPD limit     200 tokens
    one prompt                    ~2,900 tokens
    Gemini free tier                500 requests/day
    OpenAI                          no credits

Observed on the 2026-10-05 run: 60 of 69 evaluations failed on 429, which is the
whole reason it produced almost nothing. Looping blindly into that burns CPU,
fills logs with identical failures, and - worse - looks like a working pipeline.

So each iteration probes quota FIRST and skips the run if nothing can score. When
an engine is available the iteration runs the real thing:

    scan -> dedup -> filters -> evaluate -> apply -> notify -> push

Guardrails this loop does not relax, because they are not the operator's to
trade away:

  - CAPTCHA and bot-detection refusals are never worked around. A board that
    rejects the submission is recorded and left; it is not retried with a
    different fingerprint. Ashby stays excluded from evaluation budget.
  - Role scope is unchanged (backend / Java / Python / C-C++ / ML / AI / GenAI).
  - No location gating. The orchestrator's own location filter dropped 0 of 312
    rows in the last run, and that is the intended behaviour here.
  - Terms, policy attestations and legal agreements only under the operator's
    flags, logged by class.
  - Salary postings stating under INR 10,000/month are skipped.
  - Two browser-apply runs never overlap; claims are released between iterations.
  - No fabricated contact details, and no invented answers to questions only the
    candidate can answer.

Every iteration writes its own log, so the loop is readable after the fact rather
than only while someone is watching.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(r"E:\Potential-gold\PluseOPS")
DB = ROOT / "pulseops.db"
LOG_DIR = ROOT / "output" / "loop"
LOG_DIR.mkdir(parents=True, exist_ok=True)

MIN_SCORE = os.environ.get("PULSEOPS_MIN_SCORE", "45")
MAX_ITERATIONS = int(os.environ.get("LOOP_MAX_ITERATIONS", "40"))
SLEEP_BETWEEN = int(os.environ.get("LOOP_SLEEP_MINUTES", "15")) * 60

ENV = dict(os.environ)
ENV.update({
    "PULSEOPS_MIN_SCORE": MIN_SCORE,
    "PULSEOPS_OTP_PAUSE_MS": "75000",
    "PULSEOPS_CAPTCHA_WAIT_MS": "25000",
    "PULSEOPS_ALLOW_EXTERNAL_APPLY": "1",
})

APPLY_BATCHES = int(os.environ.get("LOOP_APPLY_BATCHES", "6"))


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def db_counts() -> dict:
    conn = sqlite3.connect(DB)
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM jobs WHERE LOWER(status)='verified'")
        verified = cur.fetchone()[0]
        cur.execute(
            "SELECT COUNT(*) FROM jobs WHERE LOWER(COALESCE(status,''))='evaluated'"
        )
        evaluated = cur.fetchone()[0]
        cur.execute(
            "SELECT COUNT(*) FROM jobs WHERE LOWER(COALESCE(status,''))='sourced'"
        )
        sourced = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM jobs")
        total = cur.fetchone()[0]
        return {
            "verified": verified,
            "evaluated": evaluated,
            "sourced_awaiting_scoring": sourced,
            "total": total,
        }
    finally:
        conn.close()


def release_claims() -> int:
    """A run that dies mid-apply leaves rows in 'applying' forever.

    Those rows then look claimed to every later run, which silently removes them
    from the queue rather than reporting anything. Releasing them between
    iterations is the documented recovery.
    """
    conn = sqlite3.connect(DB)
    try:
        n = conn.execute(
            "UPDATE jobs SET status='evaluated' WHERE LOWER(COALESCE(status,''))='applying'"
        ).rowcount
        conn.commit()
        return n
    finally:
        conn.close()


def probe_gemini() -> dict:
    """Does Gemini have quota? A tiny call, so the probe costs almost nothing."""
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        import google.genai as genai
        from google.genai import types

        key = os.environ.get("GEMINI_API_KEY", "")
        if not key:
            return {"ok": False, "why": "no GEMINI_API_KEY"}
        client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=30000))
        client.models.generate_content(model="gemini-flash-lite-latest", contents="ok")
        return {"ok": True}
    except Exception as e:
        text = str(e)
        if "RESOURCE_EXHAUSTED" in text or "429" in text:
            retry = ""
            marker = "Please retry in "
            if marker in text:
                retry = text.split(marker, 1)[1].split(".")[0].split("s")[0].strip()
            return {"ok": False, "why": "429 quota", "retry_in_s": retry}
        return {"ok": False, "why": text[:120]}


def probe_groq() -> dict:
    """Can Groq ADMIT one real evaluation prompt?

    Not "is the API reachable" - that is the wrong question, and answering it made
    this probe useless. The free tier's caps are per DAY and count PROMPT tokens:

        openai/gpt-oss-20b    2,000 TPD
        openai/gpt-oss-120b     200 TPD

    and one evaluation prompt is ~2,400 tokens. A five-token probe is admitted on
    an account that cannot run a single evaluation, so the loop kept starting full
    runs that could only produce 60 identical quota failures.

    So this sends the genuine prompt the evaluator would send, with max_tokens=5.
    The prompt tokens are what the daily cap counts, so the request is admitted
    only if there is genuinely room for an evaluation, and the completion costs
    almost nothing either way.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        from groq import Groq

        key = os.environ.get("GROQ_API_KEY", "")
        if not key:
            return {"ok": False, "why": "no GROQ_API_KEY"}

        prompt = _representative_prompt()
        if not prompt:
            return {"ok": False, "why": "could not build a prompt"}

        client = Groq(api_key=key)
        resp = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            timeout=60,
            max_tokens=5,
        )
        # An HTTP 200 here means the request was admitted against the daily cap,
        # which is the thing being tested.
        _ = getattr(resp, "usage", None)
        return {"ok": True, "prompt_chars": len(prompt)}
    except Exception as e:
        text = str(e)
        if "429" in text or "Rate limit" in text or "tokens per day" in text:
            return {"ok": False, "why": "429 daily token budget"}
        return {"ok": False, "why": text[:140]}


def _representative_prompt() -> str:
    """A prompt the size of a real one, built by the evaluator's own code."""
    try:
        import yaml
        sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))
        from pulseops_eval.analyzer import _build_prompt

        profile_path = ROOT / "config" / "profile.yml"
        profile = yaml.safe_load(profile_path.read_text(encoding="utf-8-sig")) or {}
        settings_path = ROOT / "config" / "settings.yml"
        settings = (
            yaml.safe_load(settings_path.read_text(encoding="utf-8-sig"))
            if settings_path.exists() else {}
        )
        cv_data = None
        try:
            sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))
            from pulseops_core.cv_parser import parse_cv
            if (ROOT / "cv.md").exists():
                cv_data = parse_cv(str(ROOT / "cv.md"))
        except Exception:
            cv_data = None

        return _build_prompt(
            job={
                "title": "Backend Engineer, Platform",
                "company": "probe",
                "description": "Python and Java backend services, REST APIs, "
                               "PostgreSQL, Kafka, Kubernetes.",
            },
            cv_data=cv_data,
            memory_context=None,
            profile=profile,
            settings=settings,
        )
    except Exception:
        return ""


def export_score_queue(tag: str) -> int:
    """Write rows that still need a score, for me to pick up.

    Kept out of the pipeline's own DB writes: this only reads, and appends to a
    JSONL file, so it cannot interfere with a run in progress.
    """
    import json as _json

    conn = sqlite3.connect(DB)
    try:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT id, company, title, link, source,"
            " COALESCE(job_description, '') AS description"
            " FROM jobs"
            " WHERE LOWER(COALESCE(status,''))='sourced'"
            " ORDER BY id"
        )
        rows = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    if not rows:
        return 0

    path = LOG_DIR / "score-queue.jsonl"
    already = set()
    if path.exists():
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    already.add(_json.loads(line).get("id"))
                except Exception:
                    continue

    fresh = [r for r in rows if r["id"] not in already]
    if not fresh:
        return 0

    with path.open("a", encoding="utf-8") as fh:
        for r in fresh:
            r["queued_at"] = datetime.now().isoformat()
            r["queued_by"] = tag
            fh.write(_json.dumps(r, ensure_ascii=False) + "\n")
    return len(fresh)


def run(cmd: list[str], log_path: Path, timeout: int) -> int:
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(f"\n\n===== {datetime.now().isoformat()} :: {' '.join(cmd[:3])} =====\n")
        fh.flush()
        try:
            proc = subprocess.run(
                cmd, cwd=str(ROOT), env=ENV, stdout=fh, stderr=subprocess.STDOUT,
                timeout=timeout,
            )
            return proc.returncode
        except subprocess.TimeoutExpired:
            fh.write(f"\n[timed out after {timeout}s]\n")
            return -1


def iteration(index: int) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_path = LOG_DIR / f"iter-{index:03d}-{stamp}.log"
    log_path.write_text(
        f"iteration {index} at {datetime.now().isoformat()}\n", encoding="utf-8"
    )

    released = release_claims()
    if released:
        log(f"  released {released} orphaned Applying row(s)")

    before = db_counts()
    log(f"  before: {before}")

    gem, groq = probe_gemini(), probe_groq()
    log(f"  quota: gemini={'ok' if gem['ok'] else gem.get('why')} "
        f"groq={'ok' if groq['ok'] else groq.get('why')}")

    if not gem["ok"] and not groq["ok"]:
        return "skipped-no-quota"

    # Full pipeline. Liveness is a ~5 minute phase and now streams, so silence
    # during it is expected rather than a fault.
    rc = run(
        ["powershell", "-ExecutionPolicy", "Bypass", "-File",
         "scripts/run-automation.ps1", "-AcceptTerms", "-AcceptLegal"],
        log_path, timeout=5400,
    )
    log(f"  run-automation exit={rc}")

    queued = export_score_queue(f"iteration-{index}")
    if queued:
        log(f"  {queued} row(s) queued for scoring in output/loop/score-queue.jsonl")

    after = db_counts()
    log(f"  after:  {after}")
    gained = after["verified"] - before["verified"]
    log(f"  VERIFIED {before['verified']} -> {after['verified']} (+{gained})")

    release_claims()
    return "ran" if rc == 0 else f"exit={rc}"


def main() -> int:
    log(f"loop start, {MAX_ITERATIONS} iterations, sleeping {SLEEP_BETWEEN // 60}m between")
    summary_path = LOG_DIR / "summary.jsonl"
    for i in range(1, MAX_ITERATIONS + 1):
        log(f"=== iteration {i}/{MAX_ITERATIONS} ===")
        try:
            outcome = iteration(i)
        except Exception as e:
            outcome = f"error: {type(e).__name__}: {str(e)[:200]}"
            log(f"  !! {outcome}")
        counts = db_counts()
        with summary_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "iteration": i,
                "at": datetime.now().isoformat(),
                "outcome": outcome,
                **counts,
            }) + "\n")
        log(f"  outcome: {outcome}")

        if i < MAX_ITERATIONS:
            # Heartbeat on both sides of the sleep. Without this the loop can die
            # between iterations and leave no trace: the iteration log records what
            # the PIPELINE did, and the pipeline was not what stopped. That is how
            # the 2026-10-06 loop completed iteration 1 successfully and then
            # vanished with every log looking healthy.
            beat = LOG_DIR / "heartbeat.txt"
            beat.write_text(
                f"iteration {i} done at {datetime.now().isoformat()}; "
                f"outcome={outcome}; sleeping {SLEEP_BETWEEN // 60}m\n",
                encoding="utf-8",
            )
            log(f"  sleeping {SLEEP_BETWEEN // 60}m before the next iteration")
            time.sleep(SLEEP_BETWEEN)
            beat.write_text(
                f"woke at {datetime.now().isoformat()}; starting iteration {i + 1}\n",
                encoding="utf-8",
            )
            log("  woke")
    log("loop complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())