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
    [int]$G10ReviewLimit = 25
)

# Native CLIs (Python/Node) may write warnings to stderr without failing.
# Keep command output visible, but decide success from each process exit code.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
$weeklyExit = 0
$browserExit = 0
$pushExit = 0

Write-Host "=== PulseOps weekly pipeline ==="
$weeklyArgs = @("apps/weekly-scan/src/pulseops_weekly/main_weekly.py")
if ($SkipLiveness) { $weeklyArgs += "--skip-liveness" }
& python -X utf8 @weeklyArgs
$weeklyExit = $LASTEXITCODE
Write-Host "weekly_exit=$weeklyExit"

if (-not $SkipBrowserApply) {
    Write-Host "=== PulseOps browser apply (live + auto) ==="
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
    Write-Host "browser_apply_exit=$browserExit"
} else {
    Write-Host "=== Browser apply skipped by switch ==="
}

if (-not $NoNotify) {
    # An unattended run that submitted three applications and stalled on two
    # more was indistinguishable from a run that did nothing. Mail the candidate
    # a summary after every browser-apply stage so the outcome is observable
    # without watching a browser. Reports recorded outcomes only; it never
    # claims an application went out unless the run recorded one, and a mail
    # failure never changes the run's exit code.
    Write-Host "=== Notifying candidate of this run ==="
    & python apps/browser-apply/tools/notify_run.py
    Write-Host "notify_exit=$LASTEXITCODE"
}

if ($OpenG10Reviews) {
    # G10 parked these listings because it could not find a verified recruiter
    # email. Their Discord cards carry a link nobody has opened yet, so surface
    # the pages in the operator's browser for review. Read-only: it opens links
    # that are already in the database and drives nothing.
    Write-Host "=== Opening G10 review pages ==="
    & node apps/browser-apply/tools/open_g10_reviews.mjs --limit $G10ReviewLimit
    Write-Host "g10_open_exit=$LASTEXITCODE"
}

if (-not $NoPush) {
    Write-Host "=== Pushing current branch ==="
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
            Write-Host "[push-retry] attempt $attempt failed (exit $pushExit); retrying in ${wait}s"
            Start-Sleep -Seconds $wait
        }
    }
    Write-Host "push_exit=$pushExit"
}

Pop-Location
if ($weeklyExit -ne 0) { exit $weeklyExit }
if ($browserExit -ne 0) { exit $browserExit }
exit $pushExit
