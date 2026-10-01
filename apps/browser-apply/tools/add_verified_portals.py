"""Append verified-live ATS boards to portals.yml.

Every URL here was confirmed against the vendor's own public posting API
(boards-api.greenhouse.io, api.ashbyhq.com) rather than by guessing a slug.
Guessing was tried first and every guessed variant 404'd the same way, which is
how 11 boards ended up silently dead in the config in the first place.

Idempotent: re-running will not duplicate an entry that already exists.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PORTALS = Path("apps/weekly-scan/portals.yml")

# (display name, engine, company slug, url, jobs seen at time of adding)
NEW = [
    # Greenhouse, confirmed via boards-api.greenhouse.io
    ("Databricks", "greenhouse", "databricks", "https://boards.greenhouse.io/databricks", 882),
    ("Elastic", "greenhouse", "elastic", "https://boards.greenhouse.io/elastic", 390),
    ("Scale AI", "greenhouse", "scaleai", "https://boards.greenhouse.io/scaleai", 191),
    ("Vercel (Greenhouse)", "greenhouse", "vercel", "https://boards.greenhouse.io/vercel", 91),
    ("Mixpanel", "greenhouse", "mixpanel", "https://boards.greenhouse.io/mixpanel", 70),
    ("Cockroach Labs", "greenhouse", "cockroachlabs", "https://boards.greenhouse.io/cockroachlabs", 19),
    ("PlanetScale", "greenhouse", "planetscale", "https://boards.greenhouse.io/planetscale", 12),
    # Ashby, confirmed via api.ashbyhq.com/posting-api/job-board
    ("OpenAI", "ashby", "openai", "https://jobs.ashbyhq.com/openai", 839),
    ("Sierra", "ashby", "sierra", "https://jobs.ashbyhq.com/sierra", 202),
    ("Ramp", "ashby", "ramp", "https://jobs.ashbyhq.com/ramp", 155),
    ("Baseten", "ashby", "baseten", "https://jobs.ashbyhq.com/baseten", 104),
    ("Deepgram", "ashby", "deepgram", "https://jobs.ashbyhq.com/deepgram", 91),
    ("Fireworks AI", "ashby", "fireworks", "https://jobs.ashbyhq.com/fireworks", 86),
    ("Sarvam AI", "ashby", "sarvam", "https://jobs.ashbyhq.com/sarvam", 59),
    ("Modal", "ashby", "modal", "https://jobs.ashbyhq.com/modal", 39),
    ("Cartesia", "ashby", "cartesia", "https://jobs.ashbyhq.com/cartesia", 30),
    ("E2B", "ashby", "e2b", "https://jobs.ashbyhq.com/e2b", 12),
    ("Moonshot AI", "ashby", "moonshot", "https://jobs.ashbyhq.com/moonshot", 4),
]

HEADER = (
    "\n  # Added 2026-09-30. Each URL below was confirmed live against the vendor's\n"
    "  # own posting API (boards-api.greenhouse.io/v1/boards/<slug>/jobs and\n"
    "  # api.ashbyhq.com/posting-api/job-board/<slug>), NOT guessed. The job count is\n"
    "  # what the API reported when the entry was added and is a comment only.\n"
)


def main() -> int:
    text = PORTALS.read_text(encoding="utf-8")
    lines = text.split("\n")

    # Find the ats_portals block and the start of the next top-level key.
    # Appending to EOF is wrong: `settings:` follows ats_portals:, so entries
    # appended at the end land outside the list and the YAML stops parsing.
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("ats_portals:"))
    except StopIteration:
        print("ats_portals: section not found", file=sys.stderr)
        return 1

    end = len(lines)
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line and not line[0].isspace() and not line.lstrip().startswith("#"):
            end = i
            break

    existing = set(re.findall(r'company:\s*"?([\w.-]+)"?', "\n".join(lines[start:end])))
    added, skipped = [], []

    for name, engine, company, url, jobs in NEW:
        if company in existing:
            skipped.append(company)
            continue
        block = [
            f'  - name: "{name}"',
            f"    engine: {engine}",
            "    enabled: true",
            "    requires_auth: false",
            f'    company: "{company}"',
            f'    url: "{url}"',
            f"    # {jobs} jobs at time of adding",
            "",
        ]
        lines[end:end] = block
        end += len(block)
        added.append(f"{name}({jobs})")
        existing.add(company)

    if not added:
        PORTALS.write_text("\n".join(lines), encoding="utf-8")
        print("nothing to add")
        return 0

    lines[start + 1 : start + 1] = HEADER.split("\n") + [""]
    PORTALS.write_text("\n".join(lines), encoding="utf-8")
    print(f"added {len(added)}: {', '.join(added)}")
    if skipped:
        print(f"already present: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
