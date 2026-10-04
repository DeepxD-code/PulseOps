"""
github/github_sync.py — GitHub → LLM → SAR bullet → cv_candidate memory
(PulseOps Phase 3 / Phase 0 of the daily pipeline)

Adapted from PulseMatch AI's github_sync.py, but with one critical change:
PulseMatch wrote bullets directly into resume.txt. PulseOps NEVER does that
(Non-negotiable #1: cv.md is the only file a human ever edits. Non-negotiable
#4: memory never auto-modifies cv.md — flags cv_candidates only).

Instead, every new project bullet is written as a `project` category memory
with cv_candidate=True. It surfaces via:
    python doctor.py --apply-memories
    python memory.py pending

Flow:
  1. Fetch the user's public repos (api.github.com, unauthenticated is fine
     for a handful of repos/day — set GITHUB_TOKEN to raise the rate limit).
  2. Skip forks, archived repos, and repos with no README.
  3. For up to `max_repos` candidates, generate one SAR-format bullet via the
     Gemini → Groq cascade (keyword fallback if no keys / both fail).
  4. Skip repos already flagged in a previous run (tracked in
     memory/.github_synced.json) so the same project isn't re-flagged daily.
  5. Write each new bullet as a flagged memory. Never touches cv.md.

Returns (ok: bool, message: str) — never raises; main.py treats failures
here as non-fatal (Phase 0 is best-effort).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SYNCED_STATE_PATH = ROOT / "memory" / ".github_synced.json"

BANNED_WORDS = [
    "spearheaded", "passionate", "synergy", "dynamic", "utilized",
    "leveraging", "streamline", "innovative", "orchestrated", "pioneered",
    "game-changer", "proven track record",
]


def _read_synced() -> set[str]:
    if SYNCED_STATE_PATH.exists():
        try:
            return set(json.loads(SYNCED_STATE_PATH.read_text(encoding="utf-8")))
        except Exception:
            return set()
    return set()


def _write_synced(synced: set[str]) -> None:
    SYNCED_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SYNCED_STATE_PATH.write_text(json.dumps(sorted(synced)), encoding="utf-8")


def _gh_headers() -> dict:
    token = os.getenv("GITHUB_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_repos(username: str, per_page: int = 10) -> list[dict]:
    url = f"https://api.github.com/users/{username}/repos"
    resp = requests.get(
        url, headers=_gh_headers(),
        params={"sort": "updated", "per_page": per_page}, timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"GitHub API HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def fetch_readme(username: str, repo: str) -> str:
    for branch in ("main", "master"):
        url = f"https://raw.githubusercontent.com/{username}/{repo}/{branch}/README.md"
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                return r.text
        except Exception:
            pass
    return ""


def _strip_banned(text: str) -> str:
    for w in BANNED_WORDS:
        text = re.sub(re.escape(w), "", text, flags=re.IGNORECASE)
    return re.sub(r"\s{2,}", " ", text).strip()


def _keyword_bullet(repo_name: str, description: str, language: str) -> str:
    verb = "Engineered" if language and language.lower() in (
        "python", "go", "java", "c++", "rust") else "Developed"
    desc = description.strip() if description else f"a {language or 'software'} project"
    return f"- {verb} {repo_name}, {desc[:140].rstrip('.')} using {language or 'modern tooling'}."


def _llm_bullet(readme_content: str, repo_name: str, language: str) -> str | None:
    prompt = (
        "You are an expert resume writer. Here is the README of a developer's "
        f"GitHub project named '{repo_name}' (primary language: {language or 'unknown'}):\n\n"
        f"--- README ---\n{readme_content[:3000]}\n\n"
        "Generate exactly ONE high-impact, professional resume bullet point "
        "summarizing this project. Use SAR format (Situation-Action-Result): "
        "start with a strong active verb (Engineered, Developed, Optimized, Built, "
        "Implemented, Designed, Reduced), focus on the technical stack, and add a "
        "realistic metric or quantitative result. Avoid these banned words: "
        f"{', '.join(BANNED_WORDS)}. Under 220 characters. "
        "Return ONLY the bullet text starting with '- '. No markdown, no preamble."
    )

    gemini_key = os.getenv("GEMINI_API_KEY", "")
    if gemini_key:
        try:
            from google import genai
            from google.genai import types
            # Bounded: genai.Client has no default request timeout, so one
            # unresponsive provider parked the whole process indefinitely.
            client = genai.Client(
                api_key=gemini_key,
                http_options=types.HttpOptions(timeout=60000),
            )
            resp = client.models.generate_content(
                model="gemini-flash-lite-latest", contents=prompt,
            )
            text = (resp.text or "").strip()
            if text:
                return _strip_banned(text)
        except Exception as e:
            print(f"  [GitHubSync] Gemini failed for {repo_name}: {e}")

    groq_key = os.getenv("GROQ_API_KEY", "") or os.getenv("XAI_API_KEY", "")
    if groq_key:
        try:
            from groq import Groq
            client = Groq(api_key=groq_key)
            resp = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2, timeout=20,
            )
            text = (resp.choices[0].message.content or "").strip()
            if text:
                return _strip_banned(text)
        except Exception as e:
            print(f"  [GitHubSync] Groq failed for {repo_name}: {e}")

    return None


def sync_github(username: str, max_repos: int = 3) -> tuple[bool, str]:
    """
    Fetch top repos for `username`, generate SAR bullets, flag as
    cv_candidate memories. Never writes cv.md. Idempotent across runs —
    a repo already flagged previously is skipped (tracked in
    memory/.github_synced.json) unless its README has materially changed.
    """
    if not username:
        return False, "No GITHUB_USERNAME configured."

    try:
        from pulseops_store.db_manager import add_memory
    except Exception as e:
        return False, f"Could not import db_manager: {e}"

    try:
        repos = fetch_repos(username)
    except Exception as e:
        return False, f"Failed to fetch repositories for '{username}': {e}"

    if not isinstance(repos, list):
        return False, "Unexpected GitHub API response (rate-limited or invalid username?)"

    synced = _read_synced()
    flagged = []

    for repo in repos:
        if not isinstance(repo, dict):
            continue
        if repo.get("fork") or repo.get("archived"):
            continue

        name = repo.get("name", "")
        if not name or name in synced:
            continue

        readme = fetch_readme(username, name)
        if not readme.strip():
            continue

        print(f"  [GitHubSync] Processing {name}...")
        language = repo.get("language", "") or ""

        bullet = _llm_bullet(readme, name, language)
        engine = "llm"
        if not bullet:
            bullet = _keyword_bullet(name, repo.get("description", "") or "", language)
            engine = "keyword_fallback"

        add_memory(
            category="project",
            raw_text=f"[GitHub Sync] {name}: {bullet}",
            parsed={
                "repo": name,
                "bullet": bullet,
                "language": language,
                "url": repo.get("html_url", ""),
                "stars": repo.get("stargazers_count", 0),
                "engine": engine,
                "skills": [language] if language else [],
            },
            action="flag_cv_candidate",
            cv_candidate=True,
        )
        synced.add(name)
        flagged.append(name)

        if len(flagged) >= max_repos:
            break

    _write_synced(synced)

    if not flagged:
        return True, "No new repositories to sync (all up to date or no qualifying READMEs)."

    return True, (
        f"Flagged {len(flagged)} project bullet(s) as cv_candidates: "
        f"{', '.join(flagged)}. Review with: python doctor.py --apply-memories"
    )
