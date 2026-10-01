"""Read-only view of the candidate's own inbox.

The Autter wiki page promises "we'll email everyone in your org when it's ready",
and the review depends on what the product actually sent, so the mailbox is part
of the evidence rather than a side channel.

Read-only by construction: SELECT on INBOX, FETCH headers, never move, delete,
mark or archive anything. Bodies are only rendered on explicit request via
--show, so the default listing cannot dump unrelated personal mail into a log.

Run:  python mail_list.py --limit 25
      python mail_list.py --show 3
"""
from __future__ import annotations

import argparse
import email
import imaplib
import re
import ssl
import sys
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for name in (ROOT / ".env", Path(".env")):
        if name.is_file():
            for raw in name.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
            break
    return env


def header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return str(value)


def when(raw: str) -> str:
    try:
        return parsedate_to_datetime(raw).astimezone().strftime("%Y-%m-%d %H:%M")
    except Exception:
        return raw or ""


def html_to_text(raw: str) -> str:
    """Flatten an HTML-only message. These senders ship no text/plain part, so
    without this the log fills with <td style=...> instead of the sentence."""
    raw = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|tr|h[1-6]|li)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = unescape(raw)
    # Zero-width and bidi-marker noise that mail clients use for preview text.
    raw = re.sub(r"[-‏‪-‮⁠-⁤﻿\s]+", " ", raw)
    return re.sub(r"[ \t]{2,}", " ", raw)


def body_of(msg) -> str:
    """Flatten a message to readable text, preferring text/plain parts."""
    chunks: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() != "text/plain":
                continue
            if "attachment" in str(part.get("Content-Disposition", "")):
                continue
            try:
                chunks.append(part.get_payload(decode=True).decode("utf-8", "replace"))
            except Exception:
                continue
    if not chunks:
        for part in (msg.walk() if msg.is_multipart() else [msg]):
            if part.get_content_type() == "text/html":
                try:
                    chunks.append(html_to_text(part.get_payload(decode=True).decode("utf-8", "replace")))
                except Exception:
                    continue
                break
    text = "\n".join(chunks)
    text = re.sub(r"https?://\S{80,}", "<long-url>", text)  # keep tracking blobs out of the log
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--show", type=int, help="print the body of message N (0 = newest)")
    ap.add_argument("--grep", default="", help="only list mail whose subject/from matches")
    ap.add_argument("--find", default="", help="show every message whose subject/from contains this")
    args = ap.parse_args()

    # The Windows console defaults to cp1252 and dies on a stray non-Latin
    # character in a sender name. Force UTF-8 and substitute rather than abort.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    env = load_env()
    user, password = env.get("SMTP_EMAIL", ""), env.get("SMTP_PASSWORD", "")
    if not user or not password:
        print("no SMTP_EMAIL/SMTP_PASSWORD in .env", file=sys.stderr)
        return 1

    client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    client.login(user, password)
    client.select("INBOX")

    typ, data = client.search(None, "ALL")
    ids = data[0].split() if typ == "OK" else []
    ids = ids[-args.limit :][::-1]  # newest first

    # One FETCH for the whole sequence set. Fetching per-id costs one round trip
    # each, which is minutes of wall clock at even a few hundred messages.
    rows = []
    if ids:
        typ, raw = client.fetch(b",".join(ids), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if typ == "OK":
            # Two traps here, both of which fail silently:
            #   * IMAP answers a sequence set in ascending order no matter which
            #     direction it was asked in, so position in `raw` does not match
            #     position in `ids`.
            #   * the leading number in each response is the message UID, not a
            #     sequence number — so it is used to look the id up, never as an
            #     index.
            for chunk in raw:
                if not isinstance(chunk, tuple):
                    continue
                m = re.match(rb"(\d+)", chunk[0])
                if not m or m.group(1) not in ids:
                    continue
                msg = email.message_from_bytes(chunk[1])
                rows.append({
                    "mid": m.group(1),
                    "from": header(msg.get("From")),
                    "subject": header(msg.get("Subject")),
                    "date": when(header(msg.get("Date"))),
                })
            rows.sort(key=lambda r: int(r["mid"]), reverse=True)  # restore newest-first
            if not rows:
                print(f"header fetch parsed 0 of {len(ids)} (fetch said {typ})", file=sys.stderr)
        else:
            print(f"header fetch returned {typ}", file=sys.stderr)

    if args.grep:
        pat = re.compile(args.grep, re.I)
        rows = [r for r in rows if pat.search(r["from"]) or pat.search(r["subject"])]

    for i, r in enumerate(rows):
        print(f"[{i}] {r['date']}  {r['from'][:52]:<52}  {r['subject'][:88]}")

    if args.show is not None:
        # Index into `rows`, not `ids`: --grep filters them, so the printed [i]
        # and the raw fetch list stop agreeing.
        if args.show >= len(rows):
            print(f"index {args.show} out of range (have {len(rows)})", file=sys.stderr)
            return 1
        typ, raw = client.fetch(ids[args.show], "(RFC822)")
        if typ == "OK" and raw and isinstance(raw[0], tuple):
            msg = email.message_from_bytes(raw[0][1])
            print("\n" + "=" * 78)
            print(header(msg.get("Subject")))
            print("=" * 78)
            print(body_of(msg)[:4000])

    # Positional indices go stale the moment new mail lands mid-listing, so
    # anything addressed by content goes through here instead.
    if args.find:
        pat = re.compile(args.find, re.I)
        for r in rows:
            if not (pat.search(r["from"]) or pat.search(r["subject"])):
                continue
            typ, raw = client.fetch(r["mid"], "(RFC822)")
            if typ != "OK" or not raw or not isinstance(raw[0], tuple):
                continue
            msg = email.message_from_bytes(raw[0][1])
            print("\n" + "=" * 78)
            print(f"{r['date']}  {r['from']}\n{header(msg.get('Subject'))}")
            print("=" * 78)
            print(body_of(msg)[:4000])

    client.close()
    client.logout()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
