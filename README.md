# PulseOps 🚀

**Fully headless, automated job search pipeline** combining PulseMatch AI + Career-Ops.

Scrapes broadly → evaluates strategically → applies selectively. Runs unattended on a daily cron.

---

## Architecture (12/12 Phases Built)

```
Phase 1  Foundation        — SQLite (12 tables), typed exceptions, audit log, main.py
Phase 2  CV Intelligence   — cv_parser, cv_diff, profile_builder → profile.yml
Phase 3  Sourcing          — LinkedIn + Google Jobs + TheirStack + fuzzy dedup + GitHub sync
Phase 4  Domain Filter     — Stage 1 hard (zero LLM) + Stage 2 soft (Gemini, 150 tokens)
Phase 5  Evaluation        — 6-block LLM cascade: Gemini → Groq → OpenAI
Phase 6  Resume Builder    — Jinja2 → Playwright PDF, 5 layout profiles, 1-page fit
Phase 7  Send Engine       — All 10 guardrails, G7/G8 QUEUE not SKIP, SMTP 8-min gap
Phase 8  Memory System     — 3-layer memory, CLI, outcome tracker, prep pack trigger
Phase 9  Notifications     — Telegram (7 types), IMAP reply, weekly digest, follow-ups
Phase 10 Dashboards        — Flask web dashboard + Go TUI (Bubble Tea, Catppuccin Mocha)
Phase 11 Weekly Portal Scan— Playwright: Naukri, Instahyre, Wellfound India + 10 ATS boards
Phase 12 Hardening         — doctor.py, GitHub Actions (daily + weekly), cron/Task Scheduler docs
```

All 12 phases are built and verified end-to-end via `--simulate` (zero API
keys, zero network). See `pulseops_session_handoff.md` for the phase-by-phase
build log and verification commands.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/DeepxD-code/PulseOps.git
cd PulseOps

# 2. Install
pip install -r requirements.txt
npm install  # for LinkedIn bridge

# 3. Configure
cp .env.example .env
# Edit .env with your API keys

# 4. Create your CV
# Create cv.md with your CV in Markdown format

# 5. Initialise
python doctor.py --init        # generates config/profile.yml from cv.md
python doctor.py --check       # verify all dependencies

# 6. Test offline (no API keys needed)
python main.py --simulate

# 7. Run live
python main.py
```

---

## Non-Negotiables (Never Violated)

| # | Rule |
|---|------|
| 1 | `cv.md` is the only file a human ever edits |
| 2 | No application sent without passing all 10 guardrails |
| 3 | Every autonomous action logged to append-only audit log |
| 4 | Memory never auto-modifies `cv.md` — flags `cv_candidates` only |
| 5 | Simulation mode works with zero API keys, always |
| 6 | Source failures never silent — Telegram alert after 3 consecutive zeros |
| 7 | `profile.yml` is generated, never manually edited |
| 8 | No LLM call before Stage 1 hard domain filter passes |
| 9 | Referral check always before cold email (G4 → Telegram referral alert) |
| 10 | Feedback loop only learns from jobs that reached `phone_screen` or beyond |

---

## 10 Send Guardrails (Exact Order, Fail-Fast)

```
G1  ScoreCheck            score >= 88
G2  SemanticDuplicateCheck not already applied
G3  BlacklistCheck        not in config/blacklist.txt
G4  ReferralCheck         no contact at company → SKIP + Telegram referral alert
G5  CooldownCheck         not contacted in last 30 days
G6  DomainLimitCheck      < 2 emails to domain today
G7  DailyCapCheck         < 5 total sends today → QUEUE (not SKIP)
G8  SendWindowCheck       09:00-18:00 IST → QUEUE (not SKIP)
G9  BounceCheck           domain not bounce-paused
G10 ContactEmailCheck     contact email found OR Hunter.io verified lookup
```

### Outreach modes (`config/settings.yml` → `outreach.mode`)

G10 tries, in order: (1) an email explicitly listed in the JD, (2) a
[Hunter.io](https://hunter.io) verified lookup if `HUNTER_API_KEY` is set.
**Hunter.io is optional, not required** — and in practice its signup form
rejects personal Gmail/Outlook addresses outright (confirmed: it needs an
actual company domain, "work email" isn't just a label). Every A/B/C match
— regardless of what G10 decides — gets a full LinkedIn DM draft delivered
to your Telegram match card. Without Hunter.io, that DM draft *is* your
primary outreach channel; cold-email auto-send only fires on the (less
common) jobs where the listing itself includes a recruiter email. This is
the `dm_first` mode and it's the default — the pipeline was designed to be
genuinely useful with zero third-party email-finding services, not just
gracefully degraded without them. `doctor.py --check` and the weekly digest
both understand this and won't flag a low "Sent" count as a problem when
running this way.

**Tracking manual DMs:** since you send these by hand, PulseOps can't
detect on its own that you did. After copying a DM draft, mark it sent:
- **Flask dashboard:** open the job → "Mark sent" button next to the DM draft
- **Go TUI:** select the job, press `d`
- **Why this matters, not just for the record:** a marked DM writes to the
  same `outreach` table the auto-email path uses, so (1) G5's 30-day
  cooldown correctly stops the pipeline from also cold-emailing that
  company later, and (2) the weekly digest's callback-rate calibration can
  actually see your real outreach volume instead of being blind to
  everything except the rare auto-sent email.

---

## Memory System

```bash
# Add memories
python memory/memory.py add "Got callback from Stripe. Failed system design round."
python memory/memory.py add "Built C++ load balancer, 100k connections. Add to CV."
python memory/memory.py add "Avoid Infosys, Wipro, TCS — service companies."

# Review
python memory/memory.py list
python memory/memory.py pending          # cv_candidates awaiting cv.md update
python memory/memory.py context Stripe   # what injects into next Stripe eval

# Record outcomes
python memory/outcome_tracker.py record "Stripe" "Backend Intern" phone_screen "Great call!"
python memory/outcome_tracker.py record "Stripe" "Backend Intern" rejected "Failed distributed systems"
```

---

## Commands

```bash
python main.py                   # Full daily pipeline
python main.py --simulate        # Offline dry-run (zero API calls)
python main.py --force           # Re-evaluate already-seen jobs
python main.py --pause-sends     # Halt all outreach (kill switch)
python main.py --resume-sends    # Re-enable outreach
python main.py --dashboard       # Launch the Flask web dashboard (localhost:5000)

python main_weekly.py            # Weekly Playwright portal scan (Naukri/Instahyre/Wellfound + ATS boards)
python main_weekly.py --simulate # Offline dry-run with mock portal data

python doctor.py --check         # Health check
python doctor.py --init          # First run: generate profile.yml
python doctor.py --sync-profile  # Resync after cv.md changes
python doctor.py --apply-memories # Review cv_candidate memories

# Go TUI (build once, then run directly)
cd dashboard/tui && go mod tidy && go build -o pulseops-tui .
./dashboard/tui/pulseops-tui
```

See `CRON.md` for GitHub Actions / Linux cron deployment and `SCHEDULER.md`
for Windows Task Scheduler.

---

## Tech Stack

```
Python 3.11+  — core pipeline
Node.js 20    — LinkedIn bridge + Playwright portal scanner (Naukri/Instahyre/Wellfound/ATS boards)
Go 1.22+      — TUI dashboard (Bubble Tea + Lipgloss, Catppuccin Mocha)
SQLite        — source of truth (shared by Flask dashboard, Go TUI, and both pipelines)
Jinja2        — resume templates
Playwright    — HTML → PDF, weekly portal scan
Flask         — web dashboard
LLMs          — Gemini 2.5-flash-lite → Groq llama-3.3-70b → OpenAI gpt-4o-mini
Telegram      — primary notification interface
SMTP/IMAP     — Gmail outreach + reply detection
```

---

## Configuration

| File | Purpose |
|------|---------|
| `.env` | API keys, SMTP, Telegram (gitignored) |
| `config/settings.yml` | Thresholds, guardrail values (gitignored) |
| `config/blacklist.txt` | Companies to never contact (gitignored) |
| `config/contacts.yml` | Network contacts for G4 referral check (gitignored) |
| `config/profile.yml` | Auto-generated from cv.md (gitignored) |
| `cv.md` | **Your CV — the ONLY file you ever edit** (gitignored) |

---

## Target Domain

Backend Engineering intern/junior/new-grad roles in India (Bangalore, Hyderabad, Pune, Chennai).
Core skills: Java, C++, Python, Go, Spring Boot, gRPC, PostgreSQL, Redis, Kafka, Docker, Kubernetes.
Hard excludes: React, Angular, Vue, Figma, Flutter, Swift, Android, iOS.

---

*Built by combining [PulseMatch AI](https://github.com/your-username/pulsematch-ai) + [Career-Ops](https://github.com/santifer/career-ops)*
