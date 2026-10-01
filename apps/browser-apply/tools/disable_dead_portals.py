"""Disable ATS boards that are definitively gone, with a note explaining why.

A board that 404s is not a bug to debug, it is stale config. Leaving it enabled
means every run spends a probe on it and then reports it in the "appears
unreachable" list, which buries the portals that genuinely need attention.

The note is written into the YAML on purpose: the next person who wonders why
Razorpay is off should not re-derive it, and should not guess a new slug — that
was tried and 404s identically.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PORTALS = Path("apps/weekly-scan/portals.yml")

DEAD = {
    "razorpay", "zerodha", "postman", "groww", "chargebee", "freshworks",
    "browserstack", "swiggy", "meesho", "slice", "tinkoff",
}

NOTE = (
    "    # DISABLED 2026-09-30: definitive 404 on boards.greenhouse.io AND\n"
    "    # job-boards.greenhouse.io (Lever's postings API likewise for its three).\n"
    "    # The company moved ATS or onto a custom domain. Re-enable only after\n"
    "    # locating and verifying the live board URL - do NOT guess the slug,\n"
    "    # every guessed variant tested returns the same 404.\n"
)

ENTRY = re.compile(r'^\s*-\s*name:\s*"?([^"]+?)"?\s*$')


def main() -> int:
    lines = PORTALS.read_text(encoding="utf-8").split("\n")
    out: list[str] = []
    disabled: list[str] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        m = ENTRY.match(line)
        # A portal entry is a `- name:` line plus its indented keys.
        if m:
            block = []
            j = i
            while j < len(lines) and (j == i or lines[j].startswith("    ")):
                block.append(lines[j])
                j += 1
            text = "\n".join(block)
            if "url:" in text:
                cm = re.search(r'company:\s*"?([^"\s]+)"?', text)
                company = (cm.group(1) if cm else m.group(1)).strip().lower()
                if company in DEAD and re.search(r"^\s*enabled:\s*true\s*$", text, re.M):
                    block = [
                        re.sub(r"^(\s*enabled:\s*)true\s*$", r"\1false", b)
                        for b in block
                    ]
                    out.append(NOTE.rstrip("\n"))
                    disabled.append(company)
                out.extend(block)
                i = j
                continue
        out.append(line)
        i += 1

    PORTALS.write_text("\n".join(out), encoding="utf-8")
    print(f"disabled {len(disabled)}: {', '.join(disabled)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
