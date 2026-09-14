# portal/startup_apply.ps1 — Auto-run on Windows startup, 30 min, background
# Add to Startup: shell:startup → paste shortcut to this script, or run Register-ScheduledTask below

$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\asus\AppData\Local\Temp\opencode\PluseOPS2"
Set-Location $root

# Run apply headless, auto, with timeout 30 minutes (1800s)
$job = Start-Job -ScriptBlock {
  param($root)
  Set-Location $root
  # Use --auto (no prompt) + headless (no window) for background
  node portal/apply.mjs --live --auto 2>&1 | Out-File -FilePath "$root\logs\startup_apply.log" -Append
} -ArgumentList $root

# Wait 30 minutes then stop
Wait-Job $job -Timeout 1800 | Out-Null
if ($job.State -eq "Running") {
  Stop-Job $job
  Add-Content "$root\logs\startup_apply.log" "[$(Get-Date)] Stopped after 30 min timeout"
}
Remove-Job $job -Force
