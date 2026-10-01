#!/usr/bin/env bash
set -euo pipefail
# "tests" is the only test directory in this repo. The previous invocation also
# listed apps/*/tests and packages/*/tests, which do not exist; without nullglob
# bash passed them through literally and pytest aborted with
# "file or directory not found" before collecting a single test.
python -m pytest tests -q
# The guardrail suites under tests/*.test.mjs run on the built-in node test
# runner and import nothing from node_modules, so no install step is needed.
node --test tests/*.test.mjs
