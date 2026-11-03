#requires -Version 5.1
<#
.SYNOPSIS
    Register (or remove) the Windows scheduled tasks that run PulseOps unattended.

.DESCRIPTION
    Creates two tasks, both pointing at scripts\run-pulseops.ps1:

      PulseOps Daily    09:00 and 18:00 every day
      PulseOps Weekly   Sunday 08:00

    Design notes:

      - LogonType Interactive, not a service account. The Naukri step drives a
        real Edge window with the candidate's saved session; a non-interactive
        session has no desktop to open it on.
      - RunLevel Limited. Nothing here needs admin, and prompting for elevation
        would silently prevent the task from ever running.
      - MultipleInstances IgnoreNew plus the runner's own lock file: a slow
        browser-apply batch must not overlap the next tick.
      - StartWhenAvailable, so a missed 09:00 run (machine asleep) still happens
        instead of being skipped for the day.

    Terms and legal attestations are included by default, because an unattended
    application that stops at the first required checkbox does no applying. Pass
    -SkipAttestations to leave them unticked.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Remove
#>
param(
    [switch]$Remove,
    [string]$DailyTimes = "09:00,18:00",
    [string]$WeeklyTime = "08:00",
    # Leave application terms / legal attestations unticked (the run will stall
    # at any board that requires them).
    [switch]$SkipAttestations
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repo "scripts\run-pulseops.ps1"

if (-not (Test-Path $runner)) {
    Write-Error "runner not found: $runner"
    exit 1
}

$taskNames = @("PulseOps Daily", "PulseOps Weekly")

if ($Remove) {
    foreach ($name in $taskNames) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Output "[removed] $name"
        } else {
            Write-Output "[skip] $name not registered"
        }
    }
    exit 0
}

$attestations = @()
if (-not $SkipAttestations) { $attestations = @("-AcceptTerms", "-AcceptLegal") }

function New-PulseOpsTask {
    param(
        [string]$Name,
        [string]$Job,
        [object[]]$Triggers
    )

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", "`"$runner`"",
        "-Job", $Job,
        "-NoPush"
    ) + $attestations

    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($arguments -join " ") -WorkingDirectory $repo
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 4)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers -Settings $settings -Principal $principal -Description "PulseOps unattended $Job run" | Out-Null
    Write-Output "[registered] $Name -> $runner -Job $Job $($attestations -join ' ')"
}

$dailyTriggers = @()
foreach ($time in ($DailyTimes -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $dailyTriggers += New-ScheduledTaskTrigger -Daily -At $time
}
New-PulseOpsTask -Name "PulseOps Daily" -Job "daily" -Triggers $dailyTriggers

$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $WeeklyTime
New-PulseOpsTask -Name "PulseOps Weekly" -Job "weekly" -Triggers @($weeklyTrigger)

Write-Output ""
Write-Output "Verify with:  Get-ScheduledTask -TaskName 'PulseOps*' | Format-Table TaskName,State"
Write-Output "Run now with: Start-ScheduledTask -TaskName 'PulseOps Daily'"
