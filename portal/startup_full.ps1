# portal/startup_full.ps1 — Visible 30m startup: scan → filter → apply one-by-one (your request)
$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\asus\AppData\Local\Temp\opencode\PluseOPS2"
Set-Location $root
# Ensure storageState exists (from save_sessions.mjs)
if (-not (Test-Path "portal\storageState.json")) {
  Write-Host "No storageState.json — run node portal/save_sessions.mjs once to save logins"
  exit 0
}
# 1. Scan live portals one-by-one (Naukri, Indeed, etc. — filtered already in scan.mjs hard filter)
Write-Host "[1/2] Scanning portals live..."
node portal/scan.mjs 2>&1 | Tee-Object -FilePath "$root\logs\startup_scan.log" -Append
# 2. Apply live headed one-by-one (fills + uploads + submits, visible Edge)
Write-Host "[2/2] Auto-applying to scanned jobs (visible browser, 30m)..."
$job = Start-Job -ScriptBlock {
  param($root)
  Set-Location $root
  # --headed + --live --auto : opens Edge, navigates each job link, filters, fills, submits
  node portal/apply.mjs --live --headed --auto 2>&1 | Out-File -FilePath "$root\logs\startup_apply.log" -Append
} -ArgumentList $root
Wait-Job $job -Timeout 1800 | Out-Null
if ($job.State -eq "Running") {
  Stop-Job $job
  Add-Content "$root\logs\startup_apply.log" "[$(Get-Date)] 30m timeout"
}
Remove-Job $job -Force
Write-Host "Done — check logs\startup_apply.log and Discord ✅ Applied"
