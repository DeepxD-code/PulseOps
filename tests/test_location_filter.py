"""Location eligibility: a named foreign site is a rejection, not missing data.

Measured 2026-11-03: 548 of 601 pending rows carried no India location signal,
because the Wellfound scraper never captured the place. The filter's
"unknown -> possible remote" rule then queued them, and the boards themselves
refused every one ("not accepting applications from your current location",
submit button disabled). These tests pin the two halves of that fix: the place
is now read off the card, and a place that is not India is dropped before it can
cost a browser visit.
"""
from __future__ import annotations

from pulseops_eval.location_filter import filter_by_location
from pulseops_eval import location_filter as location_filter_module

CONFIG = {
    "preferred_cities": ["Bangalore", "Hyderabad", "Pune", "Chennai", "Remote"],
    "remote_preference": True,
}


def _job(**kwargs):
    base = {"title": "Backend Engineer", "description": "", "location_raw": ""}
    base.update(kwargs)
    return base


def test_named_us_site_is_rejected():
    kept = filter_by_location([_job(location_raw="New York")], CONFIG)
    assert kept == []


def test_remote_but_us_only_is_rejected():
    # "Remote" alone would pass; naming the country is what disqualifies it.
    kept = filter_by_location([_job(location_raw="Remote - United States")], CONFIG)
    assert kept == []


def test_us_remote_phrase_from_a_card_is_rejected():
    kept = filter_by_location([_job(location_raw="US Remote")], CONFIG)
    assert kept == []


def test_india_city_still_passes():
    kept = filter_by_location([_job(location_raw="In office Bengaluru")], CONFIG)
    assert len(kept) == 1
    assert kept[0]["location_resolved"] in {"bangalore", "india"}


def test_india_beats_remote_keyword():
    kept = filter_by_location([_job(location_raw="Hybrid - Hyderabad")], CONFIG)
    assert len(kept) == 1
    assert kept[0]["location_resolved"] in {"hyderabad", "india"}


def test_bare_remote_still_passes():
    kept = filter_by_location([_job(location_raw="Remote")], CONFIG)
    assert len(kept) == 1
    assert kept[0]["location_resolved"] == "remote"


def test_unknown_location_still_passes_as_possible_remote():
    kept = filter_by_location([_job(location_raw="")], CONFIG)
    assert len(kept) == 1
    assert kept[0]["location_resolved"] == "unknown/possible-remote"


def test_foreign_site_inside_the_description_is_rejected_too():
    # The filter falls back to the description when location_raw is empty, so
    # the same rule has to apply there.
    kept = filter_by_location(
        [_job(location_raw="", description="Senior Backend Engineer, Austin, Texas teams")],
        CONFIG,
    )
    assert kept == []


def test_the_scrapers_own_provenance_line_is_not_a_location():
    # Cards that carry no location are stored with "Salary: not stated Source:
    # Wellfound India (Backend). Card text: ..." in the description. Reading that
    # as the employer's location made 109 of 292 queued rows look India-located
    # when the board had said nothing, which is how rows that only ever refuse
    # this candidate's location stayed in the apply queue.
    job = {
        "location_raw": "",
        "description": "Salary: not stated Source: Wellfound India (Backend). Card text: Backend Engineer",
    }
    assert location_filter_module._resolve_location(job, []) == ""


def test_a_real_description_still_names_the_place():
    foreign = {"location_raw": "", "description": "Location: San Francisco, CA; Seattle, WA. We build robots."}
    assert location_filter_module._resolve_location(foreign, []) == "foreign"

    india = {"location_raw": "", "description": "Location: Bengaluru, India. Card text is not used here."}
    assert location_filter_module._resolve_location(india, []) == "india"


def test_prose_about_india_after_the_provenance_line_still_counts():
    job = {
        "location_raw": "",
        "description": "Salary: not stated Source: Wellfound India. Card text: Engineer. Our team is based in Pune.",
    }
    assert location_filter_module._resolve_location(job, []) == "india"
