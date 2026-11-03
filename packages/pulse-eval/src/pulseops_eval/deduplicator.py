"""
evaluation/deduplicator.py — Fuzzy semantic dedup (PulseOps Phase 3)

Two jobs from different sources are treated as the same if ALL of:
  1. normalise_company(a) Levenshtein distance <= 2 from normalise_company(b)
  2. title token overlap >= 70% (intersection/union of lowercase word sets)
  3. posted within 48 hours of each other (or either unknown)

Priority (keep highest quality source):
  TheirStack > Google Jobs > LinkedIn > Mock

Also deduplicates against already-processed jobs in the DB.
"""

from __future__ import annotations

from datetime import datetime

from pulseops_store.db_manager import is_job_processed, normalise_company

SOURCE_PRIORITY = {"TheirStack": 3, "Google Jobs": 2, "LinkedIn": 1, "Mock": 0}


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(prev[j] + (0 if ca == cb else 1),
                            curr[j] + 1, prev[j + 1] + 1))
        prev = curr
    return prev[-1]


def _title_overlap(t1: str, t2: str) -> float:
    w1 = set(t1.lower().split())
    w2 = set(t2.lower().split())
    union = w1 | w2
    if not union:
        return 0.0
    return len(w1 & w2) / len(union)


def _within_48h(p1: str, p2: str) -> bool:
    """Returns True if dates are within 48h OR if either is unknown."""
    if not p1 or not p2:
        return True
    try:
        d1 = datetime.fromisoformat(p1[:10])
        d2 = datetime.fromisoformat(p2[:10])
        return abs((d1 - d2).days) <= 2
    except ValueError:
        return True


def _company_known(name: str) -> bool:
    """False for the placeholders boards emit when they cannot read the employer."""
    return normalise_company(name) not in {"", "unknown", "n/a", "na", "-", "none"}


def _is_same_job(a: dict, b: dict) -> bool:
    # Fuzzy matching needs an employer to compare. With "Unknown" on both sides
    # the Levenshtein distance is 0, so every pair of same-titled listings at
    # unrelated companies collapsed into one job.
    if not _company_known(a.get("company", "")) or not _company_known(b.get("company", "")):
        return False
    norm_a = normalise_company(a.get("company", ""))
    norm_b = normalise_company(b.get("company", ""))
    if _levenshtein(norm_a, norm_b) > 2:
        return False
    if _title_overlap(a.get("title", ""), b.get("title", "")) < 0.70:
        return False
    if not _within_48h(a.get("posted_at", ""), b.get("posted_at", "")):
        return False
    return True


def _source_rank(job: dict) -> int:
    return SOURCE_PRIORITY.get(job.get("source", ""), 0)


def deduplicate(jobs: list[dict], run_id: str = "") -> list[dict]:
    """
    1. Exact dedup by link (same URL → drop lower-priority source).
    2. Exact dedup by (title.lower(), company.lower()).
    3. Fuzzy dedup: Levenshtein + title overlap + 48h window.
    4. Filter already processed by DB.
    Returns deduplicated list, preserving highest-quality source per group.
    """
    # Step 1 & 2: exact dedup within batch
    seen_links: dict[str, int] = {}   # link → index in `kept`
    seen_exact: dict[tuple, int] = {} # (title, company) → index
    kept: list[dict] = []

    for job in jobs:
        link = (job.get("link") or "").strip().lower()
        exact_key = (job.get("title", "").lower().strip(),
                     normalise_company(job.get("company", "")))

        # Exact link match
        if link and link in seen_links:
            idx = seen_links[link]
            if _source_rank(job) > _source_rank(kept[idx]):
                kept[idx] = job
            continue

        # Exact title+company match — only when the employer is known, otherwise
        # two different companies' identically-titled roles are collapsed.
        if _company_known(job.get("company", "")) and exact_key in seen_exact:
            idx = seen_exact[exact_key]
            if _source_rank(job) > _source_rank(kept[idx]):
                kept[idx] = job
            continue

        # New entry
        idx = len(kept)
        kept.append(job)
        if link:
            seen_links[link] = idx
        if _company_known(job.get("company", "")):
            seen_exact[exact_key] = idx

    # Step 3: fuzzy dedup across kept list
    final: list[dict] = []
    for job in kept:
        duplicate = False
        for i, existing in enumerate(final):
            if _is_same_job(job, existing):
                if _source_rank(job) > _source_rank(existing):
                    final[i] = job
                duplicate = True
                break
        if not duplicate:
            final.append(job)

    # Step 4: filter already processed in DB
    result = []
    for job in final:
        if is_job_processed(
            job.get("title", ""),
            job.get("company", ""),
            job.get("link", ""),
        ):
            continue
        result.append(job)

    return result
