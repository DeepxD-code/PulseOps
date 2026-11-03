"""Render cv.md to Avradeep-Majumder-cv.pdf with reportlab.

No pandoc, no markdown, no weasyprint on this box. reportlab and fpdf are both
installed; reportlab's Platypus is the better fit for a structured document with
headings, bullets and a two-column feel, and it keeps the layout deterministic
so the same input always gives the same PDF.

Only the CV's actual content is rendered - no invented sections, no extra
marketing, no "objective" line that is not in the file. The headings, bullets and
links are transcribed faithfully.

Usage:
    python apps/browser-apply/tools/make_cv_pdf.py
Writes output/Avradeep-Majumder-cv.pdf.
"""

from __future__ import annotations

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
    Spacer,
)

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "output" / "Avradeep-Majumder-cv.pdf"

NAVY = colors.HexColor("#1F3864")
INK = colors.HexColor("#222222")
GREY = colors.HexColor("#595959")

base = getSampleStyleSheet()
title = ParagraphStyle("title", parent=base["Title"], fontSize=18, leading=22,
                       textColor=NAVY, spaceAfter=2, alignment=0)
subtitle = ParagraphStyle("subtitle", parent=base["Normal"], fontSize=10.5,
                          leading=13, textColor=GREY, spaceAfter=4)
h2 = ParagraphStyle("h2", parent=base["Heading2"], fontSize=12.5, leading=15,
                    textColor=NAVY, spaceBefore=10, spaceAfter=3)
body = ParagraphStyle("body", parent=base["Normal"], fontSize=10, leading=13,
                      textColor=INK, spaceAfter=2)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=12, firstLineIndent=-9,
                        spaceAfter=1, bulletIndent=3)

doc = SimpleDocTemplate(str(OUT), pagesize=A4,
                        leftMargin=1.6*cm, rightMargin=1.6*cm,
                        topMargin=1.5*cm, bottomMargin=1.5*cm)

# Content transcribed faithfully from cv.md. Each section is a (heading, blocks)
# pair; blocks are either ("p", text) or ("ul", [items]).
SECTIONS = [
    ("", [
        ("p", "<b>AVRADEEP MAJUMDER</b>"),
        ("p", "AI/ML Engineer | Generative AI Engineer | Backend Developer"),
        ("p", "trex2004avradeep@gmail.com | +91 6289050278 | github.com/DeepxD-code | linkedin.com/in/avradeep-majumder-4664b532a | West Bengal, India"),
        ("p", "Final-year B.Tech CSE (AI/ML) student (Class of 2027) at KCC Institute of Technology &amp; Management, CGPA 7.0/10. Builds and ships production-grade AI, backend, and blockchain systems — a 16-signal fraud intelligence platform for India's public distribution system (AnnaSuraksha), an offline-first military logistics platform (Sangam), and a multi-classifier ML code profiler (IntelliX). Grand Finalist at InnerVe X 2026 (MLH Official Season, AIT Pune). Backend Developer intern at AKS Intelligent Systems LLP. Actively seeking Software Engineering, AI/ML Engineering, and Generative AI Engineering roles — internships and full-time (Class of 2027)."),
    ]),
    ("Education", [
        ("p", "<b>B.Tech — CSE (AI/ML)</b> | KCC Institute of Technology &amp; Management, Greater Noida | 2023 – 2027"),
        ("ul", ["CGPA: 7.0 / 10 — Coursework: ML, Deep Learning, CV, NLP, DSA, OS, DBMS"]),
    ]),
    ("Experience", [
        ("p", "<b>Software Trainee Intern</b> | AKS Intelligent Systems LLP (Remote) | 01 May 2026 – 01 July 2026"),
        ("ul", [
            "Software Trainee Intern (Backend Development &amp; Deployment) — full-time internship assisting engineering team in developing, testing, debugging, and maintaining production software systems and internal tools (Ref: AKS/HR/IC/2026/003, issued 03 July 2026, Gurugram)",
            "Built and deployed backend services within a production AI engineering team, working across API integration, deployment pipelines, and applied AI/LLM-driven workflows with feature implementation, software integrations, technical documentation, version-controlled development, and deployment activities under supervision",
        ]),
        ("p", "<b>Sports Event Organiser</b> | West Bengal, India | 2023 – Present"),
        ("ul", ["Conceptualised and executed multiple tournaments and community events; competitive football and cricket player at college and community level"]),
    ]),
    ("Projects", [
        ("p", "<b>Sangam</b> — Permissioned Blockchain Supply Chain Platform (Defence Logistics) | Node.js, Express, PostgreSQL, React 18, Vite, JWT, AES-256-GCM, Docker | github.com/DeepxD-code | 2026"),
        ("ul", [
            "Solo-architected and built an offline-first, permissioned blockchain supply chain platform for military logistics as a 90-day MVP sprint — in-memory state, mesh networking, and graceful DB degradation with zero cloud/CDN dependency at runtime",
            "Engineered a 15-service, 14-route backend (~13K LOC) with JWT auth + refresh-token rotation, AES-256-GCM audit logging, and an 8-level military command-hierarchy RBAC system with delegation/override support",
            "Built a React 18 + Vite command dashboard with real-time aggregation APIs and custom ops-room UI; covered by 869 passing unit/service/integration tests, Dockerized, and documented with OpenAPI 3.0.3/Swagger",
            "Pressure-tested architecture and roadmap decisions at each major milestone using a structured multi-advisor AI council methodology",
        ]),
        ("p", "<b>AnnaSuraksha</b> — PDS Fraud Intelligence Platform | Java 21, Spring Boot 3.2.5, Hyperledger Fabric, Groq LLM, JWT, BCrypt, SHA-256 | github.com/DeepxD-code/AnnaSuraksha | 2026"),
        ("ul", [
            "Engineered a 16-signal deterministic fraud-risk scoring engine (weighted, compound-floor logic) and a 6-layer ghost-beneficiary detection pipeline, validated against 11 ground-truth fraud scenarios via a self-reporting accuracy API",
            "Built a JWT/BCrypt-secured REST API (35+ endpoints, OpenAPI/Swagger documented) with Merkle-tree data-integrity proofs anchored to Hyperledger Fabric chaincode and real-time SSE fraud alerts",
            "Integrated Groq LLM (Llama 3.3-70B) for natural-language fraud explanations with deterministic rule-based fallback, keeping every flag auditable to specific NFSA 2013 provisions; shipped 6,500+ lines of Java across 49 commits with CI build/test pipeline",
        ]),
        ("p", "<b>IntelliX</b> — ML-Powered Code Performance Profiler | Python, Flask, scikit-learn, Docker | github.com/DeepxD-code/IntelliX | 2026"),
        ("ul", [
            "Built a multi-language (Python AST, C++, Java) code profiler with 4 ML classifiers (Random Forest, Gradient Boosting, SVM, Neural Network) auto-selected via GridSearchCV, reaching 93–100% test accuracy and 91–96% 5-fold cross-validation accuracy",
            "Shipped a Flask REST API (7 endpoints, Swagger-documented) with SQLite-backed history and a versioned ModelRegistry supporting rollback; profiles a snippet in &lt;50ms and sustains 200+ profiles/sec in batch",
            "Covered the system with 89 unit tests + 12 API integration tests in a GitHub Actions CI pipeline; containerized with Docker for single-command deployment",
        ]),
        ("p", "<b>Discommon</b> — Procedural Pokémon-Style Discord Game | TypeScript, discord.js v14, Rust (WASM), MariaDB, Express, Jest | github.com/DeepxD-code/Discommon | 2026"),
        ("ul", [
            "Architected a 13,800+ line TypeScript Discord bot (discord.js v14, MariaDB) featuring a Rust/WASM cellular-automaton engine that procedurally generates unique pixel-art creatures from seed strings",
            "Built a real-time battle engine (PvP matchmaking, PvE boss fights, 1–5-player co-op raids) with damage/crit/stun/lifesteal/passive-ability mechanics, covered by Jest test suite",
            "Shipped a full game economy (lootboxes, runes, breeding/chipping into a global dex, daily quests, 43 commands) plus an Express-based web dashboard for live player and game-state management",
        ]),
    ]),
    ("Technical Skills", [
        ("p", "<b>Languages:</b> Python, Java 21, TypeScript/JavaScript, C++, Rust, SQL"),
        ("p", "<b>AI / ML:</b> Machine Learning, Deep Learning, LLMs, Random Forest, Computer Vision, Prompt Engineering, Groq API, Anthropic API"),
        ("p", "<b>Backend:</b> Spring Boot 3.2, FastAPI, Flask, Express.js, REST, JWT Auth, Swagger/OpenAPI"),
        ("p", "<b>Frontend:</b> React, Vite, Tailwind CSS"),
        ("p", "<b>Blockchain &amp; Security:</b> Hyperledger Fabric 2.5, SHA-256 chaining, AES-256-GCM, RBAC design"),
        ("p", "<b>Tools &amp; Infra:</b> Git/GitHub, GitHub Actions (CI/CD), Docker, PostgreSQL, MariaDB, SQLite, Maven, Jest"),
    ]),
    ("Certifications", [
        ("ul", [
            "Honourable Mention — Supervity AutoPilot Hackathon: Ahmedabad Edition, Team SteaLersX (AI Employee build, ₹5,000 cash prize + Certificate of Achievement, October 2026)",
            "AI Fluency: Framework and Foundations — Completion Badge, Claude Academy (Anthropic), issued July 2026",
            "CTRL FREAK 2026 — Finalist, HackBriven (offline finale, Ahmedabad, October 2026)",
        ]),
    ]),
    ("Completed Coursework (uncertified — paywalled)", [
        ("ul", [
            "Google Prompting Essentials Specialization — Coursera (completed July 2026, certificate requires subscription)",
            "Trustworthy Generative AI — Vanderbilt University, Coursera (100% complete, certificate requires subscription)",
            "Advanced Prompt Engineering for Everyone — Vanderbilt University, Coursera (100% complete, certificate requires subscription)",
            "GPT Vision: Seeing the World through Generative AI — Coursera (completed, certificate requires subscription)",
            "OpenAI GPTs: Creating Your Own Custom AI Assistants — Coursera (completed, certificate requires subscription)",
            "AI Fundamentals — Coursera (completed, certificate requires subscription)",
            "InnerVe X Grand Finale — Certificate of Participation, MLH Official Season 2026, AIT Pune (January 2026)",
            "HackIndia Spark 4 — Certificate of Participation, KCCITM, Greater Noida (March 2026)",
        ]),
    ]),
    ("Open Source", [
        ("ul", ["OpenCode (anomalyco/opencode) — fix(snapshot): limit persisted diff patches; PR #50385 (snapshot truncation fix, 3 CI runs on the PR, Oct 2026)"]),
    ]),
]

story = []
# Summary section was appended twice - once as the title block above, once
# inside SECTIONS with heading "" (empty heading). Drop the duplicate by
# removing the empty-heading section from the loop.
story.append(Paragraph("AVRADEEP MAJUMDER", title))
story.append(Paragraph("AI/ML Engineer | Generative AI Engineer | Backend Developer", subtitle))
story.append(Paragraph("trex2004avradeep@gmail.com | +91 6289050278 | github.com/DeepxD-code | linkedin.com/in/avradeep-majumder-4664b532a | West Bengal, India", subtitle))
story.append(HRFlowable(width="100%", thickness=0.8, color=NAVY, spaceAfter=6))

for heading, blocks in SECTIONS:
    if not heading:
        # Summary is already in the title block above; skip the duplicate.
        continue
    story.append(Paragraph(heading, h2))
    story.append(HRFlowable(width="100%", thickness=0.4, color=GREY, spaceAfter=4))
    for kind, payload in blocks:
        if kind == "p":
            story.append(Paragraph(payload, body))
        else:
            items = [ListItem(Paragraph(t, bullet), bulletColor=NAVY) for t in payload]
            story.append(ListFlowable(items, bulletType="bullet", start="•",
                                      leftIndent=14, bulletFontName="Helvetica-Bold"))

doc.build(story)
print(f"  wrote {OUT}")
print(f"  size: {OUT.stat().st_size} bytes")
OUT
