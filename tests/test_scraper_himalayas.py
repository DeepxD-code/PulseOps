"""Himalayas feed parsing tests (no network).

The live feed's shape was measured on 2026-11-11: no server-side filtering, 20
jobs per page regardless of `limit`, ~0.75% of postings restricted to India, and
HTML job descriptions. These tests pin what the scraper does with that shape.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_core import scraper as scraper_module  # noqa: E402


def _posting(**overrides):
    now = int(time.time())
    item = {
        "title": "Backend Engineer",
        "companyName": "Example Co",
        "companySlug": "example",
        "locationRestrictions": ["India"],
        "categories": ["Backend-Engineer"],
        "pubDate": now,
        "guid": "https://himalayas.app/companies/example/jobs/backend-engineer",
        "description": "<h3>Role</h3><p>Java &amp; Spring Boot.</p>",
    }
    item.update(overrides)
    return item


def _fake_get(pages, calls=None, boards=None):
    """A safe_get stand-in that serves the feed from `pages` and ATS boards from
    `boards` (keyed by "ats:slug").

    Both the feed and the employer-board probes go through safe_get, and the feed
    queue must not be consumed by a probe - so routing is by URL, and any board
    the test did not declare answers 404 the way a company with no such tenant
    does.
    """
    queue = list(pages)
    boards = boards or {}

    def fake(url, **kwargs):
        if "himalayas.app" not in url:
            for key, payload in boards.items():
                ats, slug = key.split(":", 1)
                if slug in url and (
                    (ats == "lever" and "api.lever.co" in url)
                    or (ats == "ashby" and "api.ashbyhq.com" in url)
                    or (ats == "greenhouse" and "boards-api.greenhouse.io" in url)
                    or (ats == "workable" and "apply.workable.com" in url)
                    or (ats == "smartrecruiters" and "api.smartrecruiters.com" in url)
                ):
                    return SimpleNamespace(status_code=200, content=b"{}", json=lambda: payload)
            return SimpleNamespace(status_code=404, content=b"", json=lambda: {})
        if calls is not None:
            calls.append(kwargs.get("params"))
        payload = queue.pop(0) if queue else {"jobs": [], "nextCursor": ""}
        return SimpleNamespace(status_code=200, content=b"{}", json=lambda: payload)

    return fake


def test_india_and_worldwide_are_kept_and_a_named_foreign_site_is_not(monkeypatch):
    payload = {
        "jobs": [
            _posting(),
            _posting(title="Backend Engineer", locationRestrictions=[], guid="https://himalayas.app/c/a/jobs/b"),
            _posting(title="Backend Engineer", locationRestrictions=["Worldwide"], guid="https://himalayas.app/c/a/jobs/c"),
            _posting(title="Backend Engineer", locationRestrictions=["United States"], guid="https://himalayas.app/c/a/jobs/d"),
            _posting(title="Backend Engineer", locationRestrictions=["Asia"], guid="https://himalayas.app/c/a/jobs/e"),
        ],
        "nextCursor": "",
    }
    calls: list = []
    monkeypatch.setattr(scraper_module, "safe_get", _fake_get([payload], calls))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    assert [job["link"].rsplit("/", 1)[-1] for job in jobs] == ["backend-engineer", "b", "c", "e"]
    assert all(job["source"] == "Himalayas" for job in jobs)
    # The postings' own HTML is flattened before it is stored.
    assert jobs[0]["description"].startswith("Role")
    assert "<" not in jobs[0]["description"] and "&amp;" not in jobs[0]["description"]
    # The location is passed through as the board stated it, so the downstream
    # filter - not this scraper - decides what "Asia" means.
    assert jobs[3]["location_raw"] == "Asia"


def test_a_title_that_does_not_match_the_search_query_is_dropped(monkeypatch):
    payload = {
        "jobs": [
            _posting(title="Backend Engineer"),
            _posting(title="Heart Failure Cardiologist", guid="https://himalayas.app/c/a/jobs/cardio"),
            _posting(title="Account Executive", guid="https://himalayas.app/c/a/jobs/ae"),
        ],
        "nextCursor": "",
    }
    monkeypatch.setattr(scraper_module, "safe_get", _fake_get([payload]))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    assert len(jobs) == 1
    assert jobs[0]["title"] == "Backend Engineer"


def test_postings_older_than_the_age_limit_are_dropped_and_end_the_read(monkeypatch):
    stale = int(time.time()) - 60 * 60 * 24 * 30
    # Every posting on the first page is outside the window, and the feed is
    # newest-first, so the pages after it cannot be inside it either: the second
    # page must never be requested.
    first = {
        "jobs": [
            _posting(pubDate=stale, guid="https://himalayas.app/c/a/jobs/old"),
            _posting(title="Backend Engineer", pubDate=stale, guid="https://himalayas.app/c/a/jobs/older"),
        ],
        "nextCursor": "cursor-2",
    }
    second = {"jobs": [_posting(title="Backend Engineer", guid="https://himalayas.app/c/a/jobs/later")], "nextCursor": ""}
    calls: list = []
    monkeypatch.setattr(scraper_module, "safe_get", _fake_get([first, second], calls))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    assert jobs == []
    assert len(calls) == 1


def test_a_page_with_one_fresh_posting_keeps_the_read_going(monkeypatch):
    stale = int(time.time()) - 60 * 60 * 24 * 30
    first = {
        "jobs": [
            _posting(),
            _posting(title="Backend Engineer", pubDate=stale, guid="https://himalayas.app/c/a/jobs/old"),
        ],
        "nextCursor": "cursor-2",
    }
    second = {"jobs": [_posting(guid="https://himalayas.app/c/a/jobs/two")], "nextCursor": ""}
    calls: list = []
    monkeypatch.setattr(scraper_module, "safe_get", _fake_get([first, second], calls))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    # The stale posting itself is still dropped; the old one on its own does not
    # end the read while the page also carries something fresh.
    assert [job["link"] for job in jobs] == [
        "https://himalayas.app/companies/example/jobs/backend-engineer",
        "https://himalayas.app/c/a/jobs/two",
    ]
    assert len(calls) == 2


def test_the_feed_is_paged_with_its_cursor(monkeypatch):
    page_one = {"jobs": [_posting()], "nextCursor": "abc"}
    page_two = {"jobs": [_posting(guid="https://himalayas.app/c/a/jobs/two")], "nextCursor": ""}
    calls: list = []
    monkeypatch.setattr(scraper_module, "safe_get", _fake_get([page_one, page_two], calls))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    assert len(jobs) == 2
    assert calls[0].get("cursor") is None
    assert calls[1].get("cursor") == "abc"


def test_a_non_200_answer_is_a_typed_source_failure(monkeypatch):
    def fake(url, **kwargs):
        return SimpleNamespace(status_code=403, content=b"nope", text="Just a moment...")

    monkeypatch.setattr(scraper_module, "safe_get", fake)

    with pytest.raises(scraper_module.HimalayasError):
        scraper_module.PulseOpsScraper().fetch_himalayas()



# -- Employer-board resolution ------------------------------------------------
#
# Himalayas mediates the application itself (`applicationLink` is himalayas.app
# on every posting measured) and refuses automated browsers, so the employer's
# own board is the only reachable application surface. Measured 2026-11-11 over
# the 13 sourced rows: 4 companies had a probeable board, 1 carried the role.

LISTING = "https://himalayas.app/companies/example/jobs/backend-engineer"


def _boards(monkeypatch, mapping):
    """Route safe_get to canned ATS boards; anything else answers 404."""
    def fake(url, **kwargs):
        for key, payload in mapping.items():
            ats, slug = key.split(":", 1)
            if slug not in url:
                continue
            if (ats == "lever" and "api.lever.co" in url) \
                    or (ats == "ashby" and "api.ashbyhq.com" in url) \
                    or (ats == "greenhouse" and "boards-api.greenhouse.io" in url) \
                    or (ats == "workable" and "apply.workable.com" in url) \
                    or (ats == "smartrecruiters" and "api.smartrecruiters.com" in url):
                return SimpleNamespace(status_code=200, content=b"{}", json=lambda: payload)
        return SimpleNamespace(status_code=404, content=b"", json=lambda: {})

    monkeypatch.setattr(scraper_module, "safe_get", fake)


def test_an_employer_board_that_carries_the_role_yields_its_own_posting(monkeypatch):
    _boards(monkeypatch, {
        "lever:example": [
            {"text": "Account Executive", "hostedUrl": "https://jobs.lever.co/example/other"},
            {"text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/example/1"},
        ]
    })

    assert scraper_module.resolve_himalayas_employer_link(LISTING, "Backend Engineer") == \
        "https://jobs.lever.co/example/1"


def test_a_near_title_is_never_treated_as_the_same_role(monkeypatch):
    # Binance's own board carried "Software Engineer - Blockchain Security
    # (Full-stack)" for a listing of "Software Engineer - Blockchain Security". A
    # contains-match would submit an application to a scope nobody read.
    _boards(monkeypatch, {
        "greenhouse:example": [{
            "title": "Software Engineer - Blockchain Security (Full-stack)",
            "absolute_url": "https://job-boards.greenhouse.io/example/jobs/1",
        }]
    })

    assert scraper_module.resolve_himalayas_employer_link(
        LISTING, "Software Engineer - Blockchain Security"
    ) == ""


def test_a_link_that_is_not_a_himalayas_listing_is_left_alone(monkeypatch):
    called = []

    def fake(url, **kwargs):
        called.append(url)
        return SimpleNamespace(status_code=404, content=b"", json=lambda: {})

    monkeypatch.setattr(scraper_module, "safe_get", fake)

    assert scraper_module.resolve_himalayas_employer_link("https://jobs.lever.co/example/1", "Backend Engineer") == ""
    # Already-resolved rows and other boards pass through without a probe.
    assert called == []


def test_a_company_slug_is_tried_one_suffix_away():
    candidates = scraper_module._board_slug_candidates("portainer-io")
    assert candidates[0] == "portainer-io"
    assert "portainer" in candidates
    assert scraper_module._board_slug_candidates("mercor") == ["mercor"]


def test_a_failed_probe_returns_nothing_rather_than_raising(monkeypatch):
    def fake(url, **kwargs):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(scraper_module, "safe_get", fake)

    assert scraper_module.resolve_himalayas_employer_link(LISTING, "Backend Engineer") == ""


def test_the_probe_stops_at_the_first_board_that_answers(monkeypatch):
    # Each unanswered ATS costs a timeout, and a company runs one board, so the
    # remaining four are not worth asking.
    asked = []

    def fake(url, **kwargs):
        asked.append(url)
        if "api.lever.co" in url:
            return SimpleNamespace(
                status_code=200,
                content=b"{}",
                json=lambda: [{"text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/example/1"}],
            )
        return SimpleNamespace(status_code=404, content=b"", json=lambda: {})

    monkeypatch.setattr(scraper_module, "safe_get", fake)
    scraper_module.resolve_himalayas_employer_link(LISTING, "Backend Engineer")

    assert any("api.lever.co" in u for u in asked)
    assert len(asked) == 2  # ashby (404), then lever (hit) - nothing after.

# -- Feed throttling ---------------------------------------------------------
#
# Measured 2026-11-11: a 60-page run was answered with HTTP 429 "Rate limit
# reached" and the whole source reported zero postings, while a single request a
# few seconds later succeeded. Losing a run to a burst throttle is not a real
# outage, so a 429 is waited out.

def test_a_throttled_page_is_retried_and_the_run_continues(monkeypatch):
    payload = {"jobs": [_posting()], "nextCursor": ""}
    calls = []

    def fake(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            return SimpleNamespace(status_code=429, content=b"{}", text="Rate limit reached")
        return SimpleNamespace(status_code=200, content=b"{}", json=lambda: payload)

    monkeypatch.setattr(scraper_module, "safe_get", fake)
    # The waits are read from the module so a test never sleeps for real.
    monkeypatch.setattr(scraper_module, "_HIMALAYAS_RETRY_WAITS", (0,))

    jobs = scraper_module.PulseOpsScraper().fetch_himalayas()

    assert len(calls) == 2
    assert len(jobs) == 1


def test_a_throttle_that_never_clears_is_a_typed_failure(monkeypatch):
    def fake(url, **kwargs):
        return SimpleNamespace(status_code=429, content=b"{}", text="Rate limit reached")

    monkeypatch.setattr(scraper_module, "safe_get", fake)
    monkeypatch.setattr(scraper_module, "_HIMALAYAS_RETRY_WAITS", (0, 0))

    with pytest.raises(scraper_module.HimalayasError) as caught:
        scraper_module.PulseOpsScraper().fetch_himalayas()
    assert "429" in str(caught.value)
