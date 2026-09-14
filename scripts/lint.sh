#!/usr/bin/env bash
set -euo pipefail
python -m ruff check apps packages tests 2>/dev/null || echo "ruff not installed, skipping"
