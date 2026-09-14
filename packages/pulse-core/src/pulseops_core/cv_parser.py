"""
core/cv_parser.py — Pure-Python cv.md → CVData dataclass (no LLM, no imports from LLM libs)

Non-negotiable #1: cv.md is the ONLY file a human ever edits.
This parser turns it into a typed CVData so every downstream module
(profile_builder, resume_builder, context_loader) works from the same object.

Supports Markdown with these conventions:
  # Name                        → candidate name
  Lines with @/linkedin/github  → contact fields (auto-detected)
  ## Section Name               → section heading
  - bullet                      → bullet item under current section
  Non-bullet lines in section   → role/project header lines

Raises CVParseError (from exceptions.py) if cv.md is missing or unparseable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from pulseops_core.exceptions import CVParseError


# ── Data types ──────────────────────────────────────────────────────────────

@dataclass
class CVExperience:
    title: str
    company: str
    date_range: str
    location: str
    bullets: list[str] = field(default_factory=list)


@dataclass
class CVProject:
    name: str
    tech_stack: list[str] = field(default_factory=list)
    bullets: list[str] = field(default_factory=list)
    link: str = ""


@dataclass
class CVEducation:
    institution: str
    degree: str
    graduation_year: str
    gpa: str = ""


@dataclass
class CVCertification:
    name: str
    issuer: str = ""
    year: str = ""


@dataclass
class CVData:
    # Identity
    name: str = ""
    email: str = ""
    phone: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    location: str = ""

    # Content
    summary: str = ""
    skills: dict[str, list[str]] = field(default_factory=dict)  # category → items
    experience: list[CVExperience] = field(default_factory=list)
    projects: list[CVProject] = field(default_factory=list)
    education: list[CVEducation] = field(default_factory=list)
    certifications: list[CVCertification] = field(default_factory=list)

    # Raw storage (for profile_builder LLM prompt)
    raw_bullets: list[str] = field(default_factory=list)
    raw_text: str = ""


# ── Helpers ──────────────────────────────────────────────────────────────────

_DATE_RE   = re.compile(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+\d{4}\b'
                         r'|\b\d{4}\b'
                         r'|\b(Present|Current|Ongoing|Now)\b', re.IGNORECASE)
_EMAIL_RE  = re.compile(r'[\w.+-]+@[\w-]+\.[a-z]{2,}', re.IGNORECASE)
_PHONE_RE  = re.compile(r'[+]?[\d][\d\s\-().]{7,}')
_URL_RE    = re.compile(r'https?://\S+')
_GITHUB_RE = re.compile(r'github\.com/(\S+)', re.IGNORECASE)
_LI_RE     = re.compile(r'linkedin\.com/in/(\S+)', re.IGNORECASE)

_SECTION_ALIASES: dict[str, str] = {
    "experience": "experience", "work experience": "experience",
    "employment": "experience", "professional experience": "experience",
    "projects": "projects", "open source": "projects", "personal projects": "projects",
    "education": "education",
    "skills": "skills", "technical skills": "skills", "core skills": "skills",
    "certifications": "certifications", "certificates": "certifications",
    "summary": "summary", "profile": "summary", "objective": "summary",
    "about": "summary",
}


def _canonical_section(heading: str) -> str:
    return _SECTION_ALIASES.get(heading.lower().strip(), "other")


def _extract_dates(line: str) -> str:
    full_matches = [m.group(0) for m in _DATE_RE.finditer(line)]
    return " – ".join(full_matches) if full_matches else ""


def _strip_markdown(text: str) -> str:
    """Remove bold/italic markers and backticks for clean display."""
    text = re.sub(r'\*{1,2}([^*]+)\*{1,2}', r'\1', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    return text.strip()


def _parse_skill_line(line: str) -> tuple[str, list[str]]:
    """
    Parses a skill bullet like:
      "Languages: Java, Python, C++, Go"
      "Java | Python | C++ | Go"
    Returns (category_label, [items]).
    """
    if ":" in line:
        category, _, rest = line.partition(":")
        items = [i.strip() for i in re.split(r'[,|•·]', rest) if i.strip()]
        return category.strip(), items
    items = [i.strip() for i in re.split(r'[,|•·]', line) if i.strip()]
    return "Skills", items


def _parse_entry_header(line: str) -> tuple[str, str, str, str]:
    """
    Tries to extract (title, company, date_range, location) from a
    single line like:
      "Software Engineer Intern | Stripe | Jan 2026 – Apr 2026 | Remote"
      "Backend Intern @ Vercel  (Jun 2025 – Aug 2025)"
      "Role Title — Focus Area | Company | Jan 2026 – Apr 2026 | Remote"
    Returns best-effort tuple; empty strings for unparseable fields.
    """
    date_range = _extract_dates(line)
    # Strip the dates from the line for cleaner parsing of title/company
    clean = _DATE_RE.sub("", line)
    if "|" in clean:
        # Explicit pipe-separated format already in use — trust it as-is.
        # Don't also convert internal dashes (e.g. an em-dash inside the
        # title itself, "Role — Focus Area | Company | ...") into more
        # pipe-separators, which would incorrectly split a single field.
        clean = re.sub(r'[@()]', '|', clean)
    else:
        # No explicit pipes — fall back to normalising dash/@/paren
        # separators, e.g. "Backend Intern @ Vercel (Jun 2025 – Aug 2025)"
        clean = re.sub(r'[–—-]+', '|', clean)
        clean = re.sub(r'[@()]', '|', clean)
    parts = [p.strip(" —–-") for p in clean.split("|") if p.strip(" —–-")]
    # Heuristic: first part = title, second = company, last = location (if looks like a place)
    title   = parts[0] if len(parts) > 0 else line.strip()
    company = parts[1] if len(parts) > 1 else ""
    location = parts[-1] if len(parts) > 2 else ""
    return title, company, date_range, location


# ── Main parser ──────────────────────────────────────────────────────────────

def parse_cv(cv_path: str) -> CVData:
    path = Path(cv_path)
    if not path.exists():
        raise CVParseError(f"cv.md not found at {cv_path}")

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CVParseError(f"Could not read cv.md: {e}") from e

    if not text.strip():
        raise CVParseError("cv.md is empty")

    cv = CVData(raw_text=text)
    lines = text.splitlines()

    current_section: str = ""
    current_exp: Optional[CVExperience] = None
    current_proj: Optional[CVProject] = None
    in_summary = False

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            in_summary = False
            continue

        # ── H1: candidate name ───────────────────────────────────────────
        if stripped.startswith("# ") and not stripped.startswith("## "):
            cv.name = _strip_markdown(stripped[2:].strip())
            continue

        # ── H2: section heading ──────────────────────────────────────────
        if stripped.startswith("## "):
            # Save any in-progress entry
            if current_exp:
                cv.experience.append(current_exp); current_exp = None
            if current_proj:
                cv.projects.append(current_proj); current_proj = None

            heading = stripped[3:].strip()
            current_section = _canonical_section(heading)
            in_summary = (current_section == "summary")
            continue

        # ── Contact auto-detection (before any ## section) ───────────────
        # Scan each line for ALL contact signals (one pipe-separated line may hold all)
        if not current_section:
            m_email = _EMAIL_RE.search(stripped)
            if m_email and not cv.email:
                cv.email = m_email.group(0)
            m_github = _GITHUB_RE.search(stripped)
            if m_github and not cv.github:
                cv.github = f"https://github.com/{m_github.group(1).rstrip(')')}"
            m_li = _LI_RE.search(stripped)
            if m_li and not cv.linkedin:
                cv.linkedin = f"https://linkedin.com/in/{m_li.group(1).rstrip(')')}"
            m_phone = _PHONE_RE.search(stripped)
            if m_phone and not cv.phone:
                cv.phone = m_phone.group(0).strip()
            for m_url in _URL_RE.finditer(stripped):
                url = m_url.group(0)
                if not cv.portfolio and "github" not in url.lower() and "linkedin" not in url.lower():
                    cv.portfolio = url; break
            continue   # skip non-contact pre-section lines

        # ── Summary ──────────────────────────────────────────────────────
        if current_section == "summary":
            if not stripped.startswith("-"):
                cv.summary = (cv.summary + " " + _strip_markdown(stripped)).strip()
            continue

        # ── Skills ───────────────────────────────────────────────────────
        if current_section == "skills":
            content = stripped.lstrip("-").strip()
            cat, items = _parse_skill_line(_strip_markdown(content))
            if items:
                existing = cv.skills.get(cat, [])
                # Deduplicate while preserving order
                for item in items:
                    if item not in existing:
                        existing.append(item)
                cv.skills[cat] = existing
            continue

        # ── Experience ───────────────────────────────────────────────────
        if current_section == "experience":
            if stripped.startswith("- "):
                bullet = _strip_markdown(stripped[2:])
                cv.raw_bullets.append(bullet)
                if current_exp:
                    current_exp.bullets.append(bullet)
            else:
                # New entry header
                if current_exp:
                    cv.experience.append(current_exp)
                title, company, date_range, location = _parse_entry_header(_strip_markdown(stripped))
                current_exp = CVExperience(title=title, company=company,
                                            date_range=date_range, location=location)
            continue

        # ── Projects ─────────────────────────────────────────────────────
        if current_section == "projects":
            if stripped.startswith("- "):
                bullet = _strip_markdown(stripped[2:])
                cv.raw_bullets.append(bullet)
                if current_proj:
                    current_proj.bullets.append(bullet)
            else:
                if current_proj:
                    cv.projects.append(current_proj)
                name = _strip_markdown(stripped)
                # Detect tech stack hints like "Project Name | Go, gRPC, Redis"
                # or "Project Name | Go, gRPC, Redis | github.com/user/repo"
                tech: list[str] = []
                link = ""
                m_url = _URL_RE.search(stripped)
                if m_url:
                    link = m_url.group(0)
                if "|" in name:
                    parts = [p.strip() for p in name.split("|")]
                    name = parts[0]
                    # Tech-stack segment is whichever remaining part is NOT the
                    # URL itself — with 2 parts that's parts[-1]; with 3+ parts
                    # (name | tech | link) skip any segment containing the link.
                    tech_parts = [p for p in parts[1:] if not (link and link in p)]
                    if tech_parts:
                        tech = [t.strip() for t in re.split(r'[,·]', tech_parts[0]) if t.strip()]
                if link:
                    name = re.sub(re.escape(link), "", name).strip(" |")
                current_proj = CVProject(name=name, tech_stack=tech, link=link)
            continue

        # ── Education ────────────────────────────────────────────────────
        if current_section == "education":
            if stripped.startswith("- "):
                continue  # sub-bullets under edu (GPA, minor) — skip
            clean = _strip_markdown(stripped)
            date_range = _extract_dates(clean)
            year = re.findall(r'\b20\d{2}\b', clean)
            clean_no_date = _DATE_RE.sub("", clean).strip(" |,-")
            parts = [p.strip() for p in re.split(r'\|', clean_no_date) if p.strip()]
            if len(parts) < 2:
                # No pipe separators — fall back to comma split (legacy format)
                parts = [p.strip() for p in re.split(r',', clean_no_date) if p.strip()]

            # Detect which segment is the degree by keyword, rather than
            # assuming a fixed position — real CVs vary between
            # "Institution | Degree | Years" and "Degree | Institution | Years".
            _DEGREE_KEYWORDS = (
                "b.tech", "btech", "b.e.", "bachelor", "m.tech", "mtech",
                "master", "m.s.", "ms ", "phd", "ph.d", "associate", "diploma",
                "b.sc", "bsc", "m.sc", "msc", "b.a.", "m.a.",
            )
            degree_idx = next(
                (i for i, p in enumerate(parts) if any(kw in p.lower() for kw in _DEGREE_KEYWORDS)),
                None,
            )
            if degree_idx is not None:
                degree = parts[degree_idx]
                institution = next((p for i, p in enumerate(parts) if i != degree_idx), "")
            else:
                # No keyword match — keep the original positional fallback
                degree      = parts[0] if len(parts) > 0 else clean
                institution = parts[1] if len(parts) > 1 else ""

            gpa_match = re.search(r'GPA[:\s]+([0-9.]+)', stripped, re.IGNORECASE)
            cv.education.append(CVEducation(
                institution=institution, degree=degree,
                graduation_year=year[-1] if year else date_range,
                gpa=gpa_match.group(1) if gpa_match else "",
            ))
            continue

        # ── Certifications ───────────────────────────────────────────────
        if current_section == "certifications":
            if stripped.startswith("- "):
                stripped = stripped[2:]
            clean = _strip_markdown(stripped)
            year_m = re.search(r'\b(20\d{2})\b', clean)
            name = _DATE_RE.sub("", clean).strip(" |,-")
            parts = [p.strip() for p in name.split("|") if p.strip()]
            cv.certifications.append(CVCertification(
                name=parts[0],
                issuer=parts[1] if len(parts) > 1 else "",
                year=year_m.group(1) if year_m else "",
            ))
            continue

    # ── Flush pending entries ────────────────────────────────────────────
    if current_exp:
        cv.experience.append(current_exp)
    if current_proj:
        cv.projects.append(current_proj)

    # ── Minimum viability check ──────────────────────────────────────────
    if not cv.name and not cv.experience and not cv.skills:
        raise CVParseError(
            "cv.md parsed but no name, experience, or skills were found. "
            "Ensure the file uses ## Section headings and starts with # Your Name."
        )

    return cv
