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
        "locationRestrictions": ["India"],
        "categories": ["Backend-Engineer"],
        "pubDate": now,
        "guid": "https://himalayas.app/companies/example/jobs/backend-engineer",
        "description": "<h3>Role</h3><p>Java &amp; Spring Boot.</p>",
    }
    item.update(overrides)
    return item


def _fake_get(pages, calls=None):
    """A safe_get stand-in that serves one page per call, then stops paginating."""
    queue = list(pages)

    def fake(url, **kwargs):
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
