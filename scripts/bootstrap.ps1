$ErrorActionPreference = "Stop"
function Assert-LastExitCode([string]$l){ if ($LASTEXITCODE -ne 0) { throw "$l failed." } }
python -m pip install --upgrade pip; Assert-LastExitCode "pip"
python -m pip install -r requirements.txt; Assert-LastExitCode "requirements"
foreach ($p in Get-ChildItem packages,apps -Directory) { if (Test-Path "$($p.FullName)/pyproject.toml") { python -m pip install -e $p.FullName; Assert-LastExitCode "install $($p.Name)" } }
