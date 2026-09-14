#!/usr/bin/env bash
set -euo pipefail
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt 2>/dev/null || true
for pkg in packages/* apps/*; do if [ -f "$pkg/pyproject.toml" ]; then python -m pip install -e "$pkg"; fi; done
npm install 2>/dev/null || true
echo Bootstrap complete.
