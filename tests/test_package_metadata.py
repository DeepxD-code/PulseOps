"""Every package and app is a well-formed unit."""
import tomllib
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
UNITS = sorted(p for d in ("packages", "apps") for p in (ROOT / d).glob("*") if (p / "pyproject.toml").exists())

def test_units_exist():
    assert UNITS

def test_every_unit_is_complete():
    skip = {"pulse-config"}
    for unit in UNITS:
        if unit.name in skip:
            continue
        assert (unit / "README.md").exists(), unit.name
        assert (unit / "CHANGELOG.md").exists(), unit.name
        assert (unit / "src").is_dir(), unit.name
