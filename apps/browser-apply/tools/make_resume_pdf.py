"""Render a one-page resume PDF from cv.md, trimmed to a single page.

A resume is not a CV. The CV lists everything; this keeps the strongest
signals for a 6-second screen: summary, one experience, three projects with
their headline bullets, a skills line, and certifications. No interests, no
sports-event organiser, no coursework section.

Same style as the CV PDF. Writes output/Avradeep-Majumder-resume.pdf and
mirrors it to Downloads.

Usage:
    python apps/browser-apply/tools/make_resume_pdf.py
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import HRFlowable, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "output" / "Avradeep-Majumder-resume.pdf"

NAVY = colors.HexColor("#1F3864")
INK = colors.HexColor("#222222")
GREY = colors.HexColor("#595959")

base = getSampleStyleSheet()
title = ParagraphStyle("title", parent=base["Title"], fontSize=17, leading=20,
                       textColor=NAVY, spaceAfter=1)
subtitle = ParagraphStyle("subtitle", parent=base["Normal"], fontSize=9.5,
                          leading=12, textColor=GREY, spaceAfter=2)
h2 = ParagraphStyle("h2", parent=base["Heading2"], fontSize=11, leading=13,
                    textColor=NAVY, spaceBefore=6, spaceAfter=2)
body = ParagraphStyle("body", parent=base["Normal"], fontSize=9.5, leading=12,
                      textColor=INK, spaceAfter=1)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=10, firstLineIndent=-7,
                        spaceAfter=0, bulletIndent=2)

doc = SimpleDocTemplate(str(OUT), pagesize=A4,
                        leftMargin=1.5*cm, rightMargin=1.5*cm,
                        topMargin=1.2*cm, bottomMargin=1.2*cm)

story = []
story.append(Paragraph("AVRADEEP MAJUMDER", title))
story.append(Paragraph("AI/ML Engineer | Generative AI Engineer | Backend Developer", subtitle))
story.append(Paragraph("trex2004avradeep@gmail.com | +91 6289050278 | github.com/DeepxD-code | linkedin.com/in/avradeep-majumder-4664b532a | West Bengal, India", subtitle))
story.append(HRFlowable(width="100%", thickness=0.8, color=NAVY, spaceAfter=4))

story.append(Paragraph("Final-year B.Tech CSE (AI/ML) student (Class of 2027), CGPA 7.0/10. Ships production-grade AI, backend, and blockchain systems — a 16-signal fraud intelligence platform for India's PDS (AnnaSuraksha), an offline-first military logistics platform (Sangam), and a multi-classifier ML code profiler (IntelliX). Grand Finalist at InnerVe X 2026 (MLH Official Season). Backend intern at AKS Intelligent Systems LLP. Seeking SWE / AI-ML / GenAI roles, internships and full-time.", body))
story.append(Spacer(1, 2))

story.append(Paragraph("Experience", h2))
story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=2))
story.append(Paragraph("<b>Software Trainee Intern (Backend)</b> — AKS Intelligent Systems LLP (Remote) | May – Jul 2026", body))
story.append(Paragraph("Built and deployed backend services in a production AI engineering team: API integration, deployment pipelines, applied AI/LLM workflows, technical documentation, version-controlled development. Ref AKS/HR/IC/2026/003.", body))

story.append(Paragraph("Projects", h2))
story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=2))
story.append(Paragraph("<b>Sangam</b> — Offline-first permissioned blockchain supply-chain platform (defence logistics). 15 services, 14 routes, ~13K LOC, JWT + refresh rotation, AES-256-GCM audit logging, 8-level RBAC, React 18 dashboard, 869 tests, Dockerized, OpenAPI 3.0.3. 90-day MVP sprint, zero cloud/CDN at runtime.", body))
story.append(Paragraph("<b>AnnaSuraksha</b> — PDS fraud intelligence platform. 16-signal deterministic fraud-risk engine, 6-layer ghost-beneficiary pipeline, JWT/BCrypt REST API (35+ endpoints), Merkle proofs on Hyperledger Fabric, Groq LLM (Llama 3.3-70B) explanations with rule-based fallback, 6,500+ lines Java, 49 commits, CI pipeline.", body))
story.append(Paragraph("<b>IntelliX</b> — ML code profiler. 4 classifiers (RF, GBM, SVM, NN) auto-selected via GridSearchCV, 93–100% test accuracy, Flask REST API (7 endpoints), SQLite history, versioned ModelRegistry, &lt;50ms per snippet, 200+ profiles/sec batch, 89 + 12 tests in GitHub Actions, Dockerized.", body))
story.append(Paragraph("<b>Discommon</b> — Procedural Pokémon-style Discord game. 13,800+ line TypeScript bot (discord.js v14, MariaDB) with a Rust/WASM cellular-automaton engine generating unique creatures from seeds. Real-time battle engine (PvP, PvE bosses, 1–5-player co-op raids), full game economy (lootboxes, runes, breeding, quests, 43 commands), Express web dashboard for live game-state management, covered by Jest.", body))

story.append(Paragraph("Skills", h2))
story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=2))
story.append(Paragraph("Python, Java 21, C++, TypeScript/JS, Rust, SQL — ML/DL, LLMs, Spring Boot, FastAPI, Flask, Express, REST, JWT, Docker, PostgreSQL, MariaDB, GitHub Actions, Groq API, Anthropic API", body))

story.append(Paragraph("Certifications", h2))
story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=2))
story.append(Paragraph("Honourable Mention — Supervity AutoPilot Hackathon (AI Employee build, ₹5,000 + Certificate of Achievement, Oct 2026) · AI Fluency badge, Claude Academy (Anthropic, Jul 2026) · CTRL FREAK 2026 Finalist, HackBriven (Oct 2026) · InnerVe X Grand Finalist, MLH (Jan 2026) · HackIndia Spark 4 (Mar 2026) · OpenCode PR #50385 (snapshot truncation fix, 3 CI runs on the PR, Oct 2026)", body))

story.append(Paragraph("Education", h2))
story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=2))
story.append(Paragraph("B.Tech CSE (AI/ML) | KCC Institute of Technology &amp; Management, Greater Noida | 2023 – 2027 | CGPA 7.0/10", body))

doc.build(story)
print(f"  wrote {OUT}")
print(f"  size: {OUT.stat().st_size} bytes")
OUT
