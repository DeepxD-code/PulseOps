"""Focused SSRF and redirect-safety tests for the Python scraper."""
from __future__ import annotations

import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pulse-core" / "src"))

from pulseops_core import scraper as scraper_module  # noqa: E402


def _dns(monkeypatch, mapping: dict[str, list[str]]) -> None:
    def fake_getaddrinfo(host, port, *args, **kwargs):
        addresses = mapping.get(host.rstrip(".").lower())
        if not addresses:
            raise socket.gaierror("test hostname is not mapped")
        family = socket.AF_INET6 if ":" in addresses[0] else socket.AF_INET
        return [
            (family, socket.SOCK_STREAM, 6, "", (address, port or 0))
            for address in addresses
        ]

    monkeypatch.setattr(scraper_module.socket, "getaddrinfo", fake_getaddrinfo)


def _response(status_code: int, *, location: str | None = None, text: str = "") -> SimpleNamespace:
    headers = {"Location": location} if location is not None else {}
    return SimpleNamespace(status_code=status_code, headers=headers, text=text)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/jobs",
        "https://service.local/jobs",
        "https://service.internal/jobs",
        "https://internal/jobs",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.7/jobs",
        "http://[::1]/jobs",
        "https://user:password@jobs.example.com/listing",
        "file:///etc/passwd",
    ],
)
def test_public_url_validator_rejects_unsafe_destinations(url, monkeypatch):
    monkeypatch.setattr(
        scraper_module.socket,
        "getaddrinfo",
        lambda *args, **kwargs: pytest.fail("unsafe URL must be rejected before DNS"),
    )

    with pytest.raises(scraper_module.UnsafeURLError):
        scraper_module.validate_public_http_url(url)


def test_dns_answer_must_be_public(monkeypatch):
    _dns(monkeypatch, {"private.example": ["192.168.1.20"]})

    with pytest.raises(scraper_module.UnsafeURLError, match="non-public"):
        scraper_module.validate_public_http_url("https://private.example/jobs")


def test_safe_public_get_disables_automatic_redirects(monkeypatch):
    _dns(monkeypatch, {"jobs.example": ["93.184.216.34"]})
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return _response(200, text="public page" * 100)

    monkeypatch.setattr(scraper_module.requests, "get", fake_get)

    response = scraper_module.safe_get("https://jobs.example/listing")

    assert response.status_code == 200
    assert calls == [
        (
            "https://jobs.example/listing",
            {
                "allow_redirects": False,
                "timeout": 10,
            },
        )
    ]


def test_redirect_to_private_dns_name_is_rejected_before_second_request(monkeypatch):
    _dns(
        monkeypatch,
        {
            "public.example": ["93.184.216.34"],
            "private.example": ["10.0.0.7"],
        },
    )
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return _response(302, location="https://private.example/secret")

    monkeypatch.setattr(scraper_module.requests, "get", fake_get)

    with pytest.raises(scraper_module.UnsafeURLError):
        scraper_module.safe_get("https://public.example/start")

    assert [url for url, _ in calls] == ["https://public.example/start"]
    assert calls[0][1]["allow_redirects"] is False


def test_safe_get_caps_redirects(monkeypatch):
    _dns(monkeypatch, {"redirect.example": ["93.184.216.34"]})
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _response(302, location="/next")

    monkeypatch.setattr(scraper_module.requests, "get", fake_get)

    with pytest.raises(scraper_module.UnsafeURLError, match="redirect limit"):
        scraper_module.safe_get("https://redirect.example/start", max_redirects=2)

    assert len(calls) == 3


def test_enrichment_fails_closed_to_base_description(monkeypatch):
    monkeypatch.setattr(
        scraper_module.requests,
        "get",
        lambda *args, **kwargs: pytest.fail("unsafe enrichment URL must not be requested"),
    )

    base = "source description"
    assert scraper_module._enrich_description("http://169.254.169.254/", base) == base


def test_http_job_enrichment_falls_back_without_request(monkeypatch):
    monkeypatch.setattr(
        scraper_module.requests,
        "get",
        lambda *args, **kwargs: pytest.fail("HTTP enrichment must not be requested"),
    )

    base = "source description"
    assert scraper_module._enrich_description("http://jobs.example.org/listing", base) == base


def test_https_job_enrichment_is_disabled_until_dns_pinning(monkeypatch):
    monkeypatch.setattr(
        scraper_module,
        "safe_get",
        lambda *args, **kwargs: pytest.fail("dynamic job-page enrichment must not request"),
    )
    base = "source description"
    assert scraper_module._enrich_description("https://jobs.example.org/listing", base) == base


def test_trusted_api_url_cannot_change_host_or_scheme(monkeypatch):
    monkeypatch.setattr(
        scraper_module.socket,
        "getaddrinfo",
        lambda *args, **kwargs: pytest.fail("untrusted host must fail before DNS"),
    )

    with pytest.raises(scraper_module.UnsafeURLError):
        scraper_module.validate_public_http_url(
            "https://evil.example/api",
            allowed_hosts=scraper_module._GOOGLE_API_HOSTS,
            require_https=True,
        )
    with pytest.raises(scraper_module.UnsafeURLError):
        scraper_module.validate_public_http_url(
            "http://www.searchapi.io/api",
            allowed_hosts=scraper_module._GOOGLE_API_HOSTS,
            require_https=True,
        )
