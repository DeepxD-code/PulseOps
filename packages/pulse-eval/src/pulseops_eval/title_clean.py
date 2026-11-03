"""Title cleaning — the Python mirror of apps/weekly-scan/lib/relevance.mjs.

Why this exists
---------------
The scan hands a title to the database, and every later stage reads it back:
the domain filter, the apply-queue role gate and the CV tailoring prompt. Board
scrapes decorate titles with their own chrome, so the pipeline used to receive

    "Backend Engineer Bangalore Founded in 2021 50-200 employees View job »"
    "HiveMarketing automation for event promoters (email, sms, ads, CRM)
     Senior Software Engineer, Data SystemsFull-time · Remote (US)"
    "Engineering Manager6"            (Hirist's opening count)
    "Principal Software Engineer, Computer UseSan Francisco, CA"

and then rejected the posting because the *company blurb* mentioned "marketing",
or because the role gate saw "Manager" in what was really a business
description. Cleaning once, at ingestion, keeps one canonical title for every
stage.

Keep this in lockstep with cleanTitle() in relevance.mjs — same rules, same
order. A divergence here means the scanner and the evaluator disagree about what
a job is called.
"""

from __future__ import annotations

import re

__all__ = ["clean_title", "is_role_like"]

# Board chrome that appears inside a scraped title, longest-first where one
# pattern would otherwise eat another's text.
_BOARD_CHROME = [
    re.compile(r"\s*[·•|]\s*(?:full[\s-]?time|part[\s-]?time|contract|internship|remote|hybrid|on[\s-]?site)\b.*$", re.I),
    # Same chip glued to the preceding word — Wellfound renders
    # "Software Engineer, Data SystemsFull-time", and only the bullet-prefixed
    # form was stripped, so "Full-time" survived into the stored title. The
    # lookbehind also accepts whitespace and "(" so the ordinary
    # "Machine Learning Researcher Full-time" form is stripped too; it can never
    # fire at position 0, so a title that *starts* with "Full-time" survives.
    re.compile(r"(?<=[a-z\)\s])(?:Full|Part)[\s-]?time\b.*$"),
    re.compile(r"(?<=[a-z\)\s])In\s+office.*$"),
    # Wellfound's compensation chip: "Chennai L - 35L".
    re.compile(r"\s+[A-Z]\s*-\s*\d+(?:\.\d+)?\s*[Ll]\b.*$"),
    re.compile(r"\s*founded\s+in\s+(?:19|20)\d{2}.*$", re.I),
    re.compile(r"\s*\d+\s*[-–]\s*\d+\s*(?:employees|people)\b.*$", re.I),
    re.compile(r"\s*\d+\+?\s*(?:employees|people)\b.*$", re.I),
    re.compile(r"\s*view\s+job\b.*$", re.I),
    re.compile(r"\s*actively\s+hiring\b.*$", re.I),
    re.compile(r"\s*apply\s+now\b.*$", re.I),
    re.compile(r"\s*posted\s+\d+\s*(?:day|hour|week|month)s?\s+ago\b.*$", re.I),
    re.compile(r"\s*(?:recently\s+active|be an early applicant|easy apply)\b.*$", re.I),
    re.compile(r"\s*work\s+from\s+home\b.*$", re.I),
    re.compile(r"\s*work\s+from\s+office\b.*$", re.I),
]

_PLACES = [
    "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai", "noida",
    "gurugram", "gurgaon", "greater noida", "new delhi", "delhi ncr", "delhi",
    "kolkata", "ahmedabad", "jaipur", "indore", "kochi", "coimbatore", "remote",
    "india", "pan india", "anywhere in india",
]

# The separator may be whitespace, a comma/dash or a slash. "Backend Engineer
# Bangalore", "Backend Engineer, Bangalore, India" and "… REST API / Remote" are
# the same title with different punctuation, and only the whitespace form used to
# be stripped — so a comma left the city in the stored title.
_PLACE_TAIL = re.compile(
    r"(?:\s*[,–—/-]\s*|\s+)(?:in\s+|at\s+)?(?:%s)\s*$"
    % "|".join(p.replace(" ", r"\s+") for p in _PLACES),
    re.I,
)

# Pipe-separated metadata, e.g. "Backend Developer Intern | Entry Level |
# Fresher | Node.js, Python, REST APIs / Remote". Location and seniority segments
# are board decoration and go; a segment that names a technology stays, because
# the stack is a real disqualifier — dropping "| Node.js" made a Node role look
# eligible to a Python/C++ candidate.
_PIPE_STACK = re.compile(
    r"\b(?:node(?:\.js)?|javascript|js|typescript|react|angular|vue|next\.js|"
    r"java|python|golang|go|rust|kotlin|php|ruby|perl|c\+\+|c#|\.net|"
    r"sql|postgres\w*|mysql|mongo\w*|django|flask|fastapi|spring\w*|"
    r"docker|kubernetes|k8s|aws|gcp|azure|ml|ai|llm|nlp|pytorch|tensorflow)\b",
    re.I,
)

# YC's card markup glues the employer onto the role with no separator at all:
# "RationalFirst Zero-human Accounting FirmMachine Learning Researcher Full-time".
# The company name is then read by the domain filter as the candidate's own
# discipline ("Accounting"), so the posting is rejected for what the employer
# sells. Split only a CamelCase boundary — a lowercase letter followed by a
# capitalised role noun and then another word — so "Mumbai" never becomes "Mum bai".
_GLUED_ROLE = re.compile(
    r"(?<=[a-z])("
    r"Machine|Software|Backend|Frontend|Full|Data|Product|Research|Applied|"
    r"Platform|Infrastructure|Engineering|Developer|Engineer|Analyst|Scientist|"
    r"Architect|Consultant|Senior|Staff|Lead|Principal|Junior|Founding"
    r")(?=\s*[A-Z][a-z])"
)

# Hirist appends the number of open positions ("Backend Developer2",
# "Engineering Manager6"). The digits are welded to the word — with a space they
# are a level, and "SDE 2" must not become "SDE".
_TRAILING_COUNT = re.compile(r"(?<=[a-z\)])\d{1,3}$")

# YC's card markup has no separator between company, tagline and role, so the
# only reliable boundary is the capitalised start of the role phrase.
_ROLE_START = re.compile(
    r"(?:^|[\s)\.\-])("
    r"(?:Founding|Senior|Staff|Lead|Principal|Junior|Associate|Entry|Graduate|"
    r"New\s+Grad|Software|Backend|Back[\s-]End|Frontend|Front[\s-]End|"
    r"Full[\s-]?Stack|Machine|ML|AI|GenAI|LLM|Data|Product|Project|Program|"
    r"Research|Applied|Forward\s+Deployed|Platform|Infrastructure|"
    r"Site\s+Reliability|Solutions?|Customer|Security|Cloud|DevOps|Mobile|"
    r"Android|iOS|Embedded|QA|SDET|Test|Technical|Engineering|Developer|"
    r"Engineer|Analyst|Scientist|Architect|Consultant|Intern)\b.*)$",
    re.I,
)

_ROLE_LIKE = re.compile(
    r"\b(?:engineer|developer|scientist|architect|analyst|programmer|intern|"
    r"consultant|lead|manager|specialist|designer|researcher)\b",
    re.I,
)


def is_role_like(value: str) -> bool:
    """True when the text still looks like a role name (a sanity check after cleaning)."""
    return bool(_ROLE_LIKE.search(str(value or "")))


def clean_title(raw: str) -> str:
    """Strip board chrome from a scraped title. Idempotent."""
    value = re.sub(r"[\u00a0\u200b]", " ", str(raw or ""))
    value = re.sub(r"\s+", " ", value).strip()
    if not value:
        return ""

    # 1. A specialty glued to its location ("Computer UseSan Francisco, CA").
    value = re.sub(r"([a-z\)])((?:[A-Z][a-z]{2,}){1,4})\s*$", r"\1 \2", value)

    # 1b. An employer glued onto the role ("FirmMachine Learning Researcher").
    value = _GLUED_ROLE.sub(r" \1", value)

    # 2. Pipe metadata ("Backend Engineer | Bangalore"). Location and seniority
    #    segments are dropped; a segment that names a technology is kept so the
    #    role gate can still see the stack.
    if "|" in value:
        segments = [segment.strip() for segment in value.split("|")]
        kept = [segments[0]] + [
            segment for segment in segments[1:] if segment and _PIPE_STACK.search(segment)
        ]
        value = " | ".join(segment for segment in kept if segment)

    # 3. Board chrome, including everything after it.
    for pattern in _BOARD_CHROME:
        value = pattern.sub("", value)
    value = re.sub(r"\s+", " ", value).strip()

    # 4. Glued company + tagline + role (YC). Keep from the last role-start word
    #    only when the text before it does not already look like a role phrase.
    if len(value) > 60 and re.search(r"(?:full|part)[\s-]?time\b", str(raw or ""), re.I):
        match = _ROLE_START.search(value)
        if match and match.start(1) > 0:
            value = match.group(1)

    # 5. Trailing place name, applied at most twice.
    for _ in range(2):
        nxt = _PLACE_TAIL.sub("", value)
        if nxt == value:
            break
        value = nxt

    # 6. Hirist's trailing opening count.
    value = _TRAILING_COUNT.sub("", value)

    value = re.sub(r"[\s,;:.\-–—]+$", "", value).strip()
    return value[:160]
