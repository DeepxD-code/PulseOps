"""Discord webhook response semantics."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-notify" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_notify import discord  # noqa: E402


class Response:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("empty body")
        return self._payload


def test_webhook_204_is_success_without_json_body(monkeypatch):
    monkeypatch.setattr(
        discord.requests,
        "post",
        lambda *args, **kwargs: Response(204),
    )
    assert discord._post_webhook("123", "token", {"content": "test"}) == {}


def test_webhook_200_json_is_success(monkeypatch):
    monkeypatch.setattr(
        discord.requests,
        "post",
        lambda *args, **kwargs: Response(200, {"id": "message-id"}),
    )
    assert discord._post_webhook("123", "token", {"content": "test"}) == {
        "id": "message-id"
    }
