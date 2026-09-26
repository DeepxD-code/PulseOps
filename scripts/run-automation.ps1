param(
    [switch]$SkipLiveness,
    [switch]$SkipBrowserApply,
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"
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
