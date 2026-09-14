# Restructure Plan — PulseOps (Tier 2 App+libs)

## 1. Detected tier + prefix

- Tier: **2 — App + libs**. Reasoning: Python + Node + Go in one repo, 5 runnable deployables (daily, weekly, dashboard, tui, browser-apply).
- Prefix: `pulseops`. Triple: dir `kebab-case`, dist `pulseops-<kebab>`, import `pulseops_<snake>`.

## 2. Move table (no moves yet — approval required)

| Current path | New path | Rationale |
|---|---|---|
| `main.py`, `doctor.py`, `exceptions.py` | `apps/daily-pipeline/src/pulseops_pipeline/` | runnable daily deployable |
| `main_weekly.py` | `apps/weekly-scan/src/pulseops_weekly/` | runnable weekly deployable |
| `dashboard/app.py`, `dashboard/templates/` | `apps/dashboard/src/pulseops_dashboard/` | Flask app |
| `dashboard/tui/` | `apps/tui/` | Go TUI, keep `go.mod` |
| `portal/apply.mjs`, `portal/save_sessions.mjs`, `portal/startup_full.ps1` | `apps/browser-apply/src/` | runnable apply sidecar |
| `portal/scan.mjs`, `portal/check_liveness.mjs`, `linkedin_bridge.js` | `apps/weekly-scan/src/` sidecar | scan sidecars |
| `core/` | `packages/pulse-core/src/pulseops_core/` | shared CV/scrape/resume |
| `evaluation/` | `packages/pulse-eval/src/pulseops_eval/` | shared filters/eval |
| `outreach/` | `packages/pulse-outreach/src/pulseops_outreach/` | shared send engine |
| `persistence/` | `packages/pulse-store/src/pulseops_store/` | shared DB/audit |
| `notifications/` | `packages/pulse-notify/src/pulseops_notify/` | shared alerts/watcher |
| `memory/` | `packages/pulse-memory/src/pulseops_memory/` | shared memory |
| `github/` | `packages/pulse-github/src/pulseops_github/` | shared sync |
| `prompts/`, `templates/`, `config/*.example` | `packages/pulse-config/` | shared tenant-agnostic config |
| `migrations/` | `packages/pulse-store/migrations/` | DB-owned |
| `portal/portals.yml` | `apps/weekly-scan/portals.yml` | app config |
| `CRON.md`, `SCHEDULER.md` | `docs/runbooks/` | prose |
| `pulseops_complete_phases1_12_tar.gz`, `push_to_github.sh` | `docs/archive/` | superseded |
| `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | root (rewritten) | front door only |

## 3. New files

- Per unit: `README.md`, `CHANGELOG.md`, `pyproject.toml`/`package.json`, `tests/`
- Root: `ARCHITECTURE.md`, `CHANGELOG.md`, `Makefile`, `pyproject.toml` (ruff/mypy only), `package.json` (workspaces), `.env.example`, `scripts/*.sh+*.ps1`, `.github/workflows/ci.yml` (one file), `tests/test_package_metadata.py`, `tests/test_scaffold_imports.py`
- `docs/00-system-blueprint.md`, `docs/package-docs/index.md`, `docs/runbooks/{local-dev,deployment,release-process}.md`

## 4. Unclassified

- `cv.md` (gitignored human input) — leave at root, confirm?
- `portal/storageState.json`, `portal/startup_apply.ps1` (local secrets/session) — leave untracked, confirm `.gitignore`?
- `node_modules/`, `__pycache__/` — delete from tracking, keep ignored.

## 5. Blast radius

- ~40 Python files import `core|evaluation|outreach|persistence|notifications|memory|github` — rewrite to `pulseops_*`.
- `portal/*.mjs` import `js-yaml` only — no change.
- Verify: `bash scripts/bootstrap.sh`, `bash scripts/test.sh`, `python -m pytest apps/*/tests packages/*/tests tests`.

## 6. Job-platform apply fix (same branch, separate commit)

- Root cause: CI runs `portal/apply.mjs --live --auto` headless without login → `no Apply button found for generic` → preview screenshots only (`output/apply-preview-*.png`). LinkedIn `jobs/view` links hit authwall; generic selectors miss Naukri/Indeed Easy Apply.
- Fix both: (a) CI: prefer real ATS links (`greenhouse/lever/ashby`), add `naukri`/`indeed`/`linkedin` Easy Apply selectors + `storageState` restore already in `daily.yml:110`; (b) Local: `portal/save_sessions.mjs` + `startup_full.ps1` 30m visible Edge with saved session.
- Docs: clean `README.md` Where-to-look table + `docs/runbooks/local-dev.md`.
