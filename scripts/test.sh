#!/usr/bin/env bash
set -euo pipefail
python -m pytest apps/*/tests packages/*/tests tests -q
