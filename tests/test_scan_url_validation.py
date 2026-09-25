"""URL validation tests for the weekly portal scanner (Node unit only)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _run_node(expression: str) -> dict:
    module_url = (ROOT / "apps" / "weekly-scan" / "scan.mjs").as_uri()
    script = f"""
      import {{ appendUniqueJobs, validateJobLink }} from {json.dumps(module_url)};
      const portal = {json.dumps({"name": "Acme", "engine": "greenhouse", "company": "acme", "url": "https://boards.greenhouse.io/acme"})};
      const target = [];
      const rejected = [];
      appendUniqueJobs(target, {expression}, portal, rejected);
      console.log(JSON.stringify({{
        valid: validateJobLink("https://boards.greenhouse.io/acme/jobs/123", portal),
        host: validateJobLink("https://evil.com/acme/jobs/123", portal),
        tenant: validateJobLink("https://boards.greenhouse.io/other/jobs/123", portal),
        relative: validateJobLink("/acme/jobs/123", portal),
        redirect: validateJobLink("https://boards.greenhouse.io/acme/jobs/123?redirect=https://evil.example", portal),
        target,
        rejected,
      }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_invalid_ats_hosts_and_cross_tenant_urls_are_not_emitted():
    result = _run_node(
        """
        [
          { title: "valid", link: "https://boards.greenhouse.io/acme/jobs/123" },
          { title: "bad host", link: "https://evil.com/acme/jobs/123" },
          { title: "wrong tenant", link: "https://boards.greenhouse.io/other/jobs/123" }
        ]
        """
    )

    assert result["valid"]["ok"] is True
    assert result["host"]["ok"] is False
    assert result["tenant"]["ok"] is False
    assert result["relative"]["ok"] is False
    assert result["redirect"]["ok"] is False
    assert [job["title"] for job in result["target"]] == ["valid"]
    assert len(result["rejected"]) == 2
