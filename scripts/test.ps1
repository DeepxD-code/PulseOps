$ErrorActionPreference = "Stop"
# "tests" is the only test directory in this repo. The previous invocation also
# listed apps/*/tests and packages/*/tests, but PowerShell does NOT expand
# wildcards handed to native commands, so those reached pytest as literal
# paths and it aborted with "file or directory not found" before collecting a
# single test. Drop the non-existent globs so the suite actually runs.
python -m pytest tests -q
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
