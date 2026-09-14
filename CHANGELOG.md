# Changelog

## [Unreleased] — Boss round-3 (round-2 FAIL → close gaps)

- `mark-outreach` now behind `DASHBOARD_TOKEN`; README documents `live_apply`, token, per-secret setup, G10 fail-closed.
- `_linkedin_people_emails` deprecated to `return []` (no pattern emails).
- Tarball history purge still TODO (BFG) — keys assumed compromised until rotated.

## [Unreleased] — Boss round-2 (audit FAIL → fixes)

### Security

- Removed `contact@domain` unverified fallback in `outreach/send_engine.py` — G10 now raises `NoContactEmailError` unless JD email or scraped company page hits.
- Split `ENV_FILE` blob into per-secret env vars in `daily.yml` / `watcher.yml` (SMTP/IMAP/LLM/Discord/Telegram separate).
- Untracked `pulseops_complete_phases1_12_tar.gz` (embedded `cv.md` + secrets), added `*.tar.gz` to `.gitignore`. History purge still TODO (BFG).
- Gated browser auto-submit: cron defaults to `--dry-run`; `live_apply=true` dispatch input required for `--live --auto`.
- State pushes use `--force-with-lease` (daily + watcher).
- Dashboard mutating routes (`/api/run`, `/api/jobs/*/status`, `/api/pause`, `/api/resume`) require `DASHBOARD_TOKEN` when set; server still binds `127.0.0.1` by default.
- `push_to_github.sh` .gitignore template synced (storageState, cv_hash, tarballs); `save_sessions.mjs` no longer prints wrong secret name.
- Watcher: no fabricated `platform.com/inbox/` links, no hardcoded Gmail default; fails loud without IMAP creds.

### Tests

- Added `tests/test_guardrails_smoke.py` (G1 blocks low score, G10 fail-closed). `2 passed`.
- `node --check` clean for `portal/apply.mjs`, `portal/scan.mjs`.
