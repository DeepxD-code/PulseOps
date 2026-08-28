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

import json
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

import requests

from exceptions import GoogleJobsError, LinkedInBridgeError, TheirStackError

ROOT = Path(__file__).resolve().parent.parent


class PulseOpsScraper:

    def __init__(self):
        try:
            self.max_age_days = int(os.getenv("POSTED_AT_MAX_AGE_DAYS", "7"))
        except ValueError:
            self.max_age_days = 7

    # ── LinkedIn (Node.js bridge) ─────────────────────────────────────────

    def fetch_linkedin(self) -> list[dict]:
        bridge    = ROOT / "linkedin_bridge.js"
        temp_json = ROOT / "temp_linkedin_jobs.json"

        if not bridge.exists():
            print("  [!] linkedin_bridge.js not found — skipping LinkedIn source")
            return []

        try:
            result = subprocess.run(
                ["node", str(bridge)],
                capture_output=True, text=True,
                env=os.environ.copy(), timeout=30,
            )
            if result.returncode != 0:
                raise LinkedInBridgeError(
                    f"Node bridge exit {result.returncode}: "
                    f"{result.stderr.strip()[:200]}"
                )

            if not temp_json.exists():
                raise LinkedInBridgeError("Bridge did not produce temp_linkedin_jobs.json")

            raw = json.loads(temp_json.read_text(encoding="utf-8"))
            try:
                temp_json.unlink()
            except OSError:
                pass

            jobs = []
            for item in (raw if isinstance(raw, list) else []):
                if not isinstance(item, dict):
                    continue
                jobs.append({
                    "title":       item.get("position", "Untitled"),
                    "company":     item.get("company", "Unknown"),
                    "link":        item.get("jobUrl", ""),
                    "description": (
                        f"LinkedIn listing: {item.get('company','')} "
                        f"in {item.get('location','India')}."
                    ),
                    "source":      "LinkedIn",
                    "posted_at":   item.get("date", ""),
                    "location_raw": item.get("location", ""),
                })
            return jobs

        except LinkedInBridgeError:
            raise
        except Exception as e:
            raise LinkedInBridgeError(f"LinkedIn bridge failed: {e}") from e

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
                resp = requests.get(
                    "https://www.searchapi.io/api/v1/search",
                    params={"engine": "google_jobs", "q": q,
                            "location": location, "api_key": api_key},
                    timeout=20,
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
                        "description":  item.get("description", ""),
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
            resp = requests.post(
                "https://api.theirstack.com/v1/jobs/search",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type":  "application/json",
                },
                json={
                    "job_title_or":        titles,
                    "posted_at_gte":       posted_since,
                    "job_country_code_or": [country_code],
                    "limit":               50,
                    "order_by": [{"desc": True, "field": "date_posted"}],
                },
                timeout=20,
            )
            if resp.status_code != 200:
                raise TheirStackError(
                    f"TheirStack HTTP {resp.status_code}: {resp.text[:200]}"
                )
            jobs = []
            for item in resp.json().get("data", []):
                jobs.append({
                    "title":        item.get("job_title", "Untitled"),
                    "company":      item.get("company_object", {}).get("name", "Unknown"),
                    "link":         item.get("url", ""),
                    "description":  item.get("short_description", ""),
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
