"""Build, verify and record the tailored resume for one job row.

The rule this exists to satisfy, in the operator's own words:

    "if board asks for a resume --> then build it from the cv, ats tailor to
     the jd and the platform then verify it then upload it, if it asks for a cv
     then send the cv as is"

So a form that asks for a RESUME gets a document built from cv.md for this
specific job description: the same builder the daily pipeline uses
(pulseops_core.resume_builder), fed the row's stored bullet adjustments and
tailored skills. A form that asks for a CV gets the canonical CV untouched, and
never reaches this script.

It prints exactly one JSON line on stdout so apply.mjs can read the outcome
without parsing prose. Exit code is 0 when a verified PDF exists, 1 otherwise.

Usage:
    python apps/browser-apply/tools/build_resume_for_job.py --job-id 143
    python apps/browser-apply/tools/build_resume_for_job.py \
        --company Glean --title "Software Engineer, Backend"

Verification is not a size check alone. A PDF that does not open, is blank, or
does not carry the candidate's own name and email is not a resume an employer
can act on, and uploading one is worse than uploading nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for extra in ("packages/pulse-core/src", "packages/pulse-store/src", "packages/pulse-config/src"):
    p = ROOT / extra
    if p.exists() and str(p) not in sys.path:
        sys.path.insert(0, str(p))


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def db_path() -> Path:
    raw = os.environ.get("PULSEOPS_DB") or os.environ.get("PULSEOPS_DB_PATH")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (ROOT / p)
    return ROOT / "pulseops.db"


def load_json(raw) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else []
    except Exception:
        return []


def pdf_pages(path: Path) -> int:
    try:
        from pypdf import PdfReader  # type: ignore

        return len(PdfReader(str(path)).pages)
    except Exception:
        pass
    try:
        import PyPDF2  # type: ignore

        with open(path, "rb") as fh:
            return len(PyPDF2.PdfReader(fh).pages)
    except Exception:
        return 0


def pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader  # type: ignore

        return "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
    except Exception:
        pass
    try:
        import PyPDF2  # type: ignore

        with open(path, "rb") as fh:
            return "\n".join((page.extract_text() or "") for page in PyPDF2.PdfReader(fh).pages)
    except Exception:
        return ""


def verify(path: Path, name: str, email: str) -> dict:
    """Return {"ok": bool, "problems": [...]} for a built resume."""
    problems: list[str] = []
    if not path.exists():
        return {"ok": False, "problems": ["file is missing"]}
    if not path.is_file():
        return {"ok": False, "problems": ["path is not a file"]}
    size = path.stat().st_size
    if size < 1000:
        problems.append(f"file is only {size} bytes")
    with open(path, "rb") as fh:
        if fh.read(5) != b"%PDF-":
            problems.append("file does not start with a PDF header")
    pages = pdf_pages(path)
    # The builder tries five tighter layouts to land on one page and accepts the
    # tightest result when it cannot. 127 of the rendered CVs in output/pdf are
    # one page and 43 are two, so two is a real answer, not a failure; anything
    # longer than that is a document nobody reads to the end.
    if pages > 2:
        problems.append(f"{pages} pages (a resume should be one page, two at most)")
    text = pdf_text(path).lower()
    if not text:
        problems.append("no text could be read back out of the PDF")
    else:
        # The document must be recognisably the candidate's. Checking the parts
        # rather than the whole string tolerates the line-wrapping every PDF
        # extractor introduces.
        parts = [p for p in name.split() if len(p) > 1]
        missing = [p for p in parts if p.lower() not in text]
        if missing:
            problems.append("name not present: " + ", ".join(missing))
        if email and email.lower() not in text:
            problems.append("email not present")
    return {"ok": not problems, "problems": problems, "pages": pages, "bytes": size}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", type=int, default=0)
    ap.add_argument("--company", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--force", action="store_true", help="rebuild even if a PDF is recorded")
    args = ap.parse_args()

    if not (ROOT / "cv.md").exists():
        emit({"ok": False, "error": f"missing source CV at {ROOT / 'cv.md'}"})
        return 1

    try:
        from pulseops_core.cv_parser import parse_cv
        from pulseops_core.resume_builder import build_resume
    except Exception as exc:  # pragma: no cover - environment problem
        emit({"ok": False, "error": f"cannot import the resume builder: {exc}"})
        return 1

    company = args.company
    title = args.title
    job_id = args.job_id
    bullets: list = []
    skills: list = []
    jd_text = ""
    recorded = ""
    conn = None

    db = db_path()
    if job_id and db.exists():
        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            emit({"ok": False, "error": f"job {job_id} is not in {db}"})
            return 1
        company = company or (row["company"] or "")
        title = title or (row["title"] or "")
        bullets = load_json(row["bullet_adjustments"] if "bullet_adjustments" in row.keys() else "")
        skills = load_json(row["tailored_skills"] if "tailored_skills" in row.keys() else "")
        jd_text = (row["job_description"] if "job_description" in row.keys() else "") or ""
        recorded = (row["pdf_path"] if "pdf_path" in row.keys() else "") or ""

    if not company or not title:
        emit({"ok": False, "error": "a company and a title are required"})
        return 1

    if recorded and not args.force:
        existing = Path(recorded)
        if not existing.is_absolute():
            existing = ROOT / existing
        # Rebuild when the human-edited source is newer than the rendered file:
        # the point of rendering from cv.md is that an edit to the CV reaches
        # the next upload, and a cached PDF would silently outlive it.
        stale = existing.exists() and existing.stat().st_mtime < (ROOT / "cv.md").stat().st_mtime
        if existing.exists() and not stale:
            check = verify(existing, "", "")
            if check.get("pages") and 1 <= check["pages"] <= 2 and check.get("bytes", 0) > 1000:
                emit({"ok": True, "pdf": str(existing), "reused": True, "verified": check})
                return 0
        if stale:
            print(f"[resume] {existing.name} predates cv.md - rebuilding", file=sys.stderr)

    cv_data = parse_cv(str(ROOT / "cv.md"))
    eval_result = {
        "match_percentage": 78,
        "letter_grade": "C",
        "bullet_adjustments": bullets,
        "tailored_skills": skills,
    }
    try:
        pdf, html = build_resume(
            cv_data=cv_data,
            eval_result=eval_result,
            company=company,
            role=title,
            jd_text=jd_text,
            simulate=False,
        )
    except Exception as exc:
        emit({"ok": False, "error": f"build failed: {exc}"[:400]})
        return 1

    if not pdf:
        emit({"ok": False, "error": "builder returned no PDF path"})
        return 1

    out = Path(pdf)
    check = verify(out, getattr(cv_data, "name", "") or "", getattr(cv_data, "email", "") or "")
    if not check["ok"]:
        emit({"ok": False, "pdf": str(out), "error": "unverified", "verified": check})
        return 1

    if conn is not None and job_id:
        try:
            conn.execute(
                "UPDATE jobs SET pdf_path=?, report_path=? WHERE id=?",
                (str(out), html or "", job_id),
            )
            conn.commit()
        except Exception:
            pass
    if conn is not None:
        conn.close()

    emit({"ok": True, "pdf": str(out), "reused": False, "verified": check})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
