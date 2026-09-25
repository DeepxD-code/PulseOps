"""Network-policy tests for the daily job scraper.

DNS and HTTP are mocked throughout; these tests never make network requests.
"""
from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_core import scraper  # noqa: E402


def _public_dns(monkeypatch, address="93.184.216.34"):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        family = socket.AF_INET6 if ":" in str(address) else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, int(port or 443)))]

    monkeypatch.setattr(scraper.socket, "getaddrinfo", fake_getaddrinfo)


class FakeResponse:
    def __init__(self, status_code=200, headers=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text


def test_rejects_non_http_credentials_and_ip_literals():
    for value in (
        "file:///etc/passwd",
        "http://user:pass@example.com/",
        "http://127.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://2130706433/",
    ):
        with pytest.raises(scraper.UnsafeURLError):
            scraper.validate_public_http_url(value)


@pytest.mark.parametrize(
    "host",
    ["localhost", "service.local", "metadata.internal", "box.localhost"],
)
def test_rejects_local_hostnames_before_dns(host):
    with pytest.raises(scraper.UnsafeURLError):
        scraper.validate_public_http_url(f"https://{host}/")


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.8", "172.16.0.5", "192.168.1.4", "169.254.169.254", "::1"],
)
def test_rejects_any_non_public_dns_answer(monkeypatch, address):
    _public_dns(monkeypatch, address)
    with pytest.raises(scraper.UnsafeURLError):
        scraper.validate_public_http_url("https://jobs.example.org/role")


def test_safe_get_validates_redirect_hops(monkeypatch):
    _public_dns(monkeypatch)
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        if len(calls) == 1:
            return FakeResponse(302, {"Location": "https://private.example/job"})
        return FakeResponse(200, text="ok")

    monkeypatch.setattr(scraper.requests, "get", fake_get)

    def private_dns(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.20", int(port)))]

    original = scraper.socket.getaddrinfo
    state = {"first": True}

    def alternating_dns(host, port, *args, **kwargs):
        if state["first"]:
            state["first"] = False
            return original("jobs.example.org", port)
        return private_dns(host, port, *args, **kwargs)

    monkeypatch.setattr(scraper.socket, "getaddrinfo", alternating_dns)
    with pytest.raises(scraper.UnsafeURLError):
        scraper.safe_get("https://jobs.example.org/role")
    assert calls == [("https://jobs.example.org/role", {"allow_redirects": False, "timeout": 10})]


def test_safe_get_follows_bounded_public_redirects_once(monkeypatch):
    _public_dns(monkeypatch)
    responses = [
        FakeResponse(301, {"Location": "/final"}),
        FakeResponse(200, text="public"),
    ]
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return responses.pop(0)

    monkeypatch.setattr(scraper.requests, "get", fake_get)
    response = scraper.safe_get(
        "https://jobs.example.org/role",
        params={"q": "python"},
    )
    assert response.status_code == 200
    assert [call[0] for call in calls] == [
        "https://jobs.example.org/role",
        "https://jobs.example.org/final",
    ]
    assert "params" in calls[0][1]
    assert "params" not in calls[1][1]
    assert all(call[1]["allow_redirects"] is False for call in calls)


def test_trusted_api_allowlist_rejects_other_public_hosts(monkeypatch):
    _public_dns(monkeypatch)
    with pytest.raises(scraper.UnsafeURLError):
        scraper.validate_public_http_url(
            "https://api.theirstack.com/v1/jobs/search",
            allowed_hosts={"searchapi.io", "www.searchapi.io"},
            require_https=True,
        )


def test_safe_post_never_forwards_credentials_to_redirect(monkeypatch):
    _public_dns(monkeypatch)
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse(307, {"Location": "https://api.theirstack.com/elsewhere"})

    monkeypatch.setattr(scraper.requests, "post", fake_post)
    with pytest.raises(scraper.UnsafeURLError):
        scraper.safe_post(
            "https://api.theirstack.com/v1/jobs/search",
            headers={"Authorization": "Bearer secret"},
            allowed_hosts={"api.theirstack.com"},
            require_https=True,
        )
    assert len(calls) == 1
    assert calls[0][1]["allow_redirects"] is False


def test_linkedin_handoff_accepts_only_official_job_urls():
    assert scraper._is_linkedin_job_url("https://www.linkedin.com/jobs/view/123")
    assert scraper._is_linkedin_job_url("https://in.linkedin.com/jobs/view/123?x=1")
    assert not scraper._is_linkedin_job_url("http://www.linkedin.com/jobs/view/123")
    assert not scraper._is_linkedin_job_url("https://linkedin.com.evil.test/jobs/view/123")
    assert not scraper._is_linkedin_job_url("https://evil.test/jobs/view/123")
