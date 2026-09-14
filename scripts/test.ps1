$ErrorActionPreference = "Stop"
python -m pytest apps/*/tests packages/*/tests tests -q
if ($LASTEXITCODE -ne 0) { throw "pytest failed." }
