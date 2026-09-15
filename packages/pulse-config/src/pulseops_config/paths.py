"""Shared path resolver (Tier-2): repo root + shared data dirs.

All units import from here instead of hardcoding ``ROOT / "prompts"``
so moves never break runtime paths again.
"""
from __future__ import annotations

from pathlib import Path


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / ".git").exists():
            return p
    # Installed/editable fallback: .../packages/pulse-config/src -> repo root
    return here.parents[4]


def _first_existing(*candidates: Path) -> Path | None:
    for c in candidates:
        if c.exists():
            return c
    return None


def prompts_dir() -> Path:
    root = repo_root()
    found = _first_existing(
        root / "packages" / "pulse-config" / "prompts",
        root / "prompts",
    )
    if found is not None:
        return found
    try:
        import importlib.resources as res

        pkg = res.files("pulseops_config")
        if (pkg / "prompts").is_dir():
            return Path(str(pkg / "prompts"))
    except Exception:
        pass
    return root / "packages" / "pulse-config" / "prompts"


def templates_dir() -> Path:
    root = repo_root()
    found = _first_existing(
        root / "packages" / "pulse-config" / "templates",
        root / "templates",
    )
    return found or (root / "packages" / "pulse-config" / "templates")


def config_examples_dir() -> Path:
    root = repo_root()
    found = _first_existing(
        root / "packages" / "pulse-config" / "config",
        root / "config",
    )
    return found or (root / "packages" / "pulse-config" / "config")


PROMPTS_DIR = prompts_dir()
TEMPLATES_DIR = templates_dir()
CONFIG_EXAMPLES_DIR = config_examples_dir()
