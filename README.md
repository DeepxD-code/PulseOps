# PulseOps

Automated job search: scrape → evaluate → apply. Runs 2x daily + weekly portal scan.

> See [ARCHITECTURE.md](ARCHITECTURE.md) for system overview and [docs/RESTRUCTURE-PLAN.md](docs/RESTRUCTURE-PLAN.md) for Tier-2 layout plan.

## Where to look

| You're looking for... | Go to |
|---|---|
| Daily pipeline | `main.py` → `apps/daily-pipeline/` (planned) |
| Weekly portal scan | `main_weekly.py`, `portal/scan.mjs` |
| Browser auto-apply | `portal/apply.mjs` (`--dry-run` / `--live --auto`) |
| Login saver | `portal/save_sessions.mjs` → `portal/storageState.json` |
| Reusable libs | `core/`, `evaluation/`, `outreach/`, `persistence/`, `notifications/`, `memory/` → `packages/` (planned) |
| Job portals config | `portal/portals.yml` |
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

## Common checks

```bash
make test
make lint
python -m notifications.email_watcher --dry-run
node portal/scan.mjs --mock
node portal/apply.mjs --dry-run
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
- `portal/storageState.json` stays local (gitignored). Tarball with secrets untracked; history purge via BFG still TODO — rotate exposed keys.

## Documentation map

- [Architecture overview](ARCHITECTURE.md) — start here (to be written in restructure)
- [Restructure plan](docs/RESTRUCTURE-PLAN.md) — Tier-2 move table, approval needed before moves
- [Local dev runbook](docs/runbooks/local-dev.md) — planned
- [Deployment runbook](docs/runbooks/deployment.md) — planned
- `CRON.md` / `SCHEDULER.md` — current deploy docs (to be demoted to runbooks)
