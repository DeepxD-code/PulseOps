# PulseOps

Automated job search: scrape → evaluate → apply. Runs 2x daily + weekly portal scan.

> See [ARCHITECTURE.md](ARCHITECTURE.md) for system overview and [docs/RESTRUCTURE-PLAN.md](docs/RESTRUCTURE-PLAN.md) for Tier-2 layout plan.

## Where to look

| You're looking for... | Go to |
|---|---|
| Daily pipeline | `pulseops_pipeline.main` → `apps/daily-pipeline/` (planned) |
| Weekly portal scan | `pulseops_weekly.main_weekly`, `apps/weekly-scan/scan.mjs` |
| Browser auto-apply | `apps/browser-apply/apply.mjs` (`--dry-run` / `--live --auto`) |
| Unattended runner (the entry point) | `scripts/run-pulseops.ps1` / `scripts/run-pulseops.sh` |
| Scheduled tasks | `scripts/register-tasks.ps1` |
| Login saver | `apps/browser-apply/tools/signin.mjs` → `portal/<portal>-storageState.json` |
| Reusable libs | `packages/` (`pulse-eval`, `pulse-store`, `pulse-core`, …) |
| Job portals config | `apps/weekly-scan/portals.yml` |
| Runbooks | `docs/runbooks/` (planned; now `CRON.md`, `SCHEDULER.md`) |
| Env vars | [.env.example](.env.example) |

## What it does

1. Source from LinkedIn + Google Jobs + TheirStack + weekly Playwright portals.
2. Filter by domain (hard) + LLM soft filter.
3. Evaluate with Gemini → Groq cascade, build PDF resume.
4. Send email if guardrails pass, else queue. Browser-apply fills real forms.

## Job platforms — status

- Working headless on CI: Greenhouse, Lever, Ashby, Indeed, Glassdoor, Wellfound, YC (real Apply buttons).
- Needs your login (`portal/storageState.json`): Naukri, LinkedIn Easy Apply, Instahyre. Run `node portal/save_sessions.mjs`, log in once, press Enter.
- Without login, CI logs `authwall-skip` (not an error) and uses ATS links instead. No `example.com` mocks are submitted.

## Quick start

Unix:

```bash
pip install -r requirements.txt
npm install
cp .env.example .env
python doctor.py --init
python main.py --simulate
```

Windows (PowerShell):

```powershell
pip install -r requirements.txt
npm install
Copy-Item .env.example .env
python doctor.py --init
python main.py --simulate
```

## Running it unattended

One entry point, on purpose. Two half-runners used to exist: `run-auto.bat`
hardcoded a deleted path, and `run-automation.ps1` was weekly-only, took no lock
and resolved `python`/`node` from PATH (which a Task Scheduler action does not
inherit).

```powershell
# Register the schedules: daily 09:00 and 18:00, weekly Sunday 08:00.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1

# Or run one now, filling forms without submitting.
.\scripts\run-pulseops.ps1 -Job daily -DryRun

# Live, unattended, with the terms/legal attestations the boards require.
.\scripts\run-pulseops.ps1 -Job weekly -AcceptTerms -AcceptLegal
```

- The runner probes for the interpreter that actually has `pulseops_*`
  installed. On this machine `python` on PATH is 3.14 while the editable installs
  live in 3.12, and the old runner failed every night with ModuleNotFoundError.
- A single lock file means a slow apply batch cannot overlap the next tick and
  submit the same posting twice.
- Every run writes `output/run-<job>-<timestamp>.log`; a scheduled failure has no
  console, so the log is the only evidence.
- The apply phase runs with `--edge` and `PULSEOPS_EDGE_PROFILE`, defaulting to
  `.edge-profile-naukri` (the profile the scan signs into) and falling back to
  `.edge-profile`. Without a persistent profile every unattended run starts a
  clean browser, so each India board is a fresh login wall plus Cloudflare
  challenge and the batch ends as `NeedsReview` with no submissions. Sign in
  once in that window and the session survives.
- Ordering inside a batch: India-native board first, then fit score, then the
  board's own acceptance record. A US on-site role cannot be taken from Greater
  Noida at any score, so it never takes a slot ahead of a winnable India role.
- Attestations are opt-in flags because they are statements made on the
  candidate's behalf. The registered tasks pass them; nothing else does.

## Common checks

```bash
powershell -ExecutionPolicy Bypass -File scripts/test.ps1   # pytest + node --test
node apps/weekly-scan/scan.mjs --only-portal=naukri          # one portal, fast
node apps/browser-apply/tools/why-not-eligible.mjs           # why the queue is empty
node apps/browser-apply/apply.mjs --dry-run                  # fill, do not submit
```

## Tech stack

- **Backend**: Python 3.11 (`core/`, `evaluation/`, `outreach/`, `persistence/`)
- **Browser**: Node 20 + Playwright (`portal/`)
- **Dashboards**: Flask (`dashboard/app.py`), Go TUI (`dashboard/tui/`)
- **Data**: SQLite (`pulseops.db` on `pulseops-state` branch)
- **Notify**: Discord webhook, Telegram (optional), SMTP/IMAP Gmail

## Security defaults (audit round-2)

- G10 fail-closed: no JD email or scraped company-page email → `SKIP`, never `contact@` guesses.
- Secrets are per-name (`SMTP_PASSWORD`, `IMAP_PASSWORD`, `DISCORD_WEBHOOK_URL`, …), never one `ENV_FILE` blob.
- Cron browser-apply is preview-only; dispatch with `live_apply: true` to submit (`daily.yml`).
- Dashboard binds `127.0.0.1`; set `DASHBOARD_TOKEN` to require `X-Token` on `/api/run`, `/api/jobs/*/status`, `/api/pause`, `/api/resume`, `/api/jobs/*/mark-outreach`.
- `portal/storageState.json` stays local (gitignored). Historical credential exposure remains an unresolved release blocker; follow [`docs/security-history-incident.md`](docs/security-history-incident.md) to rotate/revoke credentials and audit backup/history refs before publishing.

## Documentation map

- [Architecture overview](ARCHITECTURE.md) — start here (to be written in restructure)
- [Restructure plan](docs/RESTRUCTURE-PLAN.md) — Tier-2 move table, approval needed before moves
- [Local dev runbook](docs/runbooks/local-dev.md) — planned
- [Deployment runbook](docs/runbooks/deployment.md) — planned
- `CRON.md` / `SCHEDULER.md` — current deploy docs (to be demoted to runbooks)
