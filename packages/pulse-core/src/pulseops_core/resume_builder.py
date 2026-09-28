"""
core/resume_builder.py — Company-specific resume builder (PulseOps Phase 6)

Pipeline:
  CVData + JobEvaluation + CompanyContext
    → select/reorder sections
    → apply tailored bullets from eval_result
    → generate tailored summary (3 sentences, company-specific)
    → render Jinja2 HTML template
    → Playwright → output/pdf/CV_{Company}_{Title}.pdf
    → output/html/CV_{Company}_{Title}.html

1-page fit order (spec):
  drop awards → drop certs → drop lowest project → truncate oldest bullets
  → reduce font 0.5pt (max 2 iterations)

Section rules:
  ALWAYS:      contact (header), summary, skills, education
  CONDITIONAL: experience (always if exists)
               projects   (top 2 by JD keyword overlap if >2 exist)
               certifications (only if relevant cert keyword in JD)
               awards         (only if page has room — omitted in PDF path)

Raises ResumeBuildError on failure.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

from pulseops_core.exceptions import ResumeBuildError

try:
    from pulseops_config.paths import TEMPLATES_DIR, repo_root

    ROOT = repo_root()
except ImportError:
    ROOT = Path(__file__).resolve().parent.parent
    TEMPLATES_DIR = ROOT / "templates"
TEMPLATE    = TEMPLATES_DIR / "resume.html.jinja2"
OUTPUT_PDF  = ROOT / "output" / "pdf"
OUTPUT_HTML = ROOT / "output" / "html"

# Layout profiles: (font_pt, line_height, page_margin_mm, name_pt, section_title_pt,
#                   contact_pt, meta_pt, entry_mb_pt, bullet_mb_pt, bullet_mt_pt,
#                   section_mb_pt, header_mb_pt, skills_row_gap_pt, edu_mb_pt)
_PROFILES = [
    (9.5,  1.38, 14, 17, 7.5,  8.5, 8.0,  6, 2.5, 3, 8, 5, 2.5, 4),
    (9.0,  1.35, 13, 16, 7.0,  8.0, 7.5,  5, 2.0, 2, 7, 4, 2.0, 3),
    (8.5,  1.32, 12, 15, 6.5,  7.5, 7.0,  4, 1.5, 2, 6, 4, 1.5, 3),
    (8.0,  1.30, 11, 14, 6.0,  7.0, 6.5,  4, 1.2, 1, 5, 3, 1.2, 2),
    (7.5,  1.28, 10, 13, 5.5,  6.5, 6.0,  3, 1.0, 1, 4, 3, 1.0, 2),
]


# ── Jinja2 template environment ─────────────────────────────────────────────

def _make_env():
    try:
        from jinja2 import Environment, FileSystemLoader, select_autoescape
    except ImportError as e:
        raise ResumeBuildError("Jinja2 not installed — run: pip install jinja2") from e

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(["html"]),
    )

    # Custom filters used in the template
    env.filters["linkedin_handle"] = lambda u: re.sub(r'.*/in/', "", u).strip("/")
    env.filters["github_handle"]   = lambda u: re.sub(r'.*/github\.com/', "", u).strip("/")
    env.filters["strip_https"]     = lambda u: re.sub(r'^https?://', "", u).rstrip("/")
    env.filters["half"]            = lambda v: v / 2
    env.filters["minus1"]          = lambda v: v - 1

    return env


# ── Section helpers ──────────────────────────────────────────────────────────

def _keyword_overlap(text: str, jd: str) -> int:
    """Count shared lowercase words ≥4 chars between text and JD."""
    text_words = set(w for w in re.findall(r'\b[a-z]{4,}\b', text.lower()) if w)
    jd_words   = set(w for w in re.findall(r'\b[a-z]{4,}\b', jd.lower())   if w)
    return len(text_words & jd_words)


def _top_projects(projects, jd: str, top_n: int = 2):
    """Return top_n projects ranked by JD keyword overlap."""
    if len(projects) <= top_n:
        return projects
    scored = sorted(
        projects,
        key=lambda p: _keyword_overlap(
            " ".join(p.bullets) + " " + " ".join(p.tech_stack), jd
        ),
        reverse=True,
    )
    return scored[:top_n]


def _cert_relevant(certifications, jd: str) -> list:
    """Only include certs whose name appears in JD (case-insensitive)."""
    jd_lower = jd.lower()
    return [c for c in certifications if c.name.lower() in jd_lower
            or any(w in jd_lower for w in c.name.lower().split() if len(w) > 3)]


def _apply_bullet_adjustments(cv_data, eval_result: dict):
    """
    Returns (experience, projects) with bullets replaced by tailored versions
    from eval_result['bullet_adjustments']. Fuzzy match: substring both ways.
    Modifies copies, not the original CVData objects.
    """
    import copy
    adjustments = eval_result.get("bullet_adjustments") or []
    if not adjustments:
        return cv_data.experience, cv_data.projects

    adj_map: dict[str, str] = {}
    for a in adjustments:
        orig    = (a.get("original") or "").strip()
        tailored = (a.get("tailored") or "").strip()
        if orig and tailored:
            adj_map[orig.lower()] = tailored

    def replace_bullets(bullets: list[str]) -> list[str]:
        out = []
        for b in bullets:
            b_low = b.lower()
            match = None
            for orig_low, tailored in adj_map.items():
                if orig_low in b_low or b_low in orig_low:
                    match = tailored
                    break
            out.append(match if match else b)
        return out

    experience = [
        copy.copy(exp).__class__(
            title=exp.title, company=exp.company,
            date_range=exp.date_range, location=exp.location,
            bullets=replace_bullets(exp.bullets),
        )
        for exp in cv_data.experience
    ]
    # Rebuild as dataclass instances properly
    from pulseops_core.cv_parser import CVExperience, CVProject
    experience = [
        CVExperience(title=e.title, company=e.company, date_range=e.date_range,
                      location=e.location, bullets=replace_bullets(e.bullets))
        for e in cv_data.experience
    ]
    projects = [
        CVProject(name=p.name, tech_stack=p.tech_stack, link=p.link,
                   bullets=replace_bullets(p.bullets))
        for p in cv_data.projects
    ]
    return experience, projects


def _reorder_skills(cv_skills: dict[str, list[str]], tailored_skills: list[str]) -> dict[str, list[str]]:
    """
    Reorder skills within each category so JD-matching skills come first.
    tailored_skills is a flat list of skill strings from eval_result.
    """
    if not tailored_skills:
        return cv_skills
    priority = {s.lower().strip(): i for i, s in enumerate(tailored_skills)}

    def sort_key(skill: str) -> int:
        return priority.get(skill.lower().strip(), 9999)

    return {cat: sorted(items, key=sort_key) for cat, items in cv_skills.items()}


def _build_summary(eval_result: dict, company: str, role: str, cv_data) -> str:
    """
    Use eval_result['text_summary'] as the tailored summary.
    Strip banned words. Fall back to cv_data.summary if empty.
    """
    summary = (eval_result.get("text_summary") or cv_data.summary or "").strip()
    # Strip banned words (spec requirement)
    banned = ["spearheaded", "passionate", "synergy", "dynamic", "utilized",
               "leveraging", "streamline", "innovative", "orchestrated", "pioneered",
               "game-changer", "proven track record"]
    for word in banned:
        summary = re.sub(rf'\b{re.escape(word)}\b', "", summary, flags=re.IGNORECASE)
    summary = re.sub(r"  +", " ", summary).strip()
    return summary


def _clean_filename(s: str) -> str:
    # Strict whitelist: npx.cmd routes args through cmd.exe, where
    # & ( ) ^ % ! are metacharacters that mangle the argv even when
    # subprocess passes a list. Alnum + _-. only.
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s).strip("_")[:40]


# ── HTML rendering ───────────────────────────────────────────────────────────

def _render_html(context: dict) -> str:
    env = _make_env()
    try:
        template = env.get_template("resume.html.jinja2")
        return template.render(**context)
    except Exception as e:
        raise ResumeBuildError(f"Jinja2 render failed: {e}") from e


def _build_context(cv_data, eval_result: dict, company: str, role: str,
                    jd_text: str, profile: dict, profile_idx: int) -> dict:
    """Assemble the full template context for a given layout profile."""
    (font_pt, line_h, margin_mm, name_pt, sec_title_pt,
     contact_pt, meta_pt, entry_mb, bullet_mb, bullet_mt,
     sec_mb, header_mb, skills_gap, edu_mb) = _PROFILES[profile_idx]

    summary    = _build_summary(eval_result, company, role, cv_data)
    experience, projects_adj = _apply_bullet_adjustments(cv_data, eval_result)

    # Skills: reorder by JD relevance, then render
    tailored_skills = eval_result.get("tailored_skills") or []
    skills = _reorder_skills(dict(cv_data.skills), tailored_skills)

    # Projects: top 2 by JD overlap
    projects = _top_projects(projects_adj, jd_text, top_n=2)

    # Certifications: only if relevant to JD
    certifications = _cert_relevant(cv_data.certifications, jd_text)

    # Domain title from profile
    domain_title = (profile.get("domain") or {}).get("title") or "Backend Engineer"

    candidate = {
        "name":             cv_data.name,
        "email":            cv_data.email,
        "phone":            cv_data.phone,
        "linkedin":         cv_data.linkedin,
        "github":           cv_data.github,
        "portfolio":        cv_data.portfolio,
        "experience_years": profile.get("candidate", {}).get("experience_years", ""),
    }

    return {
        "candidate":         candidate,
        "domain_title":      domain_title,
        "company":           company,
        "role":              role,
        "summary":           summary,
        "skills":            skills,
        "experience":        [
            {
                "title":      e.title,
                "company":    e.company,
                "date_range": e.date_range,
                "location":   e.location,
                "bullets":    e.bullets,
            }
            for e in experience
        ],
        "projects":          [
            {
                "name":       p.name,
                "tech_stack": p.tech_stack,
                "bullets":    p.bullets,
                "link":       p.link,
            }
            for p in projects
        ],
        "education":         [
            {
                "institution":      e.institution,
                "degree":           e.degree,
                "graduation_year":  e.graduation_year,
            }
            for e in cv_data.education
        ],
        "certifications":    [
            {"name": c.name, "issuer": c.issuer, "year": c.year}
            for c in certifications
        ],
        # Layout tokens
        "font_size_pt":      font_pt,
        "line_height":       line_h,
        "page_margin_mm":    margin_mm,
        "name_size_pt":      name_pt,
        "section_title_pt":  sec_title_pt,
        "contact_size_pt":   contact_pt,
        "meta_size_pt":      meta_pt,
        "entry_mb_pt":       entry_mb,
        "bullet_mb_pt":      bullet_mb,
        "bullet_mt_pt":      bullet_mt,
        "section_mb_pt":     sec_mb,
        "header_mb_pt":      header_mb,
        "skills_row_gap_pt": skills_gap,
        "edu_mb_pt":         edu_mb,
    }


# ── Playwright PDF generation ─────────────────────────────────────────────────

def _html_to_pdf_playwright(html_path: Path, pdf_path: Path) -> None:
    """
    Use Playwright (Node.js) to render the HTML file to a single-page PDF.
    Falls back to a Python subprocess call to playwright CLI if the Python
    playwright package is unavailable.
    """
    # Try Python playwright first
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page    = browser.new_page()
            page.goto(f"file://{html_path.resolve()}")
            page.wait_for_load_state("networkidle", timeout=10_000)
            page.pdf(
                path=str(pdf_path),
                format="A4",
                print_background=True,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            )
            browser.close()
        return
    except ImportError:
        pass

    # Fallback: playwright CLI via npx. On Windows, subprocess does not
    # resolve bare "npx" (WinError 2) and npx.ps1 is execution-policy
    # blocked — address npx.cmd explicitly.
    import sys as _sys
    _npx = "npx.cmd" if _sys.platform.startswith("win") else "npx"
    result = subprocess.run(
        [_npx, "playwright", "pdf", str(html_path.resolve()), str(pdf_path)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise ResumeBuildError(
            f"Playwright PDF generation failed: {result.stderr[:300]}"
        )


def _page_count_playwright(pdf_path: Path) -> int:
    """
    Quick page count via PyPDF2/pypdf.
    Returns 1 if the library is unavailable (assume fits).
    """
    try:
        from pypdf import PdfReader  # type: ignore
        return len(PdfReader(str(pdf_path)).pages)
    except ImportError:
        pass
    try:
        import PyPDF2  # type: ignore
        with open(pdf_path, "rb") as f:
            return len(PyPDF2.PdfReader(f).pages)
    except (ImportError, Exception):
        return 1  # assume OK


# ── Public API ───────────────────────────────────────────────────────────────

def build_resume(
    cv_data,
    eval_result: dict,
    company: str,
    role: str,
    jd_text: str = "",
    profile: dict | None = None,
    simulate: bool = False,
) -> tuple[str, str]:
    """
    Build a company-specific resume PDF + HTML.

    Returns (pdf_path, html_path).
    In simulate mode: writes HTML only (no Playwright), returns ("", html_path).
    Raises ResumeBuildError on failure.
    """
    if profile is None:
        profile = {}

    OUTPUT_PDF.mkdir(parents=True, exist_ok=True)
    OUTPUT_HTML.mkdir(parents=True, exist_ok=True)

    # Every tailored CV keeps the same short name so it is recognisable in a
    # file picker and in what an employer sees. The tailoring still happens per
    # application; uniqueness now comes from a short per-application folder
    # instead of a long filename, so two roles at one company never collide and
    # no path grows without bound.
    safe_co = _clean_filename(company)[:24]
    role_key = hashlib.sha1(_clean_filename(role).encode("utf-8")).hexdigest()[:8]
    subdir = f"{safe_co}-{role_key}"
    (OUTPUT_HTML / subdir).mkdir(parents=True, exist_ok=True)
    (OUTPUT_PDF / subdir).mkdir(parents=True, exist_ok=True)
    html_path = OUTPUT_HTML / subdir / "CV.html"
    pdf_path  = OUTPUT_PDF  / subdir / "CV.pdf"

    if not TEMPLATE.exists():
        raise ResumeBuildError(
            f"Resume template not found at {TEMPLATE}. "
            "Ensure templates/resume.html.jinja2 exists."
        )

    # ── Simulate: write HTML only ────────────────────────────────────────
    if simulate:
        context  = _build_context(cv_data, eval_result, company, role,
                                   jd_text, profile, profile_idx=0)
        html_src = _render_html(context)
        html_path.write_text(html_src, encoding="utf-8")
        print(f"    [ResumeBuilder/Sim] HTML → {html_path}")
        return "", str(html_path)

    # ── Live: try profiles until 1-page fit ─────────────────────────────
    last_error: Exception | None = None
    for i, _ in enumerate(_PROFILES):
        try:
            context  = _build_context(cv_data, eval_result, company, role,
                                       jd_text, profile, profile_idx=i)
            html_src = _render_html(context)
            html_path.write_text(html_src, encoding="utf-8")

            _html_to_pdf_playwright(html_path, pdf_path)

            if not pdf_path.exists() or pdf_path.stat().st_size < 1000:
                raise ResumeBuildError("PDF output is empty or missing")

            pages = _page_count_playwright(pdf_path)
            if pages <= 1:
                print(f"    [ResumeBuilder] 1-page fit on profile {i+1}: {pdf_path.name}")
                return str(pdf_path), str(html_path)

            print(f"    [ResumeBuilder] Profile {i+1}: {pages} pages — trying tighter layout…")

        except ResumeBuildError:
            raise
        except Exception as e:
            last_error = e
            print(f"    [ResumeBuilder] Profile {i+1} failed: {e}")

    # If we exhausted all profiles and still > 1 page, accept the tightest
    if pdf_path.exists() and pdf_path.stat().st_size > 1000:
        print(f"    [ResumeBuilder] Warning: accepted multi-page output after {len(_PROFILES)} profiles")
        return str(pdf_path), str(html_path)

    raise ResumeBuildError(
        f"All {len(_PROFILES)} layout profiles failed to produce a valid PDF. "
        f"Last error: {last_error}"
    )
