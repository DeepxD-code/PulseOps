"""The reply classifier decides what counts as an answer to an application.

Every case below is a real message from the candidate's inbox (2026-11-16), so
the classifier is pinned to what employers actually send rather than to a
guess about what they might send.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for package in ("pulse-store", "pulse-eval", "pulse-config", "pulse-notify", "pulse-core"):
    path = ROOT / "packages" / package / "src"
    if path.exists() and str(path) not in sys.path:
        sys.path.insert(0, str(path))

from pulseops_notify.application_replies import classify_reply  # noqa: E402


def test_a_recruiter_asking_for_a_reply_is_a_reply():
    kind = classify_reply(
        "hr@apexelement.in",
        "Action Required: Reply INTERESTED to confirm your Artificial Intelligence application",
        "Hi Avradeep Majumder, Thank you for submitting your application for the Internship "
        "Program at ApexElement! We have received your details. To ensure your profile moves "
        "forward to the final review stage, please reply directly to this email with the word "
        "\"INTERESTED\".",
    )
    assert kind == "reply"


def test_a_next_step_sent_from_a_no_reply_address_is_still_a_reply():
    # Breezy sends its questions from no-reply@breezy-mail.com.
    kind = classify_reply(
        "no-reply@breezy-mail.com",
        "Re: Opportunity at Netrix Global",
        "Hi AVRADEEP, We'd like to ask you a few more questions. When you have a couple minutes, "
        "please click the following link and complete the form. "
        "https://netrix-global.breezy.hr/f/91c2c28977d0",
    )
    assert kind == "reply"


def test_a_typing_test_next_step_is_a_reply():
    kind = classify_reply(
        "no-reply@somewheretypingtest.com",
        "Next Step for Your Application - Typing Test - 2169479",
        "The next step in the process is a quick 1-minute typing speed assessment. Please use a "
        "laptop or desktop and reply with a screenshot of your result. Hi AVRADEEP, Thank you for "
        "applying to Somewhere!",
    )
    assert kind == "reply"


def test_an_automatic_confirmation_is_not_a_reply():
    # The commonest mail an applicant receives, and it says "do not reply to
    # this email" - a phrase that must never be read as a request.
    assert classify_reply(
        "no-reply@us.greenhouse-mail.io",
        "Thank you for applying to Scale AI",
        "AVRADEEP, Thanks for applying to Scale AI. Your application has been received and we "
        "will review it right away. If your application seems like a good fit for the position we "
        "will contact you soon. Regards, Scale AI ** Please note: Do not reply to this email. "
        "This email is sent from an unattended mailbox. Replies will not be read.",
    ) is None


def test_a_workday_confirmation_is_not_a_reply():
    assert classify_reply(
        "aristocrat@myworkday.com",
        "Application for AI Engineer",
        "Deep, Thank you for taking the time to submit your application for the AI Engineer role! "
        "We are excited that you're interested in joining us at Aristocrat. A recruiter will "
        "review your experience.",
    ) is None


def test_a_rejection_is_a_decision():
    kind = classify_reply(
        "no-reply@us.greenhouse-mail.io",
        "Information about your application to GitLab - Software Engineer, Delivery : Release",
        "Hi AVRADEEP, Thank you for your interest in GitLab! We've had a chance to review your "
        "application and unfortunately, have decided not to move forward.",
    )
    assert kind == "rejection"


def test_a_board_digest_is_not_a_reply():
    assert classify_reply(
        "noreply@glassdoor.com",
        "AI & Machine Learning Intern at BONC and 1 more job in Remote, India for you. Apply now",
        "AI & Machine Learning Intern at BONC and 1 more job in Remote, India for you. Apply now",
    ) is None


def test_a_newsletter_that_mentions_the_candidate_is_not_a_reply():
    assert classify_reply(
        "hello@mail.wispr.ai",
        "Your meeting ended. What's next?",
        "Introducing: Notetaker Skills. Meeting follow-ups made easier. Try Skills: ready-made "
        "prompts for action items.",
    ) is None


def test_a_weekly_digest_that_greets_him_is_not_a_reply():
    assert classify_reply(
        "noreply@hackindia.org",
        "Your week on HackIndia: 31 Oct to 6 Nov",
        "Hi Deep_, Your rank #3,757 of 49,978 builders. Start Build a clean front-end page.",
    ) is None


def test_a_welcome_is_a_reply():
    kind = classify_reply(
        "bishnudev@insiderone.in",
        "Avradeep, welcome to insiderOne",
        "Hi Avradeep, I'm Bishnu, the founder of insiderOne. I wanted to write to you myself to "
        "say welcome, and thank you for joining us.",
    )
    assert kind == "reply"


def test_his_own_mail_is_never_a_reply():
    assert classify_reply(
        "trex2004avradeep@gmail.com",
        "Application: Software Developer Intern",
        "Dear Hiring Manager, I am writing to apply for the Software Developer Intern role.",
    ) is None
