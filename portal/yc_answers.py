"""Draft YC workatastartup outreach-modal answers via Gemini. Usage:
python portal/yc_answers.py "<company>" "<title>" "<role_snippet>"
Prints JSON {intro, built, why}. Answers 60-120 words, human tone, grounded."""
import json
import os
import sys
import re

sys.path.insert(0, 'packages/pulse-eval/src')
sys.path.insert(0, 'packages/pulse-core/src')
from dotenv import load_dotenv
load_dotenv()

company, title, snippet = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")[:800]

import yaml
profile = yaml.safe_load(open('config/profile.yml'))
cand = profile.get('candidate', {})
try:
    from pulseops_core.cv_parser import parse_cv
    cv = parse_cv('cv.md')
    bullets = list(cv.raw_bullets)[:10]
    projects = [f"{p.name}: {', '.join(p.bullets[:2])}" for p in cv.projects[:4]]
except Exception:
    bullets, projects = [], []

from pulseops_eval.analyzer import _query_gemini, pace_llm_call  # noqa

prompt = f"""Write 3 short job-application answers as Avradeep Majumder (do NOT invent employers or degrees beyond what's given).

CANDIDATE: {cand.get('name')}, {cand.get('education')}, {cand.get('experience_years')} yrs backend. GitHub: {cand.get('github')}. LinkedIn: {cand.get('linkedin')}.
PROJECTS: {json.dumps(projects)[:1500]}
ROLE: {title} at {company}. {snippet}

Return ONLY valid JSON with keys intro (who you are + what you want, 60-90 words), built (one concrete thing built, with GitHub link https://github.com/DeepxD-code, 60-100 words), why (why this role/company specifically, 50-80 words). Human tone, no buzzword stuffing."""

pace_llm_call()
out = _query_gemini(prompt)
if isinstance(out, list):  # model occasionally returns a bare array
    out = next((x for x in out if isinstance(x, dict)), {})
if not isinstance(out, dict):
    out = {}
for k in ("intro", "built", "why"):
    out.setdefault(k, "")
    out[k] = re.sub(r"\s+", " ", str(out[k])).strip()[:900]
    if len(out[k]) < 50:
        out[k] = (out[k] + " I am excited about this opportunity and would love to discuss how I can contribute.")[:900]
print(json.dumps({k: out[k] for k in ("intro", "built", "why")}))
