"""Check whether the configured mail credentials can read the inbox over IMAP.

Sending mail over SMTP does not imply the same credentials can read it: Gmail
requires an app password for IMAP, and refuses an ordinary account password.
This answers that question directly instead of assuming, so the OTP watcher is
only built on a transport that actually works.

Run: python -m pulseops_core.imap_check
"""
from __future__ import annotations

import imaplib
import os
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for name in (".env", ROOT / ".env"):
        path = Path(name)
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
        break
    return env


def main() -> int:
    env = _load_env()
    user = env.get("SMTP_EMAIL") or os.environ.get("SMTP_EMAIL", "")
    password = env.get("SMTP_PASSWORD") or os.environ.get("SMTP_PASSWORD", "")
    if not user or not password:
        print("IMAP: no SMTP_EMAIL/SMTP_PASSWORD configured")
        return 2

    print(f"IMAP: testing {user} (password length {len(password)})")
    try:
        client = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
    except Exception as exc:  # noqa: BLE001
        print(f"IMAP: cannot reach imap.gmail.com — {exc}")
        return 3

    try:
        result = client.login(user, password)
        # imaplib returns (typ, data); be tolerant of a bare string.
        status = result[0] if isinstance(result, tuple) else result
        code = status.decode(errors="replace") if isinstance(status, bytes) else str(status)
        print(f"IMAP: login {code}")
        if code.upper() != "OK":
            print("IMAP: credentials rejected — an app password is required for Gmail")
            return 4
        client.select("INBOX", readonly=True)
        status, data = client.search(None, "ALL")
        status_code = status.decode(errors="replace") if isinstance(status, bytes) else str(status)
        if status_code.upper() == "OK" and data and data[0]:
            print(f"IMAP: readable — {len(data[0].split())} message(s) in INBOX")
        else:
            print("IMAP: readable — INBOX is empty")
        return 0
    except imaplib.IMAP4.error as exc:
        print(f"IMAP: login failed — {exc}")
        print("IMAP: Gmail needs an app password (16 chars) for IMAP access.")
        return 4
    finally:
        try:
            client.logout()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
