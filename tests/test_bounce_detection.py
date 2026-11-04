"""Bounce recognition and address-level suppression.

Measured 2026-11-04: 75 bounce messages were sitting in the inbox and the
watcher reported "bounces_fixed 0" on every run. Two separate reasons, both of
which meant the machine kept writing to mailboxes Gmail had already refused:

  * the recipient pattern required two dot-separated labels after the @, so an
    ordinary address (hiring@anthropic.com) could never be extracted;

  * a bounce was matched against the last 30 days of outreach only, while the
    mail it condemned had been sent in September - so even an extracted address
    found no row.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-store" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "pulse-notify" / "src"))


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    from pulseops_store import db_manager as db

    old_path = db.DB_PATH
    db.DB_PATH = tmp_path / "bounce-detection.db"
    db.init_db()
    try:
        yield db
    finally:
        db.DB_PATH = old_path


def _google_bounce(address: str) -> str:
    return (
        f"** Address not found ** Your message wasn't delivered to {address} because the "
        "address couldn't be found, or is unable to receive mail. Learn more here: "
        "https://support.google.com/mail/?p=NoSuchUser The response was: The email account "
        "that you tried to reach does not exist."
    )


def test_google_bounce_names_the_failed_recipient(monkeypatch):
    from pulseops_notify.email_watcher import _extract_bounced_email

    monkeypatch.setenv("SMTP_EMAIL", "me@gmail.com")
    # The address that actually bounced. The old pattern needed two labels after
    # the @, so this returned None and the bounce was never seen.
    assert _extract_bounced_email(
        "Delivery Status Notification (Failure)", _google_bounce("hiring@anthropic.com")
    ) == "hiring@anthropic.com"
    # A multi-label domain still works, and is not mangled.
    assert _extract_bounced_email(
        "Delivery Status Notification (Failure)", _google_bounce("talent@careers.example.co.in")
    ) == "talent@careers.example.co.in"


def test_bounce_never_returns_our_own_address(monkeypatch):
    from pulseops_notify.email_watcher import _extract_bounced_email

    monkeypatch.setenv("SMTP_EMAIL", "me@gmail.com")
    body = (
        "Delivery to the following recipient failed permanently: hr@acme.in "
        "Reported by me@gmail.com to mailer-daemon@googlemail.com"
    )
    assert _extract_bounced_email("Mail Delivery Failed", body) == "hr@acme.in"
    # Nothing but our own address: refuse rather than mark ourselves bounced.
    assert _extract_bounced_email(
        "Undeliverable", "Returned mail, see me@gmail.com for details"
    ) is None


def test_a_non_bounce_message_names_nobody(monkeypatch):
    from pulseops_notify.email_watcher import _extract_bounced_email

    monkeypatch.setenv("SMTP_EMAIL", "me@gmail.com")
    # An ordinary reply quoting an address must not be read as a bounce target.
    assert _extract_bounced_email(
        "Re: Application",
        "Thanks for applying, my colleague priya@acme.in will be in touch.",
    ) is None


def test_dsn_report_part_is_read_when_present(monkeypatch):
    import email as email_lib

    from pulseops_notify.email_watcher import _extract_bounced_email

    monkeypatch.setenv("SMTP_EMAIL", "me@gmail.com")
    raw = (
        "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\n"
        "Subject: Delivery Status Notification (Failure)\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n'
        "\r\n--B\r\n"
        "Content-Type: text/plain\r\n\r\nYour message could not be delivered.\r\n"
        "\r\n--B\r\n"
        "Content-Type: message/delivery-status\r\n\r\n"
        "Final-Recipient: rfc822; hiring@rubrik.com\r\n"
        "Action: failed\r\n"
        "\r\n--B--\r\n"
    )
    msg = email_lib.message_from_string(raw)
    assert _extract_bounced_email("Delivery Status Notification (Failure)", "", msg) == "hiring@rubrik.com"


def test_a_delay_notification_does_not_condemn_a_mailbox():
    """Gmail files delays and failures under the same subject line."""
    from pulseops_notify.email_watcher import _is_transient_delay

    assert _is_transient_delay(
        "Delivery Status Notification (Delay)",
        "Your message to hr@acme.in has been delayed. We will keep trying for 48 hours.",
    ) is True
    assert _is_transient_delay(
        "Delivery Status Notification (Failure)",
        "Your message wasn't delivered to hiring@anthropic.com because the address couldn't be found.",
    ) is False
    # A delay that later turns into a failure is judged on the failure text.
    assert _is_transient_delay(
        "Delivery Status Notification (Delay)",
        "Delivery to the following recipient failed permanently: hr@acme.in",
    ) is False
    # Unrelated mail is not a delay.
    assert _is_transient_delay("Re: Application", "Thanks, we will be in touch.") is False


def _sent(db, company: str, address: str) -> int:
    job_id = db.save_job(
        title=f"{company} Engineer",
        company=company,
        link=f"https://jobs.example.com/{company.lower()}",
        source="Test",
        status="EmailSent",
        score=70,
    )
    db.save_outreach(
        job_id=job_id,
        company=company,
        domain=address.rsplit("@", 1)[-1],
        contact_email=address,
        subject="Application",
        body="body",
        email_variant="A",
        status="sent",
    )
    return job_id


def test_a_bounce_marks_every_message_to_that_address(temp_db):
    """One dead mailbox means every send to it failed, not just the latest."""
    first = _sent(temp_db, "Anthropic", "hiring@anthropic.com")
    second = _sent(temp_db, "Anthropic", "hiring@anthropic.com")
    other = _sent(temp_db, "Anthropic", "jobs@anthropic.com")

    # The rows were sent long before the bounce arrived; the lookup must not be
    # windowed by send date, which is what hid all 75 bounces.
    assert len(temp_db.get_outreach_by_contact_email("Hiring@Anthropic.com")) == 2

    assert temp_db.mark_address_bounced("hiring@anthropic.com") == 2
    rows = temp_db.get_outreach_by_contact_email("hiring@anthropic.com")
    assert {r["status"] for r in rows} == {"bounced"}
    assert all("hiring@anthropic.com" in (r["notes"] or "") for r in rows)
    # A different mailbox on the same domain is untouched.
    assert temp_db.get_outreach_by_contact_email("jobs@anthropic.com")[0]["status"] == "sent"
    # Nothing is written twice.
    assert temp_db.mark_address_bounced("hiring@anthropic.com") == 0
    assert temp_db.get_job(first)["status"] == "EmailSent"
    assert temp_db.get_job(second)["status"] == "EmailSent"
    assert temp_db.get_job(other)["status"] == "EmailSent"


def test_g9_counts_distinct_dead_mailboxes_not_rows(temp_db):
    """Four messages to one bad guess is one dead mailbox, not four."""
    for _ in range(4):
        _sent(temp_db, "Anthropic", "hiring@anthropic.com")
    temp_db.mark_address_bounced("hiring@anthropic.com")
    assert temp_db.count_bounced_addresses_for_domain("anthropic.com") == 1

    _sent(temp_db, "Anthropic", "jobs@anthropic.com")
    temp_db.mark_address_bounced("jobs@anthropic.com")
    assert temp_db.count_bounced_addresses_for_domain("anthropic.com") == 2
    # An unrelated domain is unaffected.
    assert temp_db.count_bounced_addresses_for_domain("rubrik.com") == 0
    assert temp_db.count_bounced_addresses_for_domain("") == 0
