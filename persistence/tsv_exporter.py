"""
persistence/tsv_exporter.py — Auto-export to TSV after every run (PulseOps Phase 9)

Exports:
  data/jobs.tsv       — all jobs with key evaluation fields
  data/outreach.tsv   — all sent outreach
  data/outcomes.tsv   — all callback/interview stage records

Follows Career-Ops philosophy: SQLite is source of truth, TSV is for human
review (opens in Excel/Sheets without tooling) and is git-trackable when
needed. Files are always overwritten (not appended) so they stay current.

Called at the end of main.py Phase 9:
    try:
        from persistence.tsv_exporter import export
        export()
    except Exception:
        pass   # never block the pipeline
"""

import csv
import json
from pathlib import Path

from exceptions import DatabaseError
from persistence import db_manager as db
from persistence import audit_log

ROOT    = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data"


def _safe_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        try:
            return json.dumps(v, ensure_ascii=False)
        except Exception:
            return str(v)
    return str(v)


def _write_tsv(path: Path, rows: list[dict]) -> int:
    if not rows:
        path.write_text("", encoding="utf-8")
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    headers = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers, delimiter="\t",
                                 extrasaction="ignore", quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: _safe_str(v) for k, v in row.items()})
    return len(rows)


def _flatten_jobs(jobs: list[dict]) -> list[dict]:
    """Project the key fields a human cares about in a spreadsheet view."""
    flat = []
    for j in jobs:
        flat.append({
            "id":                j.get("id", ""),
            "processed_at":      j.get("processed_at", ""),
            "status":            j.get("status", ""),
            "score":             j.get("score", ""),
            "letter_grade":      j.get("letter_grade", ""),
            "title":             j.get("title", ""),
            "company":           j.get("company", ""),
            "source":            j.get("source", ""),
            "location_resolved": j.get("location_resolved", ""),
            "contact_email":     j.get("contact_email", ""),
            "inferred_domain":   j.get("inferred_domain", ""),
            "domain_confidence": j.get("domain_confidence", ""),
            "email_variant":     j.get("email_variant_used", ""),
            "eval_engine":       j.get("eval_engine", ""),
            "eval_tokens":       j.get("eval_tokens", ""),
            "skill_gap":         "; ".join(j.get("skill_gap", []) or []),
            "text_summary":      j.get("text_summary", ""),
            "pdf_path":          j.get("pdf_path", ""),
            "link":              j.get("link", ""),
            "run_id":            j.get("run_id", ""),
        })
    return flat


def export(run_id: str = "") -> list[str]:
    """
    Runs the full export. Returns list of file paths written.
    Any DatabaseError propagates — callers wrap in try/except.
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []

    # Jobs
    jobs_path = OUT_DIR / "jobs.tsv"
    jobs_flat = _flatten_jobs(db.get_all_jobs(limit=5000))
    n = _write_tsv(jobs_path, jobs_flat)
    print(f"  [TSV] jobs.tsv → {n} rows")
    written.append(str(jobs_path))

    # Outreach
    outreach_path = OUT_DIR / "outreach.tsv"
    outreach = db.get_recent_outreach(days=365)
    outreach_flat = [
        {
            "id":           r.get("id", ""),
            "sent_at":      r.get("sent_at", ""),
            "status":       r.get("status", ""),
            "company":      r.get("company", ""),
            "contact_email":r.get("contact_email", ""),
            "subject":      r.get("subject", ""),
            "email_variant":r.get("email_variant", ""),
            "domain":       r.get("domain", ""),
            "followup_sent":r.get("followup_sent", 0),
            "followup_sent_at": r.get("followup_sent_at", ""),
            "job_id":       r.get("job_id", ""),
        }
        for r in outreach
    ]
    n = _write_tsv(outreach_path, outreach_flat)
    print(f"  [TSV] outreach.tsv → {n} rows")
    written.append(str(outreach_path))

    # Outcomes
    outcomes_path = OUT_DIR / "outcomes.tsv"
    outcomes = db.get_outcomes_since("2000-01-01T00:00:00")
    n = _write_tsv(outcomes_path, outcomes)
    print(f"  [TSV] outcomes.tsv → {n} rows")
    written.append(str(outcomes_path))

    audit_log.write_tsv_export(run_id, written)
    return written
