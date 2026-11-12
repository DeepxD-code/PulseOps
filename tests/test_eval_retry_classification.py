"""Regression tests for the evaluator's retry classification.

Both predicates gate whether a failed evaluation is retried or thrown away, and
a silently-wrong predicate is worse than none: a first version matched the
literal string "JSON" in lower-cased input while the real message says "JSON",
so it returned False for every failure it was written to catch and the retry
path never ran. These tests use the verbatim strings from a 141-role run that
lost 16 jobs to truncated JSON and 8 to a DNS blip.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-eval" / "src"))

from pulseops_eval.analyzer import (  # noqa: E402
    _is_daily_quota,
    _is_malformed_json,
    _is_server_unavailable,
    _is_transient_network,
)


@pytest.mark.parametrize("message", [
    "Expecting ',' delimiter: line 61 column 6 (char 6503)",
    "Expecting ',' delimiter: line 65 column 6 (char 7063)",
    "Expecting property name enclosed in double quotes: line 36 column 3 (char 1856)",
    "Expecting property name enclosed in double quotes: line 39 column 3 (char 3280)",
    "Expecting value: line 1 column 1 (char 0)",
    "Expecting ':' delimiter: line 9 column 2 (char 200)",
    "Unterminated string starting at: line 5 column 3 (char 300)",
    "Extra data: line 2 column 1 (char 44)",
])
def test_truncated_json_is_retried(message):
    assert _is_malformed_json(message) is True


@pytest.mark.parametrize("message", [
    "[Errno 11001] getaddrinfo failed",
    "[WinError 10053] An established connection was aborted by your host",
    "[WinError 10054] An existing connection was forcibly closed",
    "Connection reset by peer",
    "connection refused",
])
def test_transient_network_is_retried(message):
    assert _is_transient_network(message) is True


@pytest.mark.parametrize("message", [
    "429 rate limit exceeded",
    "RESOURCE_EXHAUSTED",
    "API key not valid",
    "PERMISSION_DENIED",
    "",
])
def test_real_errors_are_not_mistaken_for_retryable_transients(message):
    # A quota or auth error must never be retried by this path: retrying a dead
    # key just burns the run's wall clock, and mislabelling a daily quota as
    # transient previously disabled the whole engine for a job.
    assert _is_malformed_json(message) is False
    assert _is_transient_network(message) is False


@pytest.mark.parametrize("message", [
    # Verbatim from #1137 Viaduct (2026-11-12), which lost the application because
    # the outreach-modal drafter had no second attempt.
    ("503 UNAVAILABLE. {'error': {'code': 503, 'message': 'This model is currently "
     "experiencing high demand. Spikes in demand are usually temporary. Please try again later.', "
     "'status': 'UNAVAILABLE'}}"),
    "500 INTERNAL. An internal error has occurred.",
    "502 Bad Gateway",
    "504 Deadline Exceeded: the server timed out",
    "The model is overloaded, please try again",
])
def test_a_server_side_outage_is_retried(message):
    assert _is_server_unavailable(message) is True


@pytest.mark.parametrize("message", [
    "429 rate limit exceeded",
    "API key not valid",
    "PERMISSION_DENIED",
    "Expecting ',' delimiter: line 61 column 6",
    "connection refused",
    "",
])
def test_a_client_error_is_not_called_a_server_outage(message):
    # Only a 5xx that says so. A 429 is handled on its own branch (it may mean a
    # daily quota, which must disable the engine rather than be retried), and an
    # auth failure must never be looped over.
    assert _is_server_unavailable(message) is False


def test_daily_quota_is_not_treated_as_per_minute():
    # Wording taken from the detector itself. A per-minute 429 that reads as
    # daily would disable the engine for the rest of the run, which is how a
    # 43-job run was zeroed on 2026-09-21.
    assert _is_daily_quota("Quota exceeded: 1500 requests per day") is True
    assert _is_daily_quota("You have hit your daily limit for this model") is True
    assert _is_daily_quota("429 ... quotaId PerMinute, retry in 12s") is False
    assert _is_daily_quota("429 rate limit exceeded") is False
