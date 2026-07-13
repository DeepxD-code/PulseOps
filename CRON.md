# PulseOps — Scheduling: Cron & GitHub Actions

PulseOps needs two recurring jobs:

| Job | Script | Cadence | Workflow |
|---|---|---|---|
| Daily pipeline | `main.py` | every day, ~09:00 IST | `.github/workflows/daily.yml` |
| Weekly portal scan | `main_weekly.py` | Sunday, ~08:00 IST | `.github/workflows/weekly.yml` |

Pick **one** of the two approaches below — they're not meant to run
simultaneously against the same `pulseops.db`.

---

## Option A — GitHub Actions (recommended for a portfolio deployment)

GitHub Actions runners are stateless: every run starts from a clean
checkout. PulseOps needs `pulseops.db` (job history, send guardrail state —
cooldowns, daily caps, dedup) to persist *across* runs, so both workflows
follow the same pattern:

1. Check out a dedicated orphan branch, `pulseops-state`, into `.state/`.
2. Copy `pulseops.db`, `logs/`, `data/`, `memory/cv_history/`,
   `config/profile.yml`, and `config/.cv_hash` out of `.state/` into the
   working tree before running.
3. Run the pipeline.
4. Copy the same files back into `.state/` and force-push it to
   `pulseops-state`, **even if the run failed** (`if: always()`), so a
   crash mid-run doesn't lose the day's sends/evaluations that already
   happened.

The `pulseops-state` branch is created automatically on the first run —
you don't need to create it by hand.

### Required repository secrets

Everything in `.env` and the four gitignored `config/*` files needs to
exist as a GitHub secret, since none of that is committed to the repo.

| Secret | Contents |
|---|---|
| `ENV_FILE` | The **entire contents** of your local `.env` file, pasted as-is (multi-line secrets are supported) |
| `CV_MD` | The entire contents of your `cv.md` |
| `SETTINGS_YML` | The entire contents of `config/settings.yml` |
| `BLACKLIST_TXT` | The entire contents of `config/blacklist.txt` (can be empty) |
| `CONTACTS_YML` | The entire contents of `config/contacts.yml` (can be empty) |

`config/profile.yml` is **not** a secret you set by hand — it's generated
from `cv.md` and persisted on the `pulseops-state` branch across runs,
consistent with non-negotiable #7 (generated, never manually edited).

Set these under **Settings → Secrets and variables → Actions → New
repository secret**.

### First run

```bash
# trigger manually instead of waiting for the cron schedule
gh workflow run daily.yml -f simulate=true     # sanity check first
gh workflow run daily.yml                       # then a real run
gh workflow run weekly.yml -f simulate=true
```

Or use the "Run workflow" button in the Actions tab — both workflows
accept a `simulate` input for exactly this purpose.

### Concurrency & kill switch

Both workflows set `concurrency.cancel-in-progress: false` — a daily run
already mid-send is never cancelled by a new trigger piling on top of it.
To pause all auto-sends without touching the schedule:

```bash
# run once, locally or via workflow_dispatch with a one-off script:
python main.py --pause-sends
# ... later ...
python main.py --resume-sends
```

Since this writes to `pulseops.db`, run it via a manual `workflow_dispatch`
that commits state back the same way, or simply edit the `settings` table
through the Flask dashboard's pause button (works against any checkout
that has the current `pulseops.db`).

---

## Option B — Self-hosted cron (Linux/macOS)

If you're running PulseOps on a machine you control, skip the GitHub
Actions state-branch dance entirely — `pulseops.db` just lives on disk.

```cron
# crontab -e
# Daily pipeline — 09:00 IST. Adjust the hour if your server isn't UTC+5:30.
30 3 * * * cd /path/to/pulseops && /usr/bin/python3 main.py >> logs/cron_daily.log 2>&1

# Weekly portal scan — Sunday 08:00 IST
30 2 * * 0 cd /path/to/pulseops && /usr/bin/python3 main_weekly.py >> logs/cron_weekly.log 2>&1
```

Notes:
- Use absolute paths everywhere in cron — it does not source your shell
  profile, so `python3`/`node` must be findable via `/usr/bin/env` or a
  full path, and `.env` is loaded via `python-dotenv` relative to the
  script's own directory, not your shell's `$PWD`.
- `main_weekly.py` launches a real Chromium via Playwright — make sure
  `npx playwright install chromium` has been run on that machine at least
  once, and that the cron user has a writable `$HOME` for the browser
  cache (`doctor.py --check` will flag this if it's missing).

## Windows Task Scheduler

Equivalent to the cron entries above:

1. Create a Basic Task, trigger **Daily at 09:00**, action:
   `python.exe C:\path\to\pulseops\main.py`, start-in:
   `C:\path\to\pulseops`.
2. Create a second task, trigger **Weekly, Sunday at 08:00**, action:
   `python.exe C:\path\to\pulseops\main_weekly.py`, same start-in directory.

See `SCHEDULER.md` for the Task Scheduler XML import files if you'd
rather not click through the wizard twice.
