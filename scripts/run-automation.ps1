param(
    [switch]$SkipLiveness,
    [switch]$SkipBrowserApply,
    [switch]$NoPush,
    # Suppress the per-run summary email to the candidate inbox.
    [switch]$NoNotify,
    [switch]$StrictNavigation,
    # Required for terms checkboxes, policy attestations and the candidate
    # commitments in profile.application_answers. Those are statements made on
    # the candidate's behalf, so they are opt-in per run and every answer is
    # logged as [commitment]/[attestation].
    [switch]$AcceptTerms,
    # A SEPARATE authorisation class from -AcceptTerms. This one is for
    # arbitration agreements and other binding legal terms, which are
    # materially different from ticking a privacy checkbox. Both are opt-in and
    # every answer is logged as [legal]. Omitting this leaves
    # application_answers.arbitration_agreement untouched, which is the point.
    [switch]$AcceptLegal,
    # After the run, open every job page that G10 parked for human review (no
    # verified recruiter email found) in the default browser. Opt-in because it
    # takes over the operator's screen.
    [switch]$OpenG10Reviews,
    [int]$G10ReviewLimit = 25,
    [switch]$OpenManualQueue,
    [int]$ManualQueueLimit = 15
)

# Native CLIs (Python/Node) may write warnings to stderr without failing.
# Keep command output visible, but decide success from each process exit code.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
$weeklyExit = 0
$browserExit = 0
$pushExit = 0

# The run writes its own log, because how it is invoked decides whether its
# output survives at all. Invoked as `powershell -File run-automation.ps1` with
# the caller's stdout redirected, the child's output is buffered and mostly
# lost - which is how a 16-minute run that completed successfully and moved five
# rows left a ten-line log and looked identical to a hang. Swapping Write-Host
# for Write-Output fixed the common case but not this one.
#
# So the log is produced here rather than captured from outside. Every run gets
# output/run-automation-<timestamp>.log whether it is double-clicked, scheduled,
# or piped, and a failed run can be read after the fact without reproducing it.
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $repo "output"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$runLog = Join-Path $logDir "run-automation-$stamp.log"
$transcriptOn = $false
try {
    Start-Transcript -Path $runLog -Force -ErrorAction Stop | Out-Null
    $transcriptOn = $true
} catch {
    # A transcript is a convenience, never a reason to refuse to run.
    Write-Output "[log] could not start transcript at $runLog - continuing without one"
}

Write-Output "=== PulseOps weekly pipeline ==="
Write-Output "=== log: $runLog ==="
$weeklyArgs = @("apps/weekly-scan/src/pulseops_weekly/main_weekly.py")
if ($SkipLiveness) { $weeklyArgs += "--skip-liveness" }
# -u is not optional here. Python block-buffers stdout when it is not a
# terminal, and this script's output is a pipe or a file, so every print in the
# weekly pipeline sat in a buffer until the process exited. A run that takes
# seven minutes in the liveness phase - which is expected, not a fault - showed
# nothing at all for the whole of it, and was twice killed mid-flight on
# 2026-10-05 by an operator who reasonably read the silence as a hang. The
# transcript below cannot help either: it records what the process writes, and
# the process had written nothing.
& python -u -X utf8 @weeklyArgs
$weeklyExit = $LASTEXITCODE
Write-Output "weekly_exit=$weeklyExit"

if (-not $SkipBrowserApply) {
    Write-Output "=== PulseOps browser apply (live + auto) ==="
    # Operator-approved: most LinkedIn roles are off-site applies that land on
    # the employer's own careers site. Grants exactly one HTTPS host hop, then
    # re-pins. Disable with -StrictNavigation.
    if (-not $StrictNavigation) {
        $env:PULSEOPS_ALLOW_EXTERNAL_APPLY = "1"
    } else {
        Remove-Item Env:\PULSEOPS_ALLOW_EXTERNAL_APPLY -ErrorAction SilentlyContinue
    }
    $applyArgs = @("apps/browser-apply/apply.mjs", "--live", "--headed", "--auto", "--otp-pause")
    if ($AcceptTerms) { $applyArgs += "--accept-terms" }
    if ($AcceptLegal) { $applyArgs += "--accept-legal" }
    & node @applyArgs
    $browserExit = $LASTEXITCODE
    Write-Output "browser_apply_exit=$browserExit"
} else {
    Write-Output "=== Browser apply skipped by switch ==="
}

if (-not $NoNotify) {
    # An unattended run that submitted three applications and stalled on two
    # more was indistinguishable from a run that did nothing. Mail the candidate
    # a summary after every browser-apply stage so the outcome is observable
    # without watching a browser. Reports recorded outcomes only; it never
    # claims an application went out unless the run recorded one, and a mail
    # failure never changes the run's exit code.
    # 2026-10-08: opt-in. The operator asked to stop receiving these. A
    # "PulseOps: N application(s) attempted" mail after every browser-apply
    # stage lands in the same inbox he needs to read for employer replies,
    # and every 15 minutes of summaries is what buries a real rejection.
    #
    # Off unless PULSEOPS_NOTIFY=1 is set, so it cannot return by accident.
    # By hand: python apps/browser-apply/tools/notify_run.py
    if ($env:PULSEOPS_NOTIFY -eq '1') {
        Write-Output "=== Notifying candidate of this run ==="
        & python -u apps/browser-apply/tools/notify_run.py
        Write-Output "notify_exit=$LASTEXITCODE"
    } else {
        Write-Output "=== Run summary mail suppressed (PULSEOPS_NOTIFY=1 enables) ==="
    }
}

if ($OpenManualQueue) {
    # Postings a run could not finish, and which a person CAN finish: the board
    # declined the submission, a captcha needs solving, or the form is filled up
    # to the point where only a Submit click is missing. Read-only - it queries
    # the database and opens links, and drives no browser, so it cannot fill a
    # field, accept a term or click Submit.
    #
    # It reads the reason out of outcomes.stage, which is only populated because
    # persistBrowserResult now writes it. Before that the table was empty and
    # every blocked row looked identical, so the queue listed closed postings
    # from disabled portals with no form behind them.
    Write-Output "=== Opening the manual-apply queue ==="
    & python -u apps/browser-apply/tools/manual_apply_queue.py --limit $ManualQueueLimit
    Write-Output "manual_queue_exit=$LASTEXITCODE"
}

if ($OpenG10Reviews) {
    # G10 parked these listings because it could not find a verified recruiter
    # email. Their Discord cards carry a link nobody has opened yet, so surface
    # the pages in the operator's browser for review. Read-only: it opens links
    # that are already in the database and drives nothing.
    Write-Output "=== Opening G10 review pages ==="
    & node apps/browser-apply/tools/open_g10_reviews.mjs --limit $G10ReviewLimit
    Write-Output "g10_open_exit=$LASTEXITCODE"
}

if (-not $NoPush) {
    Write-Output "=== Pushing current branch ==="
    $branch = (& git branch --show-current).Trim()
    # Retry a transient network failure rather than reporting a failed run.
    # Observed 2026-10-01: a machine-wide DNS outage took out SMTP, the GitHub
    # push and the evaluator in the same run, and
    #   "Could not resolve host: github.com" -> push_exit=128
    # marked the whole run failed when nothing about the code was wrong.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        & git push origin $branch
        $pushExit = $LASTEXITCODE
        if ($pushExit -eq 0) { break }
        if ($attempt -lt 3) {
            $wait = $attempt * 10
            Write-Output "[push-retry] attempt $attempt failed (exit $pushExit); retrying in ${wait}s"
            Start-Sleep -Seconds $wait
        }
    }
    Write-Output "push_exit=$pushExit"
}

Pop-Location
Write-Output "=== weekly=$weeklyExit browser=$browserExit push=$pushExit ==="
# Closed before exiting, or the tail of the run - the part that explains a
# failure - is exactly the part that gets lost.
if ($transcriptOn) {
    try { Stop-Transcript | Out-Null } catch {}
    Write-Output "=== log written: $runLog ==="
}
if ($weeklyExit -ne 0) { exit $weeklyExit }
if ($browserExit -ne 0) { exit $browserExit }
exit $pushExit
