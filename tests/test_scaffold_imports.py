"""Packages import cleanly."""
import importlib, tomllib
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def test_core_imports():
    importlib.import_module("pulseops_core.exceptions")
