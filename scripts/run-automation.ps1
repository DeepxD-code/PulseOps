param(
    [switch]$SkipLiveness,
    [switch]$SkipBrowserApply,
    [switch]$NoPush,
    [switch]$StrictNavigation
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
    & node apps/browser-apply/apply.mjs --live --headed --auto
    $browserExit = $LASTEXITCODE
    Write-Host "browser_apply_exit=$browserExit"
} else {
    Write-Host "=== Browser apply skipped by switch ==="
}

if (-not $NoPush) {
    Write-Host "=== Pushing current branch ==="
    $branch = (& git branch --show-current).Trim()
    & git push origin $branch
    $pushExit = $LASTEXITCODE
    Write-Host "push_exit=$pushExit"
}

Pop-Location
if ($weeklyExit -ne 0) { exit $weeklyExit }
if ($browserExit -ne 0) { exit $browserExit }
exit $pushExit
