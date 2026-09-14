#!/usr/bin/env bash
# ============================================================
# PulseOps — GitHub Phase-by-Phase Push Script
# Run this locally after extracting the zip.
#
# Usage:
#   chmod +x push_to_github.sh
#   ./push_to_github.sh
#
# Requirements:
#   - git installed
#   - GitHub account: DeepxD-code
#   - Repo: https://github.com/DeepxD-code/PulseOps
#   - You are authenticated (gh auth login, or HTTPS with token)
# ============================================================

set -e

REPO_URL="https://github.com/DeepxD-code/PulseOps.git"
BRANCH="main"
EMAIL="trex2004avradeep@gmail.com"
USERNAME="DeepxD-code"

echo "=== PulseOps GitHub Push Script ==="
echo "Repo: $REPO_URL"
echo ""

# ── Configure git identity ──────────────────────────────────
git config user.email "$EMAIL"
git config user.name "$USERNAME"

# ── Init repo if needed ─────────────────────────────────────
if [ ! -d ".git" ]; then
  git init
  git remote add origin "$REPO_URL"
  echo "Git repo initialised."
fi

# ── Create .gitignore (must match root .gitignore — boss round-2) ──
cat > .gitignore << 'GITIGNORE'
# PulseOps .gitignore

# Secrets — never commit
.env
portal/storageState.json
portal/storageState*.json
config/profile.yml
config/settings.yml
config/blacklist.txt
config/contacts.yml
config/.cv_hash

# Generated artifacts
*.tar.gz
*.tgz
output/
data/
logs/
memory/cv_history/
temp_linkedin_jobs.json
temp_portal_jobs.json
memory/.github_synced.json
pulseops.db
output/html/

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/

# Node
node_modules/

# CV — gitignored per spec (only .example committed)
cv.md
GITIGNORE

git add .gitignore

# ── Phase 1: Foundation ─────────────────────────────────────
echo ""
echo "Committing Phase 1: Foundation..."
git add exceptions.py
git add persistence/__init__.py persistence/db_manager.py persistence/audit_log.py persistence/tsv_exporter.py
git add migrations/
git add config/*.example .env.example
git add main.py
git commit -m "feat(phase1): Foundation — exceptions, 12-table SQLite schema, audit log, migrations, main.py orchestrator

- 30-class typed exception hierarchy (exceptions.py)
- 12-table SQLite schema via migration runner (001-006)
- Append-only JSONL audit log (persistence/audit_log.py)
- Complete db_manager.py with all guardrail queries
- Config templates (.env.example, settings/profile/blacklist/contacts .example)
- main.py 9-phase orchestrator skeleton
- --simulate mode works with zero API keys (non-negotiable #5)
- --pause-sends / --resume-sends kill switch
- TSV exporter: jobs/outreach/outcomes after every run

Non-negotiables implemented: #3 (audit log), #5 (simulate), #7 (profile.yml generated)"

# ── Phase 2: CV Intelligence ────────────────────────────────
echo ""
echo "Committing Phase 2: CV Intelligence..."
git add core/__init__.py core/cv_parser.py core/cv_diff.py core/profile_builder.py
git add prompts/profile_builder.txt
git add config/profile.yml.example
git commit -m "feat(phase2): CV Intelligence — cv_parser, cv_diff, profile_builder

- core/cv_parser.py: pure-Python cv.md → CVData dataclass (no LLM)
  Parses name, contact, skills, experience, projects, education, certs
- core/cv_diff.py: snapshot system with JSONL changelog in memory/cv_history/
  Idempotent: second run with same cv.md returns has_changes=False
- core/profile_builder.py: CVData + Gemini→Groq cascade → config/profile.yml
  Keyword-only fallback for simulate/no-key mode
- prompts/profile_builder.txt: ≤2000 token budget, T=0.2

Non-negotiables: #1 (cv.md only human file), #7 (profile.yml generated not edited)"

# ── Phase 3: Sourcing ───────────────────────────────────────
echo ""
echo "Committing Phase 3: Sourcing..."
git add core/scraper.py
git add evaluation/__init__.py evaluation/deduplicator.py evaluation/location_filter.py
git commit -m "feat(phase3): Sourcing — scraper, semantic dedup, location filter

- core/scraper.py: LinkedIn (Node bridge), Google Jobs (SearchApi.io), TheirStack
  Mock listings for simulate mode (5 realistic backend intern roles)
- evaluation/deduplicator.py: fuzzy dedup across sources
  Levenshtein ≤2 + title overlap ≥70% + 48h window
  Priority: TheirStack > Google Jobs > LinkedIn
  Also filters already-processed jobs from DB
- evaluation/location_filter.py: preferred_cities + remote_preference
  Pass-through on unknown location when remote_ok=True

Non-negotiable #6: source failures tracked in source_health table"

# ── Phase 4: Domain Filter ──────────────────────────────────
echo ""
echo "Committing Phase 4: Domain Filter..."
git add evaluation/domain_filter.py
git add prompts/
git commit -m "feat(phase4): Domain Filter — Stage 1 hard filter + Stage 2 soft filter

- evaluation/domain_filter.py:
  Stage 1 (zero LLM cost): primary skill detection, hard_exclude, role_type_exclude,
    seniority_exclude (with intern/junior exception)
  Stage 2 (Gemini, ≤150+50 tokens, 5s timeout):
    Default PASS on timeout — never lose valid roles
- prompts/soft_filter.txt embedded in domain_filter.py
- prompts/full_evaluation.txt: 6-block 2500-token prompt template
- prompts/followup.txt: day-5 follow-up template
- prompts/memory_parser.txt: ≤500 token memory categorisation
- prompts/profile_builder.txt: cv.md → profile.yml

Non-negotiable #8: No LLM call before Stage 1 hard filter passes"

# ── Phase 5: Evaluation Engine ──────────────────────────────
echo ""
echo "Committing Phase 5: Evaluation Engine..."
git add evaluation/analyzer.py
git commit -m "feat(phase5): Evaluation Engine — 6-block LLM cascade with circuit breakers

- evaluation/analyzer.py: Gemini 2.5-flash-lite → Groq llama-3.3-70b → OpenAI gpt-4o-mini
- Circuit breakers: daily quota exhaustion disables engine for run
- 6-block output: match%, letter_grade, text_summary, bullet_adjustments,
  skill_gap, tailored_skills, recruiter_message, recruiter_email, contact_email,
  inferred_domain, domain_confidence, level_strategy, comp_research,
  star_stories (STAR+R), negotiation_notes, email_variant_used
- Feedback loop: loads bullets from phone_screen+ jobs only (non-negotiable #10)
- Memory context injected from context_loader (deferred memories for company)
- Temperature 0.2 across all engines

Non-negotiable #10: feedback loop only from phone_screen+ status"

# ── Phase 6: Resume Builder ─────────────────────────────────
echo ""
echo "Committing Phase 6: Resume Builder..."
git add core/resume_builder.py
git add templates/resume.html.jinja2
git commit -m "feat(phase6): Resume Builder — company-specific PDF via Playwright

- core/resume_builder.py: CVData + JobEvaluation → HTML → Playwright → PDF
  5 progressive layout profiles for 1-page fit
  Tailored bullet injection (fuzzy match), JD-ranked skill reordering
  Cert filtering (only if relevant cert in JD)
  Top 2 projects by JD keyword overlap
  Section rules: contact/summary/skills/education always; experience if exists
  1-page fit order: drop certs → drop lowest project → reduce font 0.5pt
- templates/resume.html.jinja2: ATS-optimised two-column header, A4, print-ready
  System fonts for portability, Playwright-compatible CSS

Verified: two different JDs produce structurally different resumes from same cv.md"

# ── Phase 7: Send Engine ────────────────────────────────────
echo ""
echo "Committing Phase 7: Send Engine..."
git add outreach/__init__.py outreach/send_engine.py outreach/email_sender.py
git add outreach/followup_engine.py
git commit -m "feat(phase7): Send Engine — all 10 guardrails + SMTP + follow-up

- outreach/send_engine.py: 10 guardrails in exact spec order (fail-fast)
  G1 ScoreCheck, G2 SemanticDuplicate, G3 Blacklist, G4 Referral (→Telegram alert),
  G5 Cooldown, G6 DomainLimit, G7 DailyCap→QUEUE, G8 SendWindow→QUEUE,
  G9 BounceCheck, G10 ContactEmail
  G4 fires Telegram referral alert instead of cold email
  G7/G8 return QUEUE not SKIP (processed next run by score priority)
- outreach/email_sender.py: SMTP port 465/587, 8-min gap enforcement,
  AUTO_SEND_EMAILS guard, PDF attachment
- outreach/followup_engine.py: Day-5 follow-up, G3/G7/G8/G9 subset,
  prompt template rendering, simulate mode

All 7 guardrail scenarios verified: G1/G3/G5/G7/G8/G10 + all-pass SEND"

# ── Phase 8: Memory System ──────────────────────────────────
echo ""
echo "Committing Phase 8: Memory System..."
git add memory/__init__.py memory/memory_parser.py memory/context_loader.py
git add memory/memory.py memory/outcome_tracker.py
git commit -m "feat(phase8): Memory System — 3-layer memory with CV-safe flagging

- memory/memory_parser.py: Gemini→Groq cascade (≤500 tokens)
  6 categories: callback|feedback|project|skill|preference|note
  4 immediate actions: add_to_blacklist|add_cooldown|flag_cv_candidate|deferred
  Keyword fallback for simulate/no-key mode (all 6 categories verified)
- memory/context_loader.py: injects deferred memories as MEMORY CONTEXT block
  Company-scoped: Stripe memories only inject into Stripe evaluations
- memory/memory.py: CLI — add, list, pending, context, delete, edit
- memory/outcome_tracker.py: records phone_screen|technical|final|offer|rejected|accepted
  phone_screen → auto-queues interview prep pack
  rejected → adds cooldown memory for that company

Non-negotiable #4: cv.md NEVER auto-modified — cv_candidate memories flagged only
Non-negotiable #10: feedback loop verified from phone_screen+ only"

# ── Phase 9: Notifications ──────────────────────────────────
echo ""
echo "Committing Phase 9: Notifications..."
git add notifications/__init__.py notifications/notifier.py notifications/reply_detector.py
git add notifications/interview_prep.py notifications/weekly_digest.py
git commit -m "feat(phase9): Notifications — Telegram, IMAP, weekly digest, prep packs

- notifications/notifier.py: 7 Telegram message types
  send_audit_summary (Telegram Audit Mode daily summary)
  send_match_card (per-job score/grade/AI analysis/PDF)
  send_source_health_alert (non-negotiable #6: 3 consecutive zeros)
  send_referral_alert (G4: contact exists → referral suggested)
  send_reply_alert (new recruiter reply detected)
  send_prep_pack (STAR+R + comp + negotiation at phone_screen)
  send_telegram_summary (weekly digest, generic)
  Graceful False (not exception) when Telegram unconfigured
- notifications/reply_detector.py: IMAP4_SSL, dedup, job status→Replied, simulate mode
- notifications/interview_prep.py: auto-trigger prep pack for phone_screen outcomes
  prep_sent=1 prevents double-sends
- notifications/weekly_digest.py: Sunday 09:00 IST
  7-day funnel, callback rates by score band + variant, skill gaps,
  follow-ups due, CV staleness, stale queue, anomaly flags
- persistence/tsv_exporter.py: jobs/outreach/outcomes TSV after every run"

echo ""
echo "=== All phase commits created ==="
echo ""
echo "Pushing to $REPO_URL branch=$BRANCH..."
git push -u origin "$BRANCH" --force
echo ""
echo "✅ Done! Check: https://github.com/DeepxD-code/PulseOps"
