"""Focused safety tests for the G2/G10 and G10-review paths."""

from __future__ import annotations

import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OPEN_WINDOW = {
    "company_cooldown_days": 0,
    "daily_send_cap": 10,
    "domain_daily_limit": 10,
    "send_window_start": "00:00",
    "send_window_end": "23:59",
    "send_timezone": "Asia/Kolkata",
    "min_send_gap_minutes": 0,
}


def _public_dns(monkeypatch):
    """Mock DNS so URL-policy tests never consult the host resolver."""
    from pulseops_core import scraper as scraper_policy

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("93.184.216.34", int(port or 443)),
            )
        ]

    monkeypatch.setattr(scraper_policy.socket, "getaddrinfo", fake_getaddrinfo)


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    """Use an isolated SQLite file for tests that exercise persistence."""
    from pulseops_store import db_manager as db

    old_path = db.DB_PATH
    db.DB_PATH = tmp_path / "pulseops-test.db"
    db.init_db()
    try:
        yield db
    finally:
        db.DB_PATH = old_path


def test_company_site_discovery_is_disabled_until_dns_pinning(monkeypatch):
    import requests

    from pulseops_outreach import send_engine as se

    def fail_if_called(*args, **kwargs):
        pytest.fail("company-site discovery must not make a request")

    monkeypatch.setattr(requests, "get", fail_if_called)
    assert se._scrape_company_emails("company.com", "Company") == []


@pytest.mark.parametrize(
    "domain",
    [
        "localhost",
        "box.localhost",
        "service.local",
        "metadata.internal",
        "127.0.0.1",
        "https://user:password@company.com",
    ],
)
def test_internal_company_domain_never_reaches_requests(domain, monkeypatch):
    import requests

    from pulseops_outreach import send_engine as se

    calls = []

    def fail_if_called(*args, **kwargs):
        calls.append((args, kwargs))
        pytest.fail("an internal company URL reached requests")

    monkeypatch.setattr(requests, "get", fail_if_called)

    assert se._scrape_company_emails(domain, "Company") == []
    assert calls == []


def test_private_dns_answer_never_reaches_requests(monkeypatch):
    import requests

    from pulseops_outreach import send_engine as se

    def private_dns(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", int(port or 443)))
        ]

    monkeypatch.setattr(se._scraper_policy.socket, "getaddrinfo", private_dns)
    monkeypatch.setattr(
        requests,
        "get",
        lambda *args, **kwargs: pytest.fail("private DNS answer reached requests"),
    )

    assert se._scrape_company_emails("public.example", "Public Co") == []


def test_searchapi_uses_public_url_policy_and_disables_redirects(monkeypatch):
    from unittest.mock import Mock

    import requests

    from pulseops_outreach import send_engine as se

    _public_dns(monkeypatch)
    monkeypatch.setenv("SEARCHAPI_API_KEY", "test-key")
    response = Mock(status_code=200)
    response.json.return_value = {
        "organic_results": [
            {"title": "Contact", "snippet": "careers@acme.com"},
        ]
    }
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return response

    monkeypatch.setattr(requests, "get", fake_get)

    assert se._searchapi_company_emails("acme.com", "Acme") == ["careers@acme.com"]
    assert calls[0][0] == se._SEARCHAPI_URL
    assert calls[0][1]["allow_redirects"] is False


def test_searchapi_revalidates_private_redirect_before_second_request(monkeypatch):
    import socket as socket_module
    from types import SimpleNamespace

    import requests

    from pulseops_outreach import send_engine as se

    def fake_dns(host, port, *args, **kwargs):
        address = "10.0.0.7" if host == "private.example" else "93.184.216.34"
        return [
            (socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", (address, int(port or 443)))
        ]

    monkeypatch.setattr(se._scraper_policy.socket, "getaddrinfo", fake_dns)
    monkeypatch.setenv("SEARCHAPI_API_KEY", "test-key")
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return SimpleNamespace(
            status_code=302,
            headers={"Location": "https://private.example/secret"},
            text="",
        )

    monkeypatch.setattr(requests, "get", fake_get)

    assert se._searchapi_company_emails("acme.com") == []
    assert calls == [(se._SEARCHAPI_URL, {
        "params": {"engine": "google", "q": "site:acme.com contact OR email OR careers", "api_key": "test-key"},
        "allow_redirects": False,
        "timeout": 15,
    })]


@pytest.mark.parametrize(
    "value",
    [
        "localhost",
        "box.localhost",
        "service.local",
        "metadata.internal",
        "127.0.0.1",
        "::1",
        "ftp://public.example",
        "https://user:password@public.example",
    ],
)
def test_domain_normalisation_rejects_local_and_literal_names(value):
    from pulseops_store import db_manager as db

    assert db.normalise_domain(value) == ""


def test_explicit_email_must_match_domain_and_simulation_is_offline(monkeypatch):
    from pulseops_outreach import send_engine as se
    from pulseops_core.exceptions import NoContactEmailError
    from pulseops_store import db_manager as db

    monkeypatch.setattr(
        se,
        "_scrape_company_emails",
        lambda *args, **kwargs: pytest.fail("simulation attempted a site lookup"),
    )
    monkeypatch.setattr(
        se,
        "_searchapi_company_emails",
        lambda *args, **kwargs: pytest.fail("simulation attempted a search lookup"),
    )
    monkeypatch.setattr(db, "get_domain_contact", lambda domain: None)

    with pytest.raises(NoContactEmailError):
        se._check_g10_contact("info@evil.com", "company.com", "high", simulate=True)

    assert se._check_g10_contact("info@company.com", "company.com", "high", simulate=True).lower() == (
        "info@company.com"
    )


def test_portal_domain_is_never_used_as_company_contact_domain():
    from pulseops_outreach import send_engine as se

    assert se._infer_domain(
        {"inferred_domain": "indeed.com", "domain_confidence": "high"},
        "AbhiBus",
    ) == ""
    assert se._infer_domain(
        {"inferred_domain": "abhibus.com", "domain_confidence": "high"},
        "AbhiBus",
    ) == "abhibus.com"


def test_domain_cache_rejects_third_party_address(temp_db):
    assert temp_db.save_domain_contact("company.com", "info@evil.com", "jd") is False
    assert temp_db.get_domain_contact("company.com") is None


def test_sent_persistence_rejects_non_exact_recipient_domain(temp_db):
    from pulseops_core.exceptions import DatabaseError

    job_id = temp_db.save_job(title="Backend Intern", company="Acme")
    with pytest.raises(DatabaseError, match="exact company domain"):
        temp_db.save_outreach(
            job_id=job_id,
            company="Acme",
            contact_email="info@evil.com",
            subject="Application",
            domain="acme.com",
        )
    assert temp_db.get_recent_outreach(days=1) == []


def test_sent_persistence_requires_a_recipient(temp_db):
    from pulseops_core.exceptions import DatabaseError

    job_id = temp_db.save_job(title="Backend Intern", company="Acme")
    with pytest.raises(DatabaseError, match="verified recipient"):
        temp_db.save_outreach(
            job_id=job_id,
            company="Acme",
            contact_email="",
            subject="Application",
            domain="acme.com",
        )


def test_g2_uses_job_title_from_joined_outreach(temp_db):
    from pulseops_core.exceptions import SemanticDuplicateError
    from pulseops_outreach import send_engine as se

    job_id = temp_db.save_job(title="Backend Intern", company="Acme")
    temp_db.save_outreach(
        job_id=job_id,
        company="Acme",
        contact_email="info@acme.com",
        subject="Application",
        status="sent",
        domain="acme.com",
    )

    with pytest.raises(SemanticDuplicateError):
        se._check_g2_duplicate(job_id, "Acme", "Backend Intern")


def test_simulation_has_no_network_or_send_side_effects(temp_db, monkeypatch):
    import requests

    from pulseops_outreach import send_engine as se

    job_id = temp_db.save_job(
        title="Backend Intern", company="NoMailCo", status="Evaluated", score=99
    )
    monkeypatch.setattr(
        requests,
        "get",
        lambda *args, **kwargs: pytest.fail("simulation attempted a network request"),
    )
    for name in (
        "save_domain_contact",
        "save_outreach",
        "update_job_status",
        "record_variant_send",
    ):
        def fail_if_called(*args, _name=name, **kwargs):
            pytest.fail(f"simulation attempted DB side effect: {_name}")

        monkeypatch.setattr(temp_db, name, fail_if_called)

    result = se.decide_send(
        job_id,
        {"company": "NoMailCo", "title": "Backend Intern"},
        {"match_percentage": 99, "inferred_domain": "nomailco.com"},
        {"scoring": {"send_threshold": 70}, "guardrails": OPEN_WINDOW},
        simulate=True,
    )

    assert result["guardrail"] == "G10"
    assert result["action"] == "SKIP"
    assert "review-sim" in result["reason"]
    assert temp_db.count_pending_review_jobs() == 0
    assert temp_db.get_job(job_id)["status"] == "Evaluated"


def test_review_creation_is_idempotent_under_concurrency(temp_db):
    job_id = temp_db.save_job(title="Backend Intern", company="Concurrent Co")

    def create_once():
        return temp_db.ensure_review_outreach(job_id, "Concurrent Co", "concurrent.co", "G10")

    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _index: create_once(), range(8)))

    assert len(set(ids)) == 1
    assert temp_db.count_pending_review_jobs() == 1


def test_review_delivery_claim_is_at_most_once(temp_db):
    job_id = temp_db.save_job(title="Backend Intern", company="Claim Co")
    review_id = temp_db.ensure_review_outreach(
        job_id, "Claim Co", "claim.co", "G10"
    )

    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(
            lambda _index: temp_db.claim_review_card(review_id, job_id=job_id),
            range(8),
        ))

    assert sum(bool(value) for value in claims) == 1
    assert temp_db.ensure_review_outreach(job_id, "Claim Co", "claim.co", "G10") == review_id
    assert temp_db.get_review_outreach_status(review_id) == "review_sending"
    assert temp_db.claim_review_card(review_id, job_id=job_id) is False
    assert temp_db.release_review_card(review_id, "test transport failure") is True
    assert temp_db.get_review_outreach_status(review_id) == "needs_review"


def test_flush_marks_exact_row_and_does_not_repeat(temp_db, monkeypatch):
    import pulseops_notify.discord as discord

    from pulseops_outreach import send_engine as se

    job_id = temp_db.save_job(title="Backend Intern", company="Flush Co")
    review_id = temp_db.ensure_review_outreach(job_id, "Flush Co", "flush.co", "G10")
    calls: list[int] = []

    def fake_send(**kwargs):
        calls.append(int(kwargs["job"]["job_id"]))
        return True

    monkeypatch.setenv("DISCORD_REVIEW_WEBHOOK_URL", "https://example.invalid/webhook")
    monkeypatch.setattr(discord, "send_discord_review_card", fake_send)

    first = se.flush_pending_review_cards(limit=20)
    second = se.flush_pending_review_cards(limit=20)

    assert first == {"pending": 0, "posted": 1, "failed": 0}
    assert second == {"pending": 0, "posted": 0, "failed": 0}
    assert calls == [job_id]
    assert temp_db.get_review_outreach_status(review_id) == "review_posted"


def _followup_candidate(**overrides):
    row = {
        "id": 1,
        "job_id": 2,
        "company": "Acme",
        "domain": "acme.com",
        "contact_email": "info@acme.com",
        "subject": "Application",
        "job_title": "Backend Intern",
    }
    row.update(overrides)
    return row


def test_paused_followup_fails_closed_before_candidate_read(monkeypatch):
    from pulseops_outreach import followup_engine as followup

    monkeypatch.setattr(followup.db, "get_send_paused", lambda: True)
    monkeypatch.setattr(
        followup.db,
        "get_followup_candidates",
        lambda **kwargs: pytest.fail("paused follow-up read candidates"),
    )

    assert followup.process_followups(settings={}) == 0


def test_unreadable_followup_pause_fails_closed(monkeypatch):
    from pulseops_outreach import followup_engine as followup

    def unreadable():
        raise RuntimeError("settings unavailable")

    monkeypatch.setattr(followup.db, "get_send_paused", unreadable)
    monkeypatch.setattr(
        followup.db,
        "get_followup_candidates",
        lambda **kwargs: pytest.fail("unreadable pause read candidates"),
    )

    assert followup.process_followups(settings={}) == 0


def test_followup_rechecks_pause_immediately_before_send(monkeypatch):
    from pulseops_outreach import followup_engine as followup

    states = iter((False, True))
    monkeypatch.setattr(followup.db, "get_send_paused", lambda: next(states))
    monkeypatch.setattr(
        followup.db,
        "get_followup_candidates",
        lambda **kwargs: [_followup_candidate()],
    )
    monkeypatch.setattr(followup, "_send_followup_email", lambda *args, **kwargs: pytest.fail(
        "sent after pause was re-enabled"
    ))

    assert followup.process_followups(
        settings={"guardrails": {"min_send_gap_minutes": 0}},
        simulate=True,
    ) == 0


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"contact_email": "recruiter@third-party.example"}, "third-party"),
        ({"domain": "", "job_contact_email": "info@acme.com"}, "missing-domain"),
    ],
)
def test_followup_rejects_third_party_and_missing_domain_targets(monkeypatch, overrides, reason):
    from pulseops_outreach import followup_engine as followup

    monkeypatch.setattr(followup.db, "get_send_paused", lambda: False)
    monkeypatch.setattr(
        followup.db,
        "get_followup_candidates",
        lambda **kwargs: [_followup_candidate(**overrides)],
    )
    monkeypatch.setattr(
        followup,
        "_send_followup_email",
        lambda *args, **kwargs: pytest.fail(f"sent an unsafe follow-up ({reason})"),
    )
    monkeypatch.setattr(
        followup.db,
        "mark_followup_sent",
        lambda *args, **kwargs: pytest.fail("marked an unsafe follow-up as sent"),
    )
    monkeypatch.setattr(followup.audit_log, "write_followup", lambda *args, **kwargs: None)

    assert followup.process_followups(
        settings={"guardrails": {"min_send_gap_minutes": 0}},
        simulate=True,
    ) == 0


def test_followup_simulation_accepts_exact_domain_without_mutation(monkeypatch):
    from pulseops_outreach import followup_engine as followup

    marks = []
    monkeypatch.setattr(followup.db, "get_send_paused", lambda: False)
    monkeypatch.setattr(
        followup.db,
        "get_followup_candidates",
        lambda **kwargs: [_followup_candidate()],
    )
    monkeypatch.setattr(followup.db, "mark_followup_sent", lambda oid: marks.append(oid))
    monkeypatch.setattr(
        followup.db,
        "update_job_status",
        lambda *args: pytest.fail("simulation changed job status"),
    )
    monkeypatch.setattr(followup, "_recent_achievement", lambda company: "")
    monkeypatch.setattr(followup.audit_log, "write_followup", lambda *args, **kwargs: None)

    assert followup.process_followups(
        settings={"guardrails": {"min_send_gap_minutes": 0}},
        simulate=True,
    ) == 1
    assert marks == []


@pytest.mark.parametrize("confidence", ["low", "medium", "", None])
def test_non_high_confidence_explicit_domain_is_rejected(confidence):
    from pulseops_outreach import send_engine as se

    assert se._infer_domain(
        {"inferred_domain": "acme.com", "domain_confidence": confidence},
        "Acme",
    ) == ""


def test_ats_tenant_inferred_domains_are_rejected():
    from pulseops_outreach import send_engine as se

    ats_domains = (
        "jobs.lever.co",
        "boards.greenhouse.io",
        "job-boards.greenhouse.co",
        "jobs.ashbyhq.com",
        "acme.myworkdayjobs.com",
        "acme.wd1.myworkdayjobs.com",
        "jobs.smartrecruiters.com",
    )
    for ats_domain in ats_domains:
        assert se._infer_domain(
            {"inferred_domain": ats_domain, "domain_confidence": "high"},
            "Acme",
        ) == ""
        assert se._infer_domain(
            {
                "inferred_domain": "acme.com",
                "domain_confidence": "high",
                "job_url": f"https://{ats_domain}/acme/job",
            },
            "Acme",
        ) == ""


def test_normal_exact_company_domain_is_accepted(monkeypatch):
    from pulseops_outreach import send_engine as se
    from pulseops_store import db_manager as db

    monkeypatch.setattr(db, "get_domain_contact", lambda domain: None)
    assert se._infer_domain(
        {"inferred_domain": "acme.com", "domain_confidence": "high"},
        "Acme",
    ) == "acme.com"
    assert se._check_g10_contact(
        "info@acme.com", "acme.com", "high", company="Acme", simulate=True
    ).lower() == "info@acme.com"


def test_email_sender_pause_and_domain_checks_override_auto_flag(monkeypatch):
    from pulseops_outreach import email_sender as sender

    monkeypatch.setenv("AUTO_SEND_EMAILS", "true")
    monkeypatch.setenv("SMTP_EMAIL", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "secret")
    monkeypatch.setattr(
        sender,
        "_smtp_credentials",
        lambda: ("smtp.invalid", "sender@example.com", "secret", 587),
    )

    def no_smtp(*args, **kwargs):
        pytest.fail("SMTP was constructed despite a safety check")

    monkeypatch.setattr(sender.smtplib, "SMTP", no_smtp)
    monkeypatch.setattr(sender.db, "get_send_paused", lambda: True)
    assert sender.send_smtp("info@acme.com", domain="acme.com") is False

    monkeypatch.setattr(sender.db, "get_send_paused", lambda: False)
    assert sender.send_smtp("info@third-party.example", domain="acme.com") is False
