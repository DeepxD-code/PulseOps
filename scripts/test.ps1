$ErrorActionPreference = "Stop"

# "tests" is the only test directory in this repo. The previous invocation also
# listed apps/*/tests and packages/*/tests, but PowerShell does NOT expand
# wildcards handed to native commands, so those reached pytest as literal
# paths and it aborted with "file or directory not found" before collecting a
# single test. Drop the non-existent globs so the suite actually runs.

# The interpreter must be the one the packages and pytest were installed into.
# `python` on PATH here is 3.14 while the editable installs (and pytest) live in
# 3.12, so the hardcoded `python -m pytest` failed with "No module named pytest"
# before collecting anything. Probe each candidate instead of trusting PATH.
function Resolve-PytestPython {
    $candidates = @()
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath -and $onPath.Source) { $candidates += $onPath.Source }
    $candidates += @(
        "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python314\python.exe"
    )
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $candidate)) { continue }
        # A missing module writes to stderr, and a native command's stderr is an
        # error record - with $ErrorActionPreference = "Stop" that terminated the
        # script on the FIRST candidate (python 3.14, which has no pytest) before
        # the working interpreter was ever probed.
        $previous = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $candidate -c "import pytest, pulseops_eval, pulseops_store" 2>$null
        $ok = $LASTEXITCODE -eq 0
        $ErrorActionPreference = $previous
        if ($ok) { return $candidate }
    }
    return $null
}

$python = Resolve-PytestPython
if (-not $python) {
    throw "No interpreter with pytest and the PulseOps packages installed. Install with: `"C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe`" -m pip install -e packages/pulse-eval -e packages/pulse-store pytest"
}

& $python -m pytest tests -q
if ($LASTEXITCODE -ne 0) { throw "pytest failed." }

# The guardrail suites under tests/*.test.mjs run on the built-in node test
# runner and import nothing from node_modules, so no install step is needed.
# Expand the glob here: PowerShell does NOT wildcard-expand arguments passed
# to native commands, so the literal pattern would reach node unexpanded and
# only resolve on node >= 21.
$nodeTests = @(Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { $_.FullName })
if ($nodeTests.Count -eq 0) { throw "no node tests found under tests/." }
node --test $nodeTests
if ($LASTEXITCODE -ne 0) { throw "node tests failed." }
