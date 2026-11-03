#!/usr/bin/env bash
# PulseOps unattended runner — the POSIX counterpart of scripts/run-pulseops.ps1.
#
# Same contract: one entry point for cron and for a human, one lock, pipeline
# then live apply, everything logged. Kept as a separate script rather than a
# cross-platform one because the Windows runner needs a persistent Edge profile
# for Naukri, which has no POSIX equivalent.
#
# Usage:
#   ./scripts/run-pulseops.sh daily            # daily pipeline + live apply
#   ./scripts/run-pulseops.sh weekly --dry-run # scan + pipeline, fill but do not submit
#
# Cron (09:00 and 18:00 daily, Sunday 08:00 weekly):
#   0 9,18 * * *  /path/to/PulseOps/scripts/run-pulseops.sh daily   >> /path/to/PulseOps/output/cron.log 2>&1
#   0 8 * * 0     /path/to/PulseOps/scripts/run-pulseops.sh weekly  >> /path/to/PulseOps/output/cron.log 2>&1

set -uo pipefail

JOB="${1:-daily}"
shift || true

DRY_RUN=0
SKIP_APPLY=0
ACCEPT_TERMS=0
ACCEPT_LEGAL=0
SKIP_LIVENESS=0
NO_PUSH=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-apply) SKIP_APPLY=1 ;;
    --accept-terms) ACCEPT_TERMS=1 ;;
    --accept-legal) ACCEPT_LEGAL=1 ;;
    --skip-liveness) SKIP_LIVENESS=1 ;;
    --no-push) NO_PUSH=1 ;;
    *) echo "[warn] unknown argument: $arg" ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p output
LOG="output/run-$JOB-$STAMP.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ── Single-instance lock ────────────────────────────────────────────────────
LOCK_DIR="output/.pulseops.lock.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[lock] another PulseOps run holds $LOCK_DIR — exiting" | tee -a "$LOG"
  exit 0
fi
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

PYTHON=""
# The interpreter must be the one the packages were installed into; probe rather
# than trusting PATH (python3 may be newer than the editable installs).
for candidate in "$(command -v python3 || true)" "$(command -v python || true)"; do
  [ -z "$candidate" ] && continue
  "$candidate" -c "import pulseops_pipeline, pulseops_weekly, pulseops_eval, pulseops_store" >/dev/null 2>&1 && { PYTHON="$candidate"; break; }
done
if [ -z "$PYTHON" ]; then
  PYTHON="$(command -v python3 || command -v python || true)"
  [ -n "$PYTHON" ] && echo "[warn] no interpreter has the PulseOps packages installed; falling back to $PYTHON" | tee -a "$LOG"
fi
NODE="$(command -v node || true)"
[ -z "$PYTHON" ] && { log "[fatal] python not found"; exit 127; }
[ -z "$NODE" ] && [ "$SKIP_APPLY" -eq 0 ] && { log "[fatal] node not found"; exit 127; }

log "=== PulseOps run: job=$JOB dryRun=$DRY_RUN log=$LOG ==="
log "python=$PYTHON node=${NODE:-none}"

# ── 1. Pipeline ─────────────────────────────────────────────────────────────
if [ "$JOB" = "weekly" ]; then
  ARGS=(-m pulseops_weekly.main_weekly)
  [ "$SKIP_LIVENESS" -eq 1 ] && ARGS+=(--skip-liveness)
else
  ARGS=(-m pulseops_pipeline.main)
fi

log "--- pipeline: $PYTHON -u -X utf8 ${ARGS[*]}"
"$PYTHON" -u -X utf8 "${ARGS[@]}" 2>&1 | tee -a "$LOG"
PIPELINE_EXIT=${PIPESTATUS[0]}
log "pipeline_exit=$PIPELINE_EXIT"

# ── 2. Live browser apply ───────────────────────────────────────────────────
APPLY_EXIT=0
if [ "$SKIP_APPLY" -eq 1 ]; then
  log "--- browser apply skipped by --skip-apply"
elif [ -z "$NODE" ]; then
  log "--- browser apply skipped: node missing"
else
  export PULSEOPS_ALLOW_EXTERNAL_APPLY=1
  # --edge keeps one persistent msedge profile: without it every run is a fresh
  # login wall plus Cloudflare challenge on the India boards.
  EDGE_PROFILE="$REPO/.edge-profile-naukri"
  [ -d "$EDGE_PROFILE" ] || EDGE_PROFILE="$REPO/.edge-profile"
  export PULSEOPS_EDGE_PROFILE="$EDGE_PROFILE"
  APPLY_ARGS=(apps/browser-apply/apply.mjs --edge --headed --otp-pause)
  if [ "$DRY_RUN" -eq 1 ]; then
    APPLY_ARGS+=(--dry-run)
  else
    APPLY_ARGS+=(--live --auto)
  fi
  [ "$ACCEPT_TERMS" -eq 1 ] && APPLY_ARGS+=(--accept-terms)
  [ "$ACCEPT_LEGAL" -eq 1 ] && APPLY_ARGS+=(--accept-legal)

  log "--- apply: $NODE ${APPLY_ARGS[*]}"
  "$NODE" "${APPLY_ARGS[@]}" 2>&1 | tee -a "$LOG"
  APPLY_EXIT=${PIPESTATUS[0]}
  log "browser_apply_exit=$APPLY_EXIT"
fi

# ── 3. Push ─────────────────────────────────────────────────────────────────
if [ "$NO_PUSH" -eq 0 ]; then
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  if [ -n "$BRANCH" ]; then
    for attempt in 1 2 3; do
      git push origin "$BRANCH" 2>&1 | tee -a "$LOG"
      PUSH_EXIT=${PIPESTATUS[0]}
      [ "$PUSH_EXIT" -eq 0 ] && break
      [ "$attempt" -lt 3 ] && sleep "$((attempt * 10))"
    done
    log "push_exit=${PUSH_EXIT:-0}"
  fi
fi

log "=== done: job=$JOB pipeline=$PIPELINE_EXIT apply=$APPLY_EXIT ==="
[ "$PIPELINE_EXIT" -ne 0 ] && exit "$PIPELINE_EXIT"
exit "$APPLY_EXIT"
