"""Render cv.md to Avradeep-Majumder-cv.pdf with reportlab.

cv.md is the only file a human edits (Non-negotiable #1), so this renders it
directly. It used to carry its own hardcoded copy of the CV, which drifted: the
2026-10 CV landed in the PDF and in cv.md never, so every tailored resume was
built from a stale source while the PDF looked current. Now there is one input.

Rendering is deliberately plain - headings, paragraphs, bullets - because the
markdown itself is the design. No pandoc, no weasyprint on this box.

Usage:
    python apps/browser-apply/tools/make_cv_pdf.py
Writes output/Avradeep-Majumder-cv.pdf.
"""

from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
)

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "cv.md"
OUT = ROOT / "output" / "Avradeep-Majumder-cv.pdf"

NAVY = colors.HexColor("#1F3864")
INK = colors.HexColor("#222222")
GREY = colors.HexColor("#595959")

base = getSampleStyleSheet()
title = ParagraphStyle("title", parent=base["Title"], fontSize=18, leading=22,
                       textColor=NAVY, spaceAfter=2, alignment=0)
subtitle = ParagraphStyle("subtitle", parent=base["Normal"], fontSize=10.5,
                          leading=13, textColor=GREY, spaceAfter=4)
h2 = ParagraphStyle("h2", parent=base["Heading2"], fontSize=11.5, leading=14,
                    textColor=NAVY, spaceBefore=7, spaceAfter=2)
body = ParagraphStyle("body", parent=base["Normal"], fontSize=9.3, leading=11.6,
                      textColor=INK, spaceAfter=1)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=11, firstLineIndent=-8,
                        spaceAfter=0.5, bulletIndent=3)


def inline(text: str) -> str:
    """Escape XML metacharacters, then restore **bold** and markdown links."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    return text


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")

    lines = SRC.read_text(encoding="utf-8").splitlines()
    story: list = []
    bullets: list[str] = []

    def flush() -> None:
        if not bullets:
            return
        items = [ListItem(Paragraph(inline(t), bullet), bulletColor=NAVY) for t in bullets]
        story.append(ListFlowable(items, bulletType="bullet", start="\u2022",
                                  leftIndent=14, bulletFontName="Helvetica-Bold"))
        bullets.clear()

    header_done = False
    in_header = False

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            flush()
            continue

        if stripped.startswith("# ") and not stripped.startswith("## "):
            flush()
            story.append(Paragraph(inline(stripped[2:].strip()), title))
            in_header = True
            continue

        if stripped.startswith("## "):
            flush()
            if in_header and not header_done:
                story.append(HRFlowable(width="100%", thickness=0.8, color=NAVY, spaceAfter=6))
                in_header = False
                header_done = True
            story.append(Paragraph(inline(stripped[3:].strip()), h2))
            story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=4))
            continue

        if stripped.startswith("- "):
            bullets.append(stripped[2:].strip())
            continue

        flush()
        # Everything between the name and the first ## heading is the contact /
        # summary block; it renders as subtitle text under a single rule.
        story.append(Paragraph(inline(stripped), subtitle if in_header else body))

    flush()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(OUT), pagesize=A4,
                            leftMargin=1.35*cm, rightMargin=1.35*cm,
                            topMargin=1.2*cm, bottomMargin=1.2*cm)
    doc.build(story)
    print(f"  read {SRC.name} ({len(lines)} lines)")
    print(f"  wrote {OUT}")
    print(f"  size: {OUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
