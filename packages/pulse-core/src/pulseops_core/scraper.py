"""
core/scraper.py — Unified job sourcing engine (PulseOps Phase 3)

Sources:
  1. LinkedIn   — Node.js bridge (linkedin_bridge.js)
  2. Google Jobs — SearchApi.io REST API
  3. TheirStack  — POST /v1/jobs/search

Per spec:
  - Each source failure: logged, pipeline continues with remaining sources
  - Source failures tracked in source_health table
  - Non-negotiable #6: Telegram alert after 3 consecutive zero-result runs
  - RawJob standard fields: title, company, link, description, source,
                            posted_at, location_raw
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Collection
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests

from pulseops_core.exceptions import GoogleJobsError, LinkedInBridgeError, TheirStackError


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / ".git").exists():
            return p
    return here.parents[4]  # installed layout fallback: <root>/packages/pulse-core/src


ROOT = _repo_root()
# The bridge and its hand-off have one authoritative Tier-2 location.  The
# legacy root file is still cleaned up before every launch, but is never read:
# accepting it would make a failed/old root hand-off look like a fresh result.
LINKEDIN_BRIDGE = ROOT / "apps" / "weekly-scan" / "linkedin_bridge.js"
LINKEDIN_TEMP_JSON = ROOT / "apps" / "weekly-scan" / "temp_linkedin_jobs.json"
LEGACY_LINKEDIN_TEMP_JSON = ROOT / "temp_linkedin_jobs.json"
_BRIDGE_CANDIDATES = [LINKEDIN_BRIDGE, ROOT / "linkedin_bridge.js"]
_TEMP_CANDIDATES = [LINKEDIN_TEMP_JSON, LEGACY_LINKEDIN_TEMP_JSON]
_LINKEDIN_HANDOFF_MAX_AGE_BEFORE_LAUNCH = 0.05  # filesystem clock-resolution slack


class UnsafeURLError(ValueError):
    """Raised when an outbound URL fails the public-network policy."""


# Keep the public validator deliberately small and explicit.  It is used for
# both source API calls and job-page enrichment so there is one SSRF policy.
_ALLOWED_URL_SCHEMES = frozenset({"http", "https"})
_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})
_MAX_REDIRECTS = 5


def _normalise_hostname(host: str) -> str:
    """Return a DNS-safe, lower-case hostname without a trailing root dot."""
    if not isinstance(host, str) or not host or "%" in host:
        raise UnsafeURLError("URL has an invalid hostname")
    try:
        # IDNA normalisation catches look-alike local names such as
        # ``foo。local`` before they are handed to the resolver.
        normalised = host.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise UnsafeURLError("URL has an invalid hostname") from exc
    if not normalised or "\\" in normalised or any(ch.isspace() for ch in normalised):
        raise UnsafeURLError("URL has an invalid hostname")
    return normalised


def _is_ip_literal(host: str) -> bool:
    """Recognise IPv4/IPv6 literals, including common alternate IPv4 forms."""
    if ":" in host:
        # A colon cannot occur in a DNS hostname.  Treat malformed IPv6 and
        # zone-qualified literals as literals too, so they never reach DNS.
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass

    # ``ipaddress`` intentionally does not accept legacy decimal/octal/hex
    # IPv4 spellings, but requests/socket may.  Reject those spellings too.
    if re.fullmatch(r"[0-9]+|0[xX][0-9a-fA-F]+", host):
        return True
    try:
        socket.inet_aton(host)
    except (OSError, ValueError):
        return False
    return True


def _assert_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
    """Reject every address category that is not globally routable."""
    if (
        address.is_loopback
        or address.is_private
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
        or getattr(address, "is_site_local", False)
        or not address.is_global
    ):
        raise UnsafeURLError("URL host resolves to a non-public address")


def _resolve_and_validate_host(host: str, port: int | None) -> None:
    """Resolve *host* and reject the URL if any returned address is unsafe."""
    if _is_ip_literal(host):
        raise UnsafeURLError("IP literals are not allowed")

    try:
        # Use getaddrinfo rather than gethostbyname so IPv6 answers and every
        # returned address are checked.  Calling it with two arguments also
        # keeps this straightforward to mock in unit tests.
        answers = list(socket.getaddrinfo(host, port))
    except Exception as exc:
        raise UnsafeURLError("URL hostname could not be resolved") from exc

    if not answers:
        raise UnsafeURLError("URL hostname resolved to no addresses")

    for answer in answers:
        try:
            sockaddr = answer[4]
            raw_address = sockaddr[0]
            if isinstance(raw_address, bytes):
                raw_address = raw_address.decode("ascii")
            # IPv6 link-local answers can carry a scope identifier.  The
            # address itself is still rejected below.
            raw_address = str(raw_address).split("%", 1)[0]
            address = ipaddress.ip_address(raw_address)
        except (IndexError, TypeError, ValueError, UnicodeError) as exc:
            raise UnsafeURLError("URL hostname returned an invalid address") from exc
        _assert_public_address(address)


def _canonical_allowed_host(value: str) -> str:
    """Normalise an allowlist entry, accepting a hostname or a URL."""
    text = str(value).strip()
    if "://" in text or text.startswith("//"):
        parsed = urlsplit(text)
        text = parsed.hostname or ""
    return _normalise_hostname(text)


def validate_public_http_url(
    url: str,
    *,
    allowed_hosts: Collection[str] | None = None,
    require_https: bool = False,
) -> str:
    """Validate a URL for an outbound request and return it unchanged.

    Only HTTP(S) URLs with a public DNS destination are accepted.  Hostname
    resolution is performed here rather than relying on a string blocklist,
    and every caller-supplied allowlist is applied to the resolved hostname as
    well.  ``UnsafeURLError`` is a ``ValueError`` for easy fail-closed handling.
    """
    if not isinstance(url, str) or not url or url.strip() != url:
        raise UnsafeURLError("URL must be a non-empty string")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        raise UnsafeURLError("URL contains control characters")
    if "\\" in url:
        # Backslashes are interpreted inconsistently by URL parsers and can
        # turn an apparent public host into a different request target.
        raise UnsafeURLError("URL contains an unsafe backslash")

    try:
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise UnsafeURLError("URL is malformed") from exc

    if scheme not in _ALLOWED_URL_SCHEMES:
        raise UnsafeURLError("URL scheme is not HTTP or HTTPS")
    if require_https and scheme != "https":
        raise UnsafeURLError("URL must use HTTPS")
    if not host:
        raise UnsafeURLError("URL must include a hostname")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise UnsafeURLError("URL credentials are not allowed")
    if port is not None and not 1 <= port <= 65535:
        raise UnsafeURLError("URL has an invalid port")

    normalised_host = _normalise_hostname(host)
    local_names = {"localhost", "localhost.localdomain", "local", "internal"}
    if (
        normalised_host in local_names
        or normalised_host.endswith(".localhost")
        or normalised_host.endswith(".local")
        or normalised_host.endswith(".internal")
    ):
        raise UnsafeURLError("local and internal hostnames are not allowed")
    if _is_ip_literal(normalised_host):
        raise UnsafeURLError("IP literals are not allowed")

    if allowed_hosts is not None:
        candidates = [allowed_hosts] if isinstance(allowed_hosts, str) else allowed_hosts
        try:
            allowed = {_canonical_allowed_host(candidate) for candidate in candidates}
        except (TypeError, ValueError) as exc:
            raise UnsafeURLError("URL host allowlist is invalid") from exc
        if normalised_host not in allowed:
            raise UnsafeURLError("URL host is not trusted for this request")

    _resolve_and_validate_host(
        normalised_host,
        port if port is not None else (443 if scheme == "https" else 80),
    )
    return url


def is_public_http_url(url: str, **kwargs) -> bool:
    """Boolean convenience wrapper around :func:`validate_public_http_url`."""
    try:
        validate_public_http_url(url, **kwargs)
    except UnsafeURLError:
        return False
    return True


# A short alias is useful to callers that describe the policy simply as URL
# validation, while the explicit name remains the canonical public API.
validate_public_url = validate_public_http_url


def _response_location(response) -> str | None:
    headers = getattr(response, "headers", None)
    if headers is None or not hasattr(headers, "get"):
        return None
    location = headers.get("Location")
    if location is None:
        location = headers.get("location")
    if location is None:
        return None
    return str(location)


def _response_status(response) -> int | None:
    status = getattr(response, "status_code", None)
    if isinstance(status, bool):
        return None
    if isinstance(status, int):
        return status
    try:
        return int(status)
    except (TypeError, ValueError):
        return None


def safe_get(
    url: str,
    *,
    timeout: float = 10,
    headers: dict | None = None,
    params: dict | None = None,
    allowed_hosts: Collection[str] | None = None,
    require_https: bool = False,
    max_redirects: int = _MAX_REDIRECTS,
    **kwargs,
):
    """GET a validated public URL while validating every redirect manually.

    Automatic redirects are always disabled.  Each ``Location`` is resolved
    and checked before the next request, and the hop count is bounded.  A
    caller cannot opt back into automatic redirects through ``kwargs``.
    """
    if not isinstance(max_redirects, int) or isinstance(max_redirects, bool) or max_redirects < 0:
        raise ValueError("max_redirects must be a non-negative integer")
    max_redirects = min(max_redirects, _MAX_REDIRECTS)

    current_url = validate_public_http_url(
        url,
        allowed_hosts=allowed_hosts,
        require_https=require_https,
    )
    first_request = True
    redirects = 0

    while True:
        request_kwargs = dict(kwargs)
        request_kwargs["allow_redirects"] = False
        request_kwargs["timeout"] = timeout
        if first_request:
            if headers is not None:
                request_kwargs["headers"] = headers
            if params is not None:
                request_kwargs["params"] = params
        response = requests.get(current_url, **request_kwargs)

        status = _response_status(response)
        if status not in _REDIRECT_STATUS_CODES:
            return response
        location = _response_location(response)
        if not location:
            # Do not follow an ambiguous redirect.  The caller will handle the
            # non-success response as a source/base-description failure.
            return response
        if redirects >= max_redirects:
            raise UnsafeURLError("URL redirect limit exceeded")

        current_url = validate_public_http_url(
            urljoin(current_url, location),
            allowed_hosts=allowed_hosts,
            require_https=require_https,
        )
        redirects += 1
        first_request = False


def safe_post(
    url: str,
    *,
    allowed_hosts: Collection[str] | None = None,
    require_https: bool = False,
    **kwargs,
):
    """POST to a validated trusted endpoint without following redirects.

    Source APIs are POST endpoints (TheirStack in particular).  Redirects are
    rejected rather than replaying credentials or other sensitive request
    data to a location selected by the remote service.
    """
    current_url = validate_public_http_url(
        url,
        allowed_hosts=allowed_hosts,
        require_https=require_https,
    )
    request_kwargs = dict(kwargs)
    request_kwargs["allow_redirects"] = False
    response = requests.post(current_url, **request_kwargs)

    if _response_status(response) in _REDIRECT_STATUS_CODES:
        location = _response_location(response)
        if location:
            # Validate the advertised destination too, even though it will not
            # be followed; this keeps redirect handling fail-closed and clear.
            validate_public_http_url(
                urljoin(current_url, location),
                allowed_hosts=allowed_hosts,
                require_https=require_https,
            )
        raise UnsafeURLError("redirects are not allowed for this API request")
    return response


# Public aliases make the shared policy discoverable without coupling callers
# to private implementation names.
_safe_get = safe_get
_safe_post = safe_post


_GOOGLE_API_URL = "https://www.searchapi.io/api/v1/search"
_GOOGLE_API_HOSTS = frozenset({"www.searchapi.io", "searchapi.io"})
_THEIRSTACK_API_URL = "https://api.theirstack.com/v1/jobs/search"
_THEIRSTACK_API_HOSTS = frozenset({"api.theirstack.com"})


def _clear_linkedin_handoff(*, strict: bool = False) -> None:
    """Remove every known LinkedIn hand-off file.

    Deletion is deliberately done before the bridge is started.  ``strict`` is
    used for that pre-launch cleanup: if an old file cannot be removed, the
    bridge must not run at all because its output could be mistaken for the
    current run.  Cleanup after a failed run is best effort and is only for
    hygiene; the caller still fails closed.
    """
    paths: list[Path] = []
    for candidate in [LINKEDIN_TEMP_JSON, LEGACY_LINKEDIN_TEMP_JSON, *_TEMP_CANDIDATES]:
        path = Path(candidate)
        if path not in paths:
            paths.append(path)
    errors: list[str] = []
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            errors.append(f"{path}: {exc}")
    if errors and strict:
        raise LinkedInBridgeError(
            "Could not remove stale LinkedIn hand-off before launch: "
            + "; ".join(errors)
        )
    if errors:
        print("  [!] Could not fully clean LinkedIn hand-off: " + "; ".join(errors))

def _is_linkedin_job_url(value: str) -> bool:
    """Accept only official HTTPS LinkedIn job-view pages."""
    try:
        parsed = urlsplit(str(value or ""))
        host = _normalise_hostname(parsed.hostname or "")
    except (UnsafeURLError, ValueError):
        return False
    return (
        parsed.scheme.lower() == "https"
        and (host == "linkedin.com" or host.endswith(".linkedin.com"))
        and parsed.path.startswith("/jobs/view/")
        and parsed.username is None
        and parsed.password is None
    )


def _enrich_description(link: str, base_desc: str) -> str:
    """Keep source descriptions; do not fetch untrusted job pages.

    A hostname pre-check followed by a second resolver lookup in ``requests``
    is vulnerable to DNS rebinding. Until a DNS-pinned transport is available,
    dynamic job-page enrichment is disabled so listing-controlled URLs cannot
    become an SSRF or PII side channel.
    """
    return base_desc


class PulseOpsScraper:

    def __init__(self):
        try:
            self.max_age_days = int(os.getenv("POSTED_AT_MAX_AGE_DAYS", "7"))
        except ValueError:
            self.max_age_days = 7

    # ── LinkedIn (Node.js bridge) ─────────────────────────────────────────

    def fetch_linkedin(self) -> list[dict]:
        """Fetch LinkedIn jobs through a fresh, Tier-2-only hand-off.

        The Node sidecar writes ``apps/weekly-scan/temp_linkedin_jobs.json``.
        A root-level file is a legacy artifact and must never be used as a
        fallback.  The file is removed before launch, and is accepted only
        after a successful bridge exit and an mtime from this invocation.
        """
        # Do this even when the bridge is unavailable: leaving a tempting old
        # file around is worse than returning an empty source for this run.
        _clear_linkedin_handoff(strict=True)

        bridge = next((Path(p) for p in _BRIDGE_CANDIDATES if Path(p).exists()), None)
        if not bridge:
            print("  [!] linkedin_bridge.js not found — skipping LinkedIn source")
            return []

        # Never select an existing root/Tier-2 path.  The bridge contract is
        # fixed to the Tier-2 output, regardless of which compatibility bridge
        # executable was found.
        temp_json = LINKEDIN_TEMP_JSON
        launched_at = time.time()

        try:
            import shutil
            node_bin = shutil.which("node") or (
                r"C:\Program Files\nodejs\node.exe"
                if sys.platform.startswith("win") else "node"
            )
            result = subprocess.run(
                [node_bin, str(bridge)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=os.environ.copy(),
                timeout=30,
            )
            if result.returncode != 0:
                stderr = str(getattr(result, "stderr", "") or "").strip()
                raise LinkedInBridgeError(
                    f"Node bridge exit {result.returncode}: {stderr[:200]}"
                )

            # Check the exact Tier-2 path only.  In particular, do not fall
            # back to LEGACY_LINKEDIN_TEMP_JSON when this file is absent.
            if not temp_json.is_file():
                raise LinkedInBridgeError(
                    "Bridge did not produce the Tier-2 temp_linkedin_jobs.json"
                )

            try:
                mtime = temp_json.stat().st_mtime
            except OSError as exc:
                raise LinkedInBridgeError(
                    f"Could not stat Tier-2 LinkedIn hand-off: {exc}"
                ) from exc
            if mtime < launched_at - _LINKEDIN_HANDOFF_MAX_AGE_BEFORE_LAUNCH:
                raise LinkedInBridgeError(
                    "Tier-2 LinkedIn hand-off is stale (not written by this bridge run)"
                )

            try:
                raw = json.loads(temp_json.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise LinkedInBridgeError(
                    f"Could not parse Tier-2 LinkedIn hand-off: {exc}"
                ) from exc
        except LinkedInBridgeError:
            _clear_linkedin_handoff(strict=False)
            raise
        except subprocess.TimeoutExpired as exc:
            _clear_linkedin_handoff(strict=False)
            raise LinkedInBridgeError("LinkedIn bridge timed out after 30 seconds") from exc
        except Exception as exc:
            _clear_linkedin_handoff(strict=False)
            raise LinkedInBridgeError(f"LinkedIn bridge failed: {exc}") from exc
        finally:
            # The hand-off is a transport, not a durable cache.  Remove it
            # after the exact file has been consumed, including on parse or
            # process failures handled above.
            _clear_linkedin_handoff(strict=False)

        jobs = []
        for item in (raw if isinstance(raw, list) else []):
            if not isinstance(item, dict):
                continue
            link = str(item.get("jobUrl") or "")
            if not _is_linkedin_job_url(link):
                print("  [!] linkedin_bridge returned a non-job/untrusted URL — skipping")
                continue
            base = f"LinkedIn listing: {item.get('company','')} in {item.get('location','India')}."
            jobs.append({
                "title":       item.get("position", "Untitled"),
                "company":     item.get("company", "Unknown"),
                "link":        link,
                "description": _enrich_description(link, base),
                "source":      "LinkedIn",
                "posted_at":   item.get("date", ""),
                "location_raw": item.get("location", ""),
            })
        return jobs

    # ── Google Jobs (SearchApi.io) ────────────────────────────────────────

    def fetch_google_jobs(self) -> list[dict]:
        api_key  = os.getenv("SEARCHAPI_API_KEY", "")
        query    = os.getenv("JOB_SEARCH_QUERY", "backend engineer intern").strip("\"'")
        location = os.getenv("JOB_LOCATION", "India")

        if not api_key:
            print("  [!] SEARCHAPI_API_KEY not set — skipping Google Jobs")
            return []

        variants = [query]
        if "intern" in query.lower():
            variants += [
                f"{query} Bangalore", f"{query} Hyderabad",
                "backend engineer intern India", "software engineer intern new grad India",
                "AI engineer intern India", "machine learning intern India",
                "generative AI intern India", "software engineer intern backend AI",
            ]
        variants = list(dict.fromkeys(variants))

        all_jobs, seen = [], set()
        for q in variants[:6]:
            try:
                resp = safe_get(
                    _GOOGLE_API_URL,
                    params={"engine": "google_jobs", "q": q,
                            "location": location, "api_key": api_key},
                    timeout=20,
                    allowed_hosts=_GOOGLE_API_HOSTS,
                    require_https=True,
                )
                if resp.status_code != 200:
                    raise GoogleJobsError(
                        f"SearchApi HTTP {resp.status_code} for '{q}': "
                        f"{resp.text[:200]}"
                    )
                for item in resp.json().get("jobs", []):
                    if not isinstance(item, dict):
                        continue
                    link = (
                        item.get("apply_link") or
                        (item.get("apply_links") or [{}])[0].get("link", "") or
                        item.get("link", "")
                    )
                    title   = item.get("title", "Untitled")
                    company = item.get("company_name", "Unknown")
                    key = (title.lower().strip(), company.lower().strip())
                    if key in seen:
                        continue
                    seen.add(key)
                    all_jobs.append({
                        "title":        title,
                        "company":      company,
                        "link":         link,
                        "description":  _enrich_description(link, item.get("description", "")),
                        "source":       "Google Jobs",
                        "posted_at":    item.get("detected_extensions", {}).get("posted_at", ""),
                        "location_raw": item.get("location", ""),
                    })
            except GoogleJobsError:
                raise
            except Exception as e:
                raise GoogleJobsError(f"Google Jobs query '{q}' failed: {e}") from e

        return all_jobs

    # ── TheirStack ────────────────────────────────────────────────────────

    def fetch_theirstack(self) -> list[dict]:
        api_key = os.getenv("THEIRSTACK_API_KEY", "")
        if not api_key:
            print("  [!] THEIRSTACK_API_KEY not set — skipping TheirStack")
            return []

        query        = os.getenv("JOB_SEARCH_QUERY", "backend intern").strip("\"'")
        country_code = os.getenv("THEIRSTACK_COUNTRY_CODE", "IN")
        posted_since = (datetime.utcnow() - timedelta(days=self.max_age_days)).strftime("%Y-%m-%d")

        titles = [query]
        if "intern" in query.lower():
            titles += [
                "backend engineer intern", "software engineer intern",
                "systems engineer intern", "platform engineer intern",
                "AI engineer intern", "machine learning intern",
                "generative AI intern", "data engineer intern",
            ]
        titles = list(dict.fromkeys(t.lower() for t in titles))

        try:
            resp = safe_post(
                _THEIRSTACK_API_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type":  "application/json",
                },
                json={
                    "job_title_or":        titles,
                    "posted_at_gte":       posted_since,
                    "job_country_code_or": [country_code],
                    "limit":               25,  # free plan caps at 25/page (E-020)
                    "order_by": [{"desc": True, "field": "date_posted"}],
                },
                timeout=20,
                allowed_hosts=_THEIRSTACK_API_HOSTS,
                require_https=True,
            )
            if resp.status_code != 200:
                raise TheirStackError(
                    f"TheirStack HTTP {resp.status_code}: {resp.text[:200]}"
                )
            jobs = []
            for item in resp.json().get("data", []):
                link = item.get("url", "")
                jobs.append({
                    "title":        item.get("job_title", "Untitled"),
                    "company":      item.get("company_object", {}).get("name", "Unknown"),
                    "link":         link,
                    "description":  _enrich_description(link, item.get("short_description", "")),
                    "source":       "TheirStack",
                    "posted_at":    item.get("date_posted", ""),
                    "location_raw": item.get("location", ""),
                })
            return jobs

        except TheirStackError:
            raise
        except Exception as e:
            raise TheirStackError(f"TheirStack failed: {e}") from e

    # ── Mock (simulation / fallback) ──────────────────────────────────────

    def get_mock_listings(self) -> list[dict]:
        return [
            {
                "title":        "Backend Intern (Java/Spring Boot)",
                "company":      "Vercel",
                "link":         "https://vercel.com/careers/backend-intern",
                "description":  (
                    "Backend intern role at Vercel. Java, Spring Boot, gRPC, "
                    "PostgreSQL, Redis, Kubernetes, Docker. Strong systems "
                    "background preferred. Apply: hr@vercel.com"
                ),
                "source":       "Mock",
                "posted_at":    datetime.now().strftime("%Y-%m-%d"),
                "location_raw": "Remote / Bangalore",
            },
            {
                "title":        "Software Engineer Intern (Go/Python)",
                "company":      "Stripe",
                "link":         "https://stripe.com/careers/swe-intern",
                "description":  (
                    "SWE intern at Stripe payments infra. Python, Go, "
                    "distributed systems, Kafka, Redis, PostgreSQL. "
                    "New grad welcome. careers@stripe.com"
                ),
                "source":       "Mock",
                "posted_at":    datetime.now().strftime("%Y-%m-%d"),
                "location_raw": "Bangalore",
            },
            {
                "title":        "Platform Engineer Intern",
                "company":      "Notion",
                "link":         "https://notion.so/careers/platform-intern",
                "description":  (
                    "Platform/infra intern at Notion. Go, Kubernetes, "
                    "Terraform, Docker, AWS, CI/CD pipelines. "
                    "jobs@notion.so"
                ),
                "source":       "Mock",
                "posted_at":    datetime.now().strftime("%Y-%m-%d"),
                "location_raw": "Hyderabad / Remote",
            },
            {
                "title":        "Senior Frontend Developer",
                "company":      "Meta",
                "link":         "https://meta.com/careers/senior-fe",
                "description":  (
                    "Senior React developer at Meta. 5+ years. "
                    "Angular, Vue, TypeScript, CSS, Figma. "
                    "Must be senior level."
                ),
                "source":       "Mock",
                "posted_at":    datetime.now().strftime("%Y-%m-%d"),
                "location_raw": "Remote",
            },
            {
                "title":        "C++ Systems Engineer Intern",
                "company":      "Jane Street",
                "link":         "https://janestreet.com/careers/cpp-intern",
                "description":  (
                    "Low-latency C++ systems intern at Jane Street. "
                    "C++17, Linux, networking, memory management. "
                    "campus@janestreet.com"
                ),
                "source":       "Mock",
                "posted_at":    datetime.now().strftime("%Y-%m-%d"),
                "location_raw": "Mumbai / Remote",
            },
        ]
