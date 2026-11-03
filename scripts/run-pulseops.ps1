#requires -Version 5.1
<#
.SYNOPSIS
    Unattended PulseOps runner - daily or weekly, sourcing through to live apply.

.DESCRIPTION
    One entry point for Task Scheduler, cron and a human double-click. It exists
    because the previous runners each did half the job:

      run-auto.bat           hardcoded E:\Potential-gold\PluseOPS, which no longer
                             exists, and keyed live mode off PULSEOPS_APPLY_LIVE,
                             a variable apply.mjs never reads.
      run-automation.ps1     weekly only, no lock, and resolves `python`/`node`
                             from PATH - which a scheduled task does not inherit.

    What this does:

      -Job daily    daily pipeline (evaluate, tailor, queue) then live browser apply
      -Job weekly   weekly portal scan + weekly pipeline, then live browser apply
      -DryRun       run both phases but leave the browser in dry-run (fill, no submit)
      -SkipApply    pipeline only
      -NoPush       do not commit/push the run's artefacts

    Concurrency: a single lock file. Two scheduled runs overlapping (a slow
    browser-apply batch and the next 18:00 tick) is how a posting gets two
    submissions, so the second one exits immediately instead of racing.

    Every run writes output/run-<job>-<timestamp>.log. A scheduled run that
    fails has no console to read, so the log is the only evidence.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-pulseops.ps1 -Job daily

.EXAMPLE
    .\scripts\run-pulseops.ps1 -Job weekly -DryRun -NoPush
#>
param(
    [ValidateSet("daily", "weekly")]
    [string]$Job = "daily",

    # Fill forms and screenshot, but never click the final Submit.
    [switch]$DryRun,

    [switch]$SkipApply,

    [switch]$SkipLiveness,

    [switch]$NoPush,

    # Required for terms checkboxes and policy attestations. Both are statements
    # made on the candidate's behalf, so they stay explicit rather than implied by
    # "unattended".
    [switch]$AcceptTerms,

    [switch]$AcceptLegal,

    [switch]$StrictNavigation
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Console and file both carry UTF-8. Without this the Python side printed
# "Querying gemini..." with a mangled ellipsis and every box rule in its output
# came through as "?\"", which is what made the logs unreadable.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = "utf-8"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $repo "output"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$logPath = Join-Path $outDir "run-$Job-$stamp.log"

function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $message
    Write-Output $line
    Add-Content -Path $logPath -Value $line -Encoding utf8
}

# Run a native command, echo it live, and append it to the log as UTF-8.
#
# Tee-Object -Append writes UTF-16LE on PowerShell 5.1, so the log ended up with
# UTF-8 lines from Write-Log alternating with UTF-16 lines from Tee - readable
# only as spaced-out characters, which defeats the purpose of having a log at
# all. One encoding, one writer.
function Invoke-Logged([string]$exe, [string[]]$argv) {
    & $exe @argv 2>&1 | ForEach-Object {
        $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
        Write-Host $text
        Add-Content -Path $logPath -Value $text -Encoding utf8
    }
    return $LASTEXITCODE
}

# -- Single-instance lock ----------------------------------------------------
$lockPath = Join-Path $outDir ".pulseops.lock"
try {
    $lock = [System.IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
    Write-Output "[lock] another PulseOps run holds $lockPath - exiting without doing anything"
    exit 0
}
try {
    $lock.SetLength(0)
    $payload = [Text.Encoding]::UTF8.GetBytes("pid=$PID job=$Job started=$stamp")
    $lock.Write($payload, 0, $payload.Length)
    $lock.Flush()

    # -- Binaries ------------------------------------------------------------
    # Resolved absolutely: a Task Scheduler action starts with the machine PATH,
    # not the user's shell PATH, and "python" is not on it there.
    function Resolve-Tool([string]$name, [string[]]$fallbacks) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { return $cmd.Source }
        foreach ($candidate in $fallbacks) {
            if (Test-Path $candidate) { return $candidate }
        }
        return $null
    }

    # The interpreter must be the one the packages were installed into. On this
    # machine `python` on PATH is 3.14 while the editable installs live in 3.12,
    # so `python -m pulseops_weekly.main_weekly` dies with ModuleNotFoundError -
    # a failure that is invisible until the first scheduled run and then repeats
    # every night. Probe each candidate for the packages instead of trusting PATH.
    $pythonCandidates = @()
    $pathPython = Resolve-Tool "python" @()
    if ($pathPython) { $pythonCandidates += $pathPython }
    $extraPythons = @(
        "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python314\python.exe",
        (Resolve-Tool "python3" @())
    ) | Where-Object { $_ }
    $pythonCandidates += $extraPythons

    $python = $null
    $fallbackPython = $null
    foreach ($candidate in ($pythonCandidates | Select-Object -Unique)) {
        if (-not (Test-Path $candidate)) { continue }
        if (-not $fallbackPython) { $fallbackPython = $candidate }
        & $candidate -c "import pulseops_pipeline, pulseops_weekly, pulseops_eval, pulseops_store" 2>$null
        if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
    }
    if (-not $python) {
        Write-Log "[warn] no interpreter has pulseops_pipeline+pulseops_weekly installed; falling back to $fallbackPython"
        $python = $fallbackPython
    }

    $node = Resolve-Tool "node" @("C:\Program Files\nodejs\node.exe")

    if (-not $python) { Write-Log "[fatal] python not found"; exit 127 }
    if (-not $node -and -not $SkipApply) { Write-Log "[fatal] node not found"; exit 127 }

    Write-Log "=== PulseOps run: job=$Job dryRun=$($DryRun.IsPresent) log=$logPath ==="
    Write-Log "python=$python"
    if ($node) { Write-Log "node=$node" }

    # -- 1. Pipeline ---------------------------------------------------------
    if ($Job -eq "weekly") {
        $moduleArgs = @("-m", "pulseops_weekly.main_weekly")
        if ($SkipLiveness) { $moduleArgs += "--skip-liveness" }
    } else {
        $moduleArgs = @("-m", "pulseops_pipeline.main")
    }

    # -u: Python block-buffers stdout into a pipe, so an eight-minute liveness
    # phase produced no log at all and looked like a hang.
    Write-Log "--- pipeline: $python -u -X utf8 $($moduleArgs -join ' ')"
    $pipelineExit = Invoke-Logged $python (@("-u", "-X", "utf8") + $moduleArgs)
    Write-Log "pipeline_exit=$pipelineExit"

    # -- 2. Live browser apply -----------------------------------------------
    $applyExit = 0
    if ($SkipApply) {
        Write-Log "--- browser apply skipped by -SkipApply"
    } elseif (-not $node) {
        Write-Log "--- browser apply skipped: node missing"
    } else {
        if (-not $StrictNavigation) {
            # Most India-board roles are off-site applies that land on the
            # employer's own careers site. Grants exactly one HTTPS host hop.
            $env:PULSEOPS_ALLOW_EXTERNAL_APPLY = "1"
        } else {
            Remove-Item Env:\PULSEOPS_ALLOW_EXTERNAL_APPLY -ErrorAction SilentlyContinue
        }

        # --edge: a persistent msedge profile. Without it every unattended run
        # starts a clean chromium, so each India board is a fresh login wall and
        # Cloudflare challenge - the run "succeeds" with a batch of
        # needs-review rows and no submissions. The profile is shared with the
        # scan so one operator sign-in covers both phases.
        $edgeProfile = Join-Path $repo ".edge-profile-naukri"
        if (-not (Test-Path $edgeProfile)) { $edgeProfile = Join-Path $repo ".edge-profile" }
        $env:PULSEOPS_EDGE_PROFILE = $edgeProfile

        $applyArgs = @("apps/browser-apply/apply.mjs", "--edge", "--headed", "--otp-pause")
        if ($DryRun) {
            $applyArgs += "--dry-run"
        } else {
            $applyArgs += @("--live", "--auto")
        }
        if ($AcceptTerms) { $applyArgs += "--accept-terms" }
        if ($AcceptLegal) { $applyArgs += "--accept-legal" }

        Write-Log "--- apply: $node $($applyArgs -join ' ')"
        $applyExit = Invoke-Logged $node $applyArgs
        Write-Log "browser_apply_exit=$applyExit"
    }

    # -- 3. Push -------------------------------------------------------------
    $pushExit = 0
    if (-not $NoPush) {
        $branch = (& git branch --show-current).Trim()
        if ($branch) {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                $pushExit = Invoke-Logged "git" @("push", "origin", $branch)
                if ($pushExit -eq 0) { break }
                if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt * 10) }
            }
            Write-Log "push_exit=$pushExit"
        }
    }

    Write-Log "=== done: job=$Job pipeline=$pipelineExit apply=$applyExit push=$pushExit ==="
    if ($pipelineExit -ne 0) { exit $pipelineExit }
    if ($applyExit -ne 0) { exit $applyExit }
    exit 0
} finally {
    $lock.Dispose()
}
