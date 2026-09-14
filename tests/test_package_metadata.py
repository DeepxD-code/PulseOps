"""Every package and app is a well-formed unit."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _units():
    out = []
    for d in ("packages", "apps"):
        for p in (ROOT / d).glob("*"):
            if (p / "pyproject.toml").exists():
                out.append(p)
    return sorted(out)


UNITS = _units()

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
