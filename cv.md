# AVRADEEP MAJUMDER
AI/ML Engineer | Generative AI Engineer | Backend Developer
trex2004avradeep@gmail.com | +91 62890 50278 | https://github.com/DeepxD-code | https://linkedin.com/in/avradeep-majumder | West Bengal, India

## Summary
Final-year B.Tech (AI/ML), Class of 2027. Research lead on a GNN-based zero-day threat-detection project; production backend systems shipped in Java, Python and Node.

## Education
B.Tech — CSE (AI/ML) | KCC Institute of Technology & Management, Greater Noida | 2023 – 2027
- CGPA 7.0 / 10 — Coursework: ML, Deep Learning, Computer Vision, NLP, DSA, OS, DBMS

## Research
Zero-Day — Drift-Aware Explainable Anomaly Detection for Behavioral Threat Hunting (ongoing research) | Python, PyTorch, PyTorch Geometric (GNN), Graph Autoencoders, SHAP, scikit-learn, MITRE ATT&CK, CIC-IDS2017, CTU-13, NF-UNSW-NB15 | 2026 – Present
- Lead on a 4-person final-year research project; set the research direction and own the detection-modelling track — the GNN detector, the evaluation harness and the experimental record
- Designed a graph autoencoder over network-flow graphs — an unsupervised detector chosen deliberately over a classifier, because a zero-day carries no label by definition and a supervised model is structurally unable to flag one
- Evaluated on strictly held-out attack families absent from training; best fusion strategy reaches 0.9764 ± 0.0041 mean ROC-AUC across seven families (4 seeds, host-window granularity)
- Carried a held-out Botnet family from 0.7200 to 0.9645 ROC-AUC at k=30 (3 seeds, paired t = 18.8; backing experiment published at zero-day-results/k30/E92.html), then replicated the gain on a second dataset and across four independent benign training days
- Transfer to NF-UNSW-NB15-v2: zero-shot 0.5816 to 0.8362 by refitting the feature scaler on the target network alone
- Benchmarked against published unsupervised IDS work (PIKACHU, AutoGraphAD, Anomal-E, EULER, VGRNN); cleared three of five and recorded the PIKACHU and AutoGraphAD losses as documented negative results rather than dropping them
- Added SHAP explainability and MITRE ATT&CK mapping so every alert traces to named techniques; 27 experiment cards for this track published as evidence
- Authored unit-tested evaluation guards after auditing six experiments that produced invalid numbers through incorrect checkpoint/data/scaler pairing — replacing a luck-based defence with an enforced one

## Experience
Backend Developer — Development & Deployment | AKS Intelligent Systems LLP (Remote) | 01 May 2026 – 01 July 2026
- Software Trainee Intern (Backend Development & Deployment) — Ref: AKS/HR/IC/2026/003. Built and deployed backend services within a production AI engineering team across API integration, deployment pipelines, and applied AI/LLM-driven workflows under supervision
- Contributed two AI voice systems during the internship: AI-Call-Bot, a Java/Spring Boot outbound calling agent that discovers customer requirements over Twilio, matches them against a product catalogue, and issues quotations (see Projects); and ar-bot, a Python/FastAPI voice-quotation service rebuilt onto GPT-Realtime
- Ran a P0 security audit on AI-Call-Bot: removed a committed 9 MB Maven archive and a fabricated pom.xml, rotated .env secrets, and migrated off iText in response to CVE-2021-43113

Production Engineering — RFQ & Quotation Platform | AKS Intelligent Systems LLP (continued engagement) | 19 Aug 2026 – 17 Oct 2026
- Contributed to a production RFQ-to-quotation pipeline — Gmail intake, RFQ parsing, catalogue matching, quote generation, approval workflow and an automated negotiation engine — as one of two main authors (42K of 165K lines across 53 and 16 commits), in a Docker Compose monorepo with a 2,000+ test suite
- Owned production hardening: removed a hardcoded database password from the repository, corrected a localhost connection leak across services, fixed application-lifespan shutdown, and added auth, secrets management, migrations, TLS and backups
- Ran root-cause analysis on concurrent-negotiation, email-threading and matcher-performance defects, fixing double-processing and stuck-recovery paths and documenting each change in an append-only changelog
- Repository: github.com/AKS-Intelligent-Systems/ups_email_rfq — 53 of 69 commits

Open Source Contributor | anomalyco/opencode | Oct 2025 – Present
- Submitted two fixes to the snapshot subsystem — persisted diff-patch truncation (#50385, closed unmerged) and budget-withheld patch marking (#55231, open) — each with CI runs on the PR

Sports Event Organiser | West Bengal, India | 2023 – Present
- Conceptualised and executed multiple tournaments and community events; competitive football and cricket player at college and community level

## Projects
Sangam — Permissioned Blockchain Supply Chain Platform (Defence Logistics) | Node.js, Express, PostgreSQL, React 18, Vite, JWT, AES-256-GCM, Docker | github.com/DeepxD-code/Sangam | 2026
- Solo-architected an offline-first, permissioned blockchain supply chain platform for military logistics as a 90-day MVP — in-memory state, mesh networking, and graceful DB degradation with zero cloud/CDN dependency
- Engineered a 15-service backend with JWT auth + refresh-token rotation, AES-256-GCM audit logging, and an 8-level command-hierarchy RBAC system
- Built a React 18 + Vite command dashboard with real-time aggregation APIs, covered by a 1,000-call end-to-end verification suite across service boundaries, Dockerised and documented with OpenAPI

AnnaSuraksha — PDS Fraud Intelligence Platform | Java 21, Spring Boot 3.2.5, Hyperledger Fabric, Groq LLM (Llama 3.3-70B), JWT, BCrypt, SHA-256 | github.com/DeepxD-code/AnnaSuraksha | 2026
- Engineered a 16-signal deterministic fraud-risk scoring engine (weighted, compound-floor logic) and a 6-layer ghost-beneficiary detection pipeline, validated against 11 ground-truth fraud scenarios via a self-reporting accuracy API
- Built a JWT/BCrypt-secured REST API (35+ endpoints, OpenAPI-documented) with Merkle-tree data-integrity proofs anchored to Hyperledger Fabric chaincode and real-time SSE fraud alerts
- Integrated Groq LLM for natural-language fraud explanations with a deterministic rule-based fallback, keeping every flag auditable to specific NFSA 2013 provisions; 6,500+ lines of Java across 49 commits with a CI build/test pipeline

AI-Call-Bot — AI-Powered Product Discovery & Quotation System | Java 17, Spring Boot 3.2.4, Twilio Voice, OpenAI GPT-4o, Deepgram STT, PostgreSQL, Flyway, iTextPDF | 2026
- Built an outbound calling system where an AI agent discovers a customer's fastener requirements over Twilio, matches them against a catalogue, and delivers a quotation — driven by an explicit conversation state machine (INIT, LISTEN, PROCESS, ASK, FINALIZE, QUOTE, DELIVER)
- Implemented a GPT-4o NLU service, a filter-and-narrow catalogue matching engine over PostgreSQL, and a tier-based pricing engine, with quotation PDFs via iTextPDF delivered over email and WhatsApp
- Shipped 7,900+ lines of Java in layered packages with JUnit coverage, plus a Node/Express service for Twilio Media Streams and Deepgram STT; schema managed with Flyway

ar-bot — Voice Quotation Agent | Python, FastAPI, Twilio Voice, GPT-Realtime, Deepgram STT, Coqui TTS, WebSocket, React | AKS-Intelligent-Systems/ar-bot | 2026
- Rebuilt a legacy quotation codebase into a modular quotation_core package — a 216-file, ~7K-line restructure — and stood up real-time voice calling on GPT-Realtime alongside a Deepgram/Coqui text-to-speech pipeline
- Built the NLP layer for natural-language date extraction (regex, chrono and LLM extractors behind one pipeline) and a campaign manager handling scheduling, rate limiting, deduplication and escalation

IntelliX — ML-Powered Code Performance Profiler | Python, Flask, scikit-learn, Docker | github.com/DeepxD-code/IntelliX | 2026
- Built a multi-language (Python AST, C++, Java) profiler with 4 ML classifiers (Random Forest, Gradient Boosting, SVM, Neural Network) auto-selected via GridSearchCV on a curated in-repo benchmark set
- Shipped a Flask REST API (7 endpoints, Swagger-documented) with SQLite-backed history and a versioned ModelRegistry supporting rollback; profiles a snippet in <50ms and sustains 200+ profiles/sec in batch
- Covered by 16 unit tests + 6 API integration tests in a GitHub Actions CI pipeline; containerised for single-command deployment

## Technical Skills
- Languages: Python, Java 21, TypeScript/JavaScript, C++, Rust, SQL
- AI / ML: Graph Neural Networks, Graph Autoencoders, PyTorch, PyTorch Geometric, scikit-learn, Deep Learning, Computer Vision, LLMs, RAG, SHAP, Prompt Engineering, Groq API, Anthropic API, OpenAI GPT-4o
- Backend: FastAPI, Spring Boot 3.2, Flask, Express.js, REST, Celery, Redis, JWT Auth, Swagger/OpenAPI
- Frontend: React, Vite, Tailwind CSS
- Blockchain & Security: Hyperledger Fabric 2.5, SHA-256 chaining, AES-256-GCM, RBAC design
- Data & Infra: PostgreSQL, MariaDB, SQLite, MongoDB, Docker, Docker Compose, nginx, Grafana, Git/GitHub, GitHub Actions (CI/CD)

## Certifications
- Hackathon — InnerVe X Grand Finale: Grand Finalist (MLH Official Season 2026, Software Track, AIT Pune, January 2026); Team FireChainBrahMins. Placed among the top college teams nationally
- Hackathon — Supervity AutoPilot Hackathon: Ahmedabad Edition: Finalist, Honourable Mention (October 2026); Team SteaLersX. AI Employee build; Rs 5,000 cash prize
- Hackathon — CTRL FREAK 2026: Finalist (HackBriven offline finale, Ahmedabad, October 2026)
- Hackathon — HackIndia Spark 4: Certificate of Participation (NCR East Region 2026, KCCITM Greater Noida, March 2026); blockchain/logistics theme, PDS fraud-detection prototype
- AI Fluency: Framework and Foundations — Course Completion Badge, Claude Academy (Anthropic), issued 22 July 2026
- Coursera: Start Writing Prompts like a Pro (Google Cloud); Speed Up Data Analysis and Presentation Building with Google AI; Use AI as a Creative or Expert Partner; Advanced Prompt Engineering for Everyone (Vanderbilt); AI Fundamentals (Google Cloud, course 1 of the Google AI Professional Certificate); Trustworthy Generative AI (Vanderbilt); GPT Vision
