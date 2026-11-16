"""application_replies.py — find the answers to the applications we sent.

Every application this system sends through a board's form is answered by mail
that no part of PulseOps was reading. The reply detector (reply_detector.py)
watches the addresses in the `outreach` table, which is the cold-outreach
channel; a form application leaves no row there, so the reply to it was
invisible. Measured on the candidate's own inbox, 2026-11-16:

    Pooja from Aspiremetrics <hr@aspiremetrics.in>
      "we would like to move your profile to the batch allocation stage...
       please reply directly to this email with: 1. Your college name and
       graduation year 2. Your available joining date"

    HR Department | ApexElement <hr@apexelement.in>
      "please reply directly to this email with the word INTERESTED"

    Hiring Team <no-reply@breezy-mail.com>
      "We'd like to ask you a few more questions... please click the following
       link and complete the form"

    No-Reply <no-reply@somewheretypingtest.com>
      "The next step in the process is an online typing speed assessment"

Four live conversations, none of them visible to the pipeline, and two of them
needing an answer within a day to keep the application alive.

The difficulty is the other way round: an inbox that has been told to apply to
a hundred jobs is mostly noise. A board's confirmation ("Thank you for
applying", "We have received your application") is the single most common mail
and it is not a reply to anything. A job-alert digest is not a reply. A
newsletter is not a reply. So the classifier separates three things:

  * a RECRUITER REPLY - a human answering about this application, including one
    sent from a no-reply address because that is how several ATS platforms
    (Breezy, typing-test vendors) deliver a next step;
  * a REJECTION - "we have decided not to move forward", which is also an
    answer and belongs in the record;
  * everything else - noise, which is dropped.

Only a reply or a rejection is recorded. Both are facts about an application,
and both are worth the operator's attention; a confirmation is worth nothing
except silence.
"""

from __future__ import annotations

import email
import imaplib
import os
import re
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime

from pulseops_store import db_manager as db

# ── what the candidate's own address looks like ──────────────────────────────
OWN_LOCAL_PARTS = ("trex2004avradeep", "avradeep", "deep")

# ── noise ───────────────────────────────────────────────────────────────────
# Board digests, marketplaces, newsletters. A mail from any of these hosts is
# never a person answering an application.
NOISE_SENDER = re.compile(
    r"glassdoor|indeed|hirist|wellfound|jobgether|foundit|monsterindia|nytimes|"
    r"nba|nfl|nhl|adobe|skool|canva|temu|flipkart|quora|chess\.com|twitch|"
    r"premiership|e\.nytimes|googleplay|abacus|premierleague|fenris|"
    r"jobfeed|hitachi|connectedcareers|nvidia|alibaba|microsoft|"
    r"shine\.com|hackindia|wispr",
    re.I,
)
NOISE_SUBJECT = re.compile(
    r"job alert|new job|jobs for you|jobs matching|job match|top .{0,20}jobs|"
    r"newsletter|digest|flash sale|offer|discount|off sale|% off|webinar|"
    r"survey|your .{0,20}update|recommendation|trending|expiring|"
    r"urgent opening|verify profile details|top applicant|"
    r"verify your profile|update your profile|candidate profile",
    re.I,
)

# ── an automated confirmation of an application ─────────────────────────────
# The most common mail an applicant receives, and the one that must never be
# mistaken for an answer.
CONFIRMATION = re.compile(
    r"thank you for applying|thanks for applying|thank you for your application|"
    r"we (?:have )?received your application|your application (?:has been|was) received|"
    r"application (?:received|submitted)[:\s-]|we have received your application|"
    r"your application for .{0,60} (?:has been|was) (?:received|submitted)|"
    r"we will review your application|we've received your application|"
    r"application submitted successfully|we have successfully received your application",
    re.I,
)

# ── a person answering ──────────────────────────────────────────────────────
# The phrases that mean the candidate has to DO something, or that the
# employer has decided. These are strict on purpose: every weaker phrase was
# tried, and each one caught a template.
#
#   "next steps"  - a confirmation says "What happens next?" and a job-alert
#                    template says "next steps in your journey"; the requests
#                    that matter say what to do ("please reply", "we'd like to
#                    ask you", "complete the form").
#   "interview"   - every confirmation says "a recruiter may contact you".
#   "reply to this email" - every confirmation says "do not reply to this
#                    email", so the phrase only counts when it is not negated.
REQUEST_MARKERS = re.compile(
    r"we(?:'d| would) like to (?:ask|have|schedule|discuss|set up|proceed)|"
    r"please reply|reply directly to this email|kindly reply|respond with|"
    r"reply with the word|hit reply|"
    r"complete the (?:form|test|assessment)|click the following link|"
    r"typing (?:speed )?(?:test|assessment)|"
    r"batch allocation|move your profile|"
    r"schedule (?:a|an) (?:call|interview|chat)|"
    r"we just need to double-check|mind answering|awaiting a few details|"
    r"confirm (?:your|that you)",
    re.I,
)

# An answer with nothing to do: a decision, usually a rejection.
DECISION_MARKERS = re.compile(
    r"decided not to move forward|not be moving forward|will not be proceeding|"
    r"we(?:'re| are) sorry to inform|unfortunately[^.]{0,40}(?:will not|won't|are unable)|"
    r"we regret to inform|have decided against",
    re.I,
)

# A person saying hello about the candidate's own application.
GREETING_MARKERS = re.compile(
    r"welcome to\b|glad you(?:'re| are) here",
    re.I,
)

# A message has to be about THIS candidate's application to be one. A
# newsletter that says "your meeting ended, what's next?" is not an answer to
# anything, and neither is a weekly digest that greets the candidate by name.
ABOUT_APPLICATION = re.compile(
    r"avradeep|deep\b|\byour application\b|your (?:profile|submission)|"
    r"application (?:form|status|process)|applicant|candidate|opportunity|"
    r"role|position|interview|hiring process|applied (?:for|to)\b",
    re.I,
)

# ── an auto-responder or a machine ──────────────────────────────────────────
AUTO_LOCAL = re.compile(
    r"^(?:no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply|auto[-_.]?reply|"
    r"auto[-_.]?respond|auto[-_.]?submitted|autoreply|mailer[-_.]?daemon|postmaster|"
    r"bounce|notifications?|alerts?|updates?|newsletter|marketing|info|support|"
    r"donotreply|email)",
    re.I,
)

# Boilerplate that says the mailbox is unattended. It does not make the message
# noise on its own - a next step from an unattended address is still a next
# step - but it does mean the phrase "reply to this email" cannot be taken at
# face value.
UNATTENDED = re.compile(
    r"do not reply to this email|unattended mailbox|auto[- ]?reply|"
    r"this is an automated message|auto-?generated|mailing list",
    re.I,
)


def decode_mime_words(value: str | None) -> str:
    if not value:
        return ""
    out: list[str] = []
    try:
        for chunk, encoding in decode_header(value):
            if isinstance(chunk, bytes):
                out.append(chunk.decode(encoding or "utf-8", errors="ignore"))
            else:
                out.append(chunk)
    except (LookupError, UnicodeError):
        return str(value)
    return "".join(out)


def plain_text(msg: email.message.Message, limit: int = 4000) -> str:
    chunks: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    chunks.append(payload.decode("utf-8", errors="ignore"))
            elif part.get_content_type() == "text/html" and not chunks:
                payload = part.get_payload(decode=True)
                if payload:
                    text = payload.decode("utf-8", errors="ignore")
                    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
                    text = re.sub(r"<[^>]+>", " ", text)
                    chunks.append(text)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            chunks.append(payload.decode("utf-8", errors="ignore"))
    text = " ".join(" ".join(chunks).split())
    return text[:limit]


def sender_address(from_header: str) -> str:
    match = re.search(r"<([^>]+)>", from_header or "")
    address = (match.group(1) if match else (from_header or "")).strip().lower()
    return address


def classify_reply(sender: str, subject: str, body: str) -> str | None:
    """Return "reply", "rejection" or None for one message.

    None means noise: a board digest, a newsletter, or the automated
    confirmation of an application that nobody wrote.
    """
    sender = (sender or "").strip()
    subject = (subject or "").strip()
    body = (body or "")

    if not sender:
        return None
    local, _, domain = sender.partition("@")
    if local in OWN_LOCAL_PARTS or "trex2004avradeep" in sender:
        return None
    if NOISE_SENDER.search(domain) or NOISE_SENDER.search(sender):
        return None
    if NOISE_SUBJECT.search(subject):
        return None
    if "auto-submitted" in body.lower() or "auto-submitted" in subject.lower():
        return None

    # The message has to be about this candidate's application. A digest that
    # greets him by name is not an answer to anything.
    blob = f"{subject} {body}"
    if not ABOUT_APPLICATION.search(blob):
        return None

    # An automatic confirmation is the commonest mail an applicant receives and
    # it is not an answer. It stays a confirmation unless it also asks for
    # something, which a real next step does.
    #
    # A decision is never a confirmation: "Thank you for your interest, we have
    # decided not to move forward" is a rejection, and it is the one mail of
    # this shape worth keeping.
    is_confirmation = bool(CONFIRMATION.search(subject) or CONFIRMATION.search(body))
    request = REQUEST_MARKERS.search(subject) or REQUEST_MARKERS.search(body)
    decision = DECISION_MARKERS.search(subject) or DECISION_MARKERS.search(body)
    greeting = GREETING_MARKERS.search(subject) or GREETING_MARKERS.search(body)
    if decision:
        return "rejection"
    if is_confirmation and not (request or greeting):
        return None
    if not (request or greeting):
        return None

    # A machine's boilerplate cannot be the reason we call this a reply, and
    # "reply to this email" inside "do not reply to this email" is the clearest
    # example of a phrase that has to be read in context.
    unattended = bool(UNATTENDED.search(body)) or bool(UNATTENDED.search(subject))
    if unattended:
        text = re.sub(r"do not reply to this email", " ", blob, flags=re.I)
        if not (REQUEST_MARKERS.search(text) or DECISION_MARKERS.search(text) or GREETING_MARKERS.search(text)):
            return None
    if AUTO_LOCAL.match(local) and not (REQUEST_MARKERS.search(body) or GREETING_MARKERS.search(body)):
        return None

    return "reply"


def _job_for_reply(sender: str, subject: str, body: str) -> int | None:
    """Match a reply to the row it belongs to, when the evidence allows it.

    Two ways, both narrow on purpose. The sender's domain is the company's own
    domain ("hr@axonbloom.com" for a company named Axonbloom), or the mail
    names the company as a whole word ("Akshora AI Labs").

    The earlier version matched a cleaned-up blob, and that matched the wrong
    rows: "CRED" was found inside "credential" and "Knowl" inside "knowledge",
    so four replies were filed under unrelated roles. A company's name is a
    word, not a fragment, and a domain is a domain, not a prefix of one.
    """
    domain = sender_address(sender).partition("@")[2]
    blob = f"{subject} {body}"
    rows = db.get_jobs_by_status(["Applied", "Verified", "NeedsVerification", "FollowupSent"], limit=800)
    if not rows:
        return None

    # 1. The sender's own domain, label by label: hr@axonbloom.com for
    #    Axonbloom, bishnudev@insiderone.in for insiderOne.
    labels = [label for label in domain.split(".") if label]
    for row in rows:
        company = re.sub(r"[^a-z0-9]+", "", str(row.get("company") or "").lower())
        if len(company) < 5:
            continue
        if any(label.lower() == company for label in labels[:-1]):
            return int(row["id"])

    # 2. The company's name, as a whole word in the mail.
    for row in rows:
        company = str(row.get("company") or "").strip()
        if len(company) < 5 or company.lower() in {"unknown", "na", "none"}:
            continue
        if re.search(r"\b" + re.escape(company) + r"\b", blob, re.I):
            return int(row["id"])
    return None


def sweep(imap_host: str | None = None, imap_email: str | None = None,
          imap_password: str | None = None, days: int = 21,
          limit: int = 400, dry_run: bool = False) -> dict:
    """Read the inbox once and record every answer to an application."""
    host = imap_host or os.getenv("IMAP_HOST", "imap.gmail.com")
    user = imap_email or os.getenv("IMAP_EMAIL") or os.getenv("SMTP_EMAIL", "")
    password = imap_password or os.getenv("IMAP_PASSWORD") or os.getenv("SMTP_PASSWORD", "")
    stats = {"replies": 0, "rejections": 0, "noise": 0, "new": 0, "items": []}
    if not user or not password:
        stats["error"] = "missing IMAP credentials"
        return stats

    mail = imaplib.IMAP4_SSL(host, 993, timeout=30)
    try:
        mail.login(user, password)
        mail.select("INBOX")
        since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        status, data = mail.uid("SEARCH", None, "SINCE", since)
        uids = (data[0] or b"").split()[-limit:]
        for uid in uids:
            status, msg_data = mail.uid("FETCH", uid, "(BODY.PEEK[])")
            if status != "OK" or not msg_data:
                continue
            raw = None
            for part in msg_data:
                if isinstance(part, tuple):
                    raw = part[1]
            if not raw:
                continue
            msg = email.message_from_bytes(raw)
            from_header = decode_mime_words(msg.get("From", ""))
            sender = sender_address(from_header)
            subject = decode_mime_words(msg.get("Subject", ""))
            body = plain_text(msg)
            kind = classify_reply(sender, subject, body)
            if not kind:
                stats["noise"] += 1
                continue
            stats["replies" if kind == "reply" else "rejections"] += 1
            received = decode_mime_words(msg.get("Date", "")) or datetime.now().isoformat()
            job_id = _job_for_reply(sender, subject, body)
            stats["items"].append({
                "kind": kind, "sender": sender, "subject": subject,
                "snippet": body[:400], "received_at": received, "job_id": job_id,
            })
            if dry_run:
                continue
            is_new = db.save_reply(sender, subject, body[:250], received, job_id=job_id)
            if not is_new:
                continue
            stats["new"] += 1
            if job_id:
                try:
                    db.update_job_status(job_id, "Replied")
                except Exception as exc:  # noqa: BLE001 - the reply is still recorded
                    print(f"  [!] reply recorded but job {job_id} status not updated: {exc}")
            print(f"  [REPLY] {sender}: {subject[:80]}"
                  + (f" (job #{job_id})" if job_id else " (no matching row)"))
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001
            pass
    return stats
