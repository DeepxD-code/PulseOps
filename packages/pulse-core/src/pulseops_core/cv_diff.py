"""
core/cv_diff.py — CV snapshot + diff system (PulseOps Phase 2)

Every time cv.md changes:
  1. Saves a dated snapshot to memory/cv_history/cv_YYYY-MM-DD.md
  2. Appends a diff entry to memory/cv_history/cv_changelog.jsonl
  3. Returns a CVDiff object so profile_builder can do incremental resync

Non-negotiable #7: profile.yml is always generated from cv.md, never manually edited.
Non-negotiable #1: cv.md is the only file a human ever edits.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from pulseops_core.exceptions import CVParseError

def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here, *here.parents):
        if (candidate / ".git").exists():
            return candidate
    return here.parents[4]


ROOT        = _repo_root()
CV_PATH     = ROOT / "cv.md"
HISTORY_DIR = ROOT / "memory" / "cv_history"
CHANGELOG   = HISTORY_DIR / "cv_changelog.jsonl"
HASH_FILE   = ROOT / "config" / ".cv_hash"


@dataclass
class CVDiff:
    has_changes: bool
    old_hash: str
    new_hash: str
    snapshot_path: str = ""
    added_lines: list[str] = field(default_factory=list)
    removed_lines: list[str] = field(default_factory=list)
    changed_sections: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if not self.has_changes:
            return "No changes"
        parts = []
        if self.added_lines:
            parts.append(f"+{len(self.added_lines)} lines")
        if self.removed_lines:
            parts.append(f"-{len(self.removed_lines)} lines")
        if self.changed_sections:
            parts.append(f"sections: {', '.join(self.changed_sections)}")
        return "; ".join(parts) or "Changed"


def _file_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def _read_stored_hash() -> str:
    if HASH_FILE.exists():
        return HASH_FILE.read_text(encoding="utf-8").strip()
    return ""


def _write_stored_hash(h: str) -> None:
    HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
    HASH_FILE.write_text(h, encoding="utf-8")


def _extract_sections(text: str) -> list[str]:
    """Return list of ## section headings found in cv.md."""
    return [
        line.strip()[3:].strip()
        for line in text.splitlines()
        if line.strip().startswith("## ")
    ]


def _diff_lines(old: str, new: str) -> tuple[list[str], list[str]]:
    old_set = set(old.splitlines())
    new_set = set(new.splitlines())
    added   = [l for l in new_set - old_set if l.strip()]
    removed = [l for l in old_set - new_set if l.strip()]
    return added, removed


def _save_snapshot(text: str) -> str:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    snap_path = HISTORY_DIR / f"cv_{date_str}.md"
    # If multiple saves in one day, suffix with counter
    counter = 0
    while snap_path.exists():
        counter += 1
        snap_path = HISTORY_DIR / f"cv_{date_str}_{counter}.md"
    snap_path.write_text(text, encoding="utf-8")
    return str(snap_path)


def _append_changelog(entry: dict) -> None:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    with open(CHANGELOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, default=str, ensure_ascii=False) + "\n")


def compute_diff(cv_path: str | None = None) -> CVDiff:
    """
    Compares current cv.md against last stored hash.
    If changed: saves snapshot, appends changelog entry, updates hash.
    Returns CVDiff (has_changes=False if nothing changed).
    """
    path = Path(cv_path) if cv_path else CV_PATH
    if not path.exists():
        raise CVParseError(f"cv.md not found at {path}")

    new_text = path.read_text(encoding="utf-8")
    new_hash = _file_hash(new_text)
    old_hash = _read_stored_hash()

    if old_hash == new_hash:
        return CVDiff(has_changes=False, old_hash=old_hash, new_hash=new_hash)

    # Read old snapshot for line diff (latest file in history)
    old_text = ""
    if HISTORY_DIR.exists():
        snapshots = sorted(HISTORY_DIR.glob("cv_*.md"))
        if snapshots:
            old_text = snapshots[-1].read_text(encoding="utf-8")

    added, removed = _diff_lines(old_text, new_text)

    # Which sections changed?
    old_sections = set(_extract_sections(old_text))
    new_sections = set(_extract_sections(new_text))
    changed = list((old_sections ^ new_sections) | {
        s for s in (old_sections & new_sections)
        if any(s.lower() in line.lower() for line in added + removed)
    })

    snap_path = _save_snapshot(new_text)
    _write_stored_hash(new_hash)

    entry = {
        "ts":               datetime.now().isoformat(),
        "old_hash":         old_hash,
        "new_hash":         new_hash,
        "snapshot":         snap_path,
        "added_count":      len(added),
        "removed_count":    len(removed),
        "changed_sections": changed,
        "added_sample":     added[:3],
    }
    _append_changelog(entry)

    return CVDiff(
        has_changes=True,
        old_hash=old_hash,
        new_hash=new_hash,
        snapshot_path=snap_path,
        added_lines=added,
        removed_lines=removed,
        changed_sections=changed,
    )


def get_changelog(limit: int = 20) -> list[dict]:
    """Returns last N changelog entries (most recent first)."""
    if not CHANGELOG.exists():
        return []
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()
    entries = []
    for line in reversed(lines):
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        if len(entries) >= limit:
            break
    return entries
