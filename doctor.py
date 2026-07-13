"""
doctor.py — PulseOps Health Check + First-Run Init

This is the canonical entry point referenced throughout the project
(master prompt: "First Command — python doctor.py --check").

Commands:
  python doctor.py --check           Run all health checks, exit 0 if clean
  python doctor.py --init            First-run: parse cv.md, generate profile.yml
  python doctor.py --sync-profile    Resync profile.yml after cv.md changes
  python doctor.py --apply-memories  Review + confirm cv_candidate memories
"""

import hashlib
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).parent

REQUIRED_DIRS = [
    "output/pdf", "output/html", "output/prep",
    "data", "logs", "config", "prompts", "migrations",
    "memory/cv_history", "templates", "dashboard", "portal",
]

GREEN, YELLOW, RED, RESET, BOLD = (
    "\033[92m", "\033[93m", "\033[91m", "\033[0m", "\033[1m",
)
PASS = f"{GREEN}[\u2713]{RESET}"
WARN = f"{YELLOW}[!]{RESET}"
FAIL = f"{RED}[\u2717]{RESET}"
INFO = "    "


def check(label: str, ok: bool, detail: str = "", warn_only: bool = False) -> bool:
    symbol = PASS if ok else (WARN if warn_only else FAIL)
    line = f"{symbol} {label}"
    if detail:
        line += f"\n{INFO}  {detail}"
    print(line)
    return ok


def section(title: str) -> None:
    print(f"\n{BOLD}\u2500\u2500 {title} {'\u2500' * max(1, 50 - len(title))}{RESET}")


# ── Main check sequence ─────────────────────────────────────────────────────

def run_checks() -> bool:
    all_ok = True

    # ── Directories ──────────────────────────────────────────────────────
    section("Directory Structure")
    for d in REQUIRED_DIRS:
        path = ROOT / d
        existed = path.exists()
        path.mkdir(parents=True, exist_ok=True)
        check(f"dir: {d}", True, "created" if not existed else "")

    # ── Core files ───────────────────────────────────────────────────────
    section("Core Files")

    cv_path = ROOT / "cv.md"
    cv_ok = cv_path.exists()
    all_ok &= check("cv.md exists", cv_ok,
                     "Create cv.md with your CV in Markdown format" if not cv_ok else "")

    if cv_ok:
        age_days = (datetime.now() - datetime.fromtimestamp(cv_path.stat().st_mtime)).days
        check("cv.md freshness", age_days <= 30,
              f"Last modified {age_days} days ago — consider updating"
              if age_days > 30 else f"Last modified {age_days} days ago",
              warn_only=True)

    profile_path = ROOT / "config" / "profile.yml"
    profile_ok = profile_path.exists()
    all_ok &= check("config/profile.yml exists", profile_ok,
                     "Run: python doctor.py --init" if not profile_ok else "")

    if profile_ok and cv_ok:
        cv_hash = _file_hash(cv_path)
        stored_hash = _read_cv_hash()
        in_sync = bool(stored_hash) and cv_hash == stored_hash
        check("profile.yml in sync with cv.md", in_sync,
              "Run: python doctor.py --sync-profile" if not in_sync else "",
              warn_only=True)

    settings_path = ROOT / "config" / "settings.yml"
    all_ok &= check(
        "config/settings.yml exists", settings_path.exists(),
        "Copy config/settings.yml.example \u2192 config/settings.yml and fill values"
        if not settings_path.exists() else "")

    blacklist_path = ROOT / "config" / "blacklist.txt"
    check("config/blacklist.txt exists", blacklist_path.exists(),
          "Copy config/blacklist.txt.example \u2192 config/blacklist.txt (can be empty)",
          warn_only=True)

    contacts_path = ROOT / "config" / "contacts.yml"
    check("config/contacts.yml exists", contacts_path.exists(),
          "Copy config/contacts.yml.example \u2192 config/contacts.yml (can be empty)",
          warn_only=True)

    # ── API Keys ─────────────────────────────────────────────────────────
    section("API Keys")

    def _set(name: str) -> bool:
        v = os.getenv(name, "")
        return bool(v) and "your_" not in v.lower()

    gemini_key = os.getenv("GEMINI_API_KEY", "")
    all_ok &= check("GEMINI_API_KEY set", _set("GEMINI_API_KEY"),
                     "Required (primary engine) \u2014 free key: https://aistudio.google.com/apikey"
                     if not _set("GEMINI_API_KEY") else "")

    groq_ok = _set("GROQ_API_KEY") or _set("XAI_API_KEY")
    all_ok &= check("GROQ_API_KEY set", groq_ok,
                     "Required fallback \u2014 free key: https://console.groq.com" if not groq_ok else "")

    check("OPENAI_API_KEY set (optional)", _set("OPENAI_API_KEY"),
          "Optional third fallback in the cascade", warn_only=True)

    check("SEARCHAPI_API_KEY set", bool(os.getenv("SEARCHAPI_API_KEY")),
          "Needed for Google Jobs sourcing \u2014 https://www.searchapi.io", warn_only=True)

    check("THEIRSTACK_API_KEY set", bool(os.getenv("THEIRSTACK_API_KEY")),
          "Optional \u2014 widens sourcing via https://theirstack.com", warn_only=True)

    hunter_key = bool(os.getenv("HUNTER_API_KEY", "").strip())
    check("HUNTER_API_KEY set", hunter_key,
          "Optional. Without it: cold-email auto-send only fires for jobs where "
          "the JD itself lists an email; everything else still gets a full "
          "LinkedIn DM draft in your Telegram match card \u2014 you just send it "
          "by hand. Nothing is lost, G10 just favors DM over cold email.",
          warn_only=True)
    if hunter_key:
        try:
            from outreach.hunter import quota_remaining
            remaining = quota_remaining()
            if remaining is not None:
                check(f"Hunter.io quota", remaining > 0,
                      f"{remaining} lookups remaining this month"
                      if remaining > 0 else "Quota exhausted \u2014 G10 will skip Hunter until next month",
                      warn_only=remaining < 5)
        except Exception:
            pass

    telegram_ok = bool(os.getenv("TELEGRAM_BOT_TOKEN")) and bool(os.getenv("TELEGRAM_CHAT_ID"))
    check("Telegram configured", telegram_ok,
          "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (run get_chat_id.py)", warn_only=True)

    discord_ok = bool(os.getenv("DISCORD_WEBHOOK_URL"))
    check("Discord configured", discord_ok,
          "Set DISCORD_WEBHOOK_URL (Channel Settings > Integrations > Webhooks > New Webhook)",
          warn_only=True)

    smtp_ok = bool(os.getenv("SMTP_EMAIL")) and bool(os.getenv("SMTP_PASSWORD"))
    check("SMTP configured", smtp_ok,
          "Set SMTP_EMAIL + SMTP_PASSWORD (Gmail App Password) for auto-outreach", warn_only=True)

    auto_send = os.getenv("AUTO_SEND_EMAILS", "false").lower() == "true"
    check("AUTO_SEND_EMAILS", True,
          f"Currently: {auto_send}" + ("" if auto_send else " (sends will be simulated/skipped)"),
          warn_only=True)

    imap_ok = bool(os.getenv("IMAP_EMAIL") or os.getenv("SMTP_EMAIL"))
    check("IMAP configured", imap_ok,
          "Set IMAP_EMAIL + IMAP_PASSWORD (or reuse SMTP_*) for reply detection", warn_only=True)

    # ── Runtime Dependencies ─────────────────────────────────────────────
    section("Runtime Dependencies")

    py_ver = sys.version_info
    py_ok = py_ver >= (3, 11)
    all_ok &= check("Python >= 3.11", py_ok, f"Found {py_ver.major}.{py_ver.minor}")

    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=5)
        node_ver = result.stdout.strip()
        major = int(node_ver.lstrip("v").split(".")[0])
        node_ok = major >= 20
        check("Node.js >= 20", node_ok,
              f"Found {node_ver}" + ("" if node_ok else " \u2014 upgrade to v20 LTS, needed for LinkedIn bridge + Playwright portal scan"),
              warn_only=True)
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        check("Node.js >= 20", False,
              "Not found \u2014 needed for linkedin_bridge.js and portal/scan.mjs (Phase 11)", warn_only=True)

    try:
        result = subprocess.run(["npx", "playwright", "--version"],
                                 capture_output=True, text=True, timeout=15)
        pw_ok = result.returncode == 0
        check("Playwright (Node) installed", pw_ok,
              result.stdout.strip() if pw_ok else "Run: npm install && npx playwright install chromium",
              warn_only=True)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        check("Playwright (Node) installed", False,
              "Run: npm install && npx playwright install chromium", warn_only=True)

    packages = {
        "google.genai": "google-genai", "groq": "groq", "openai": "openai",
        "pydantic": "pydantic", "dotenv": "python-dotenv", "yaml": "pyyaml",
        "requests": "requests", "jinja2": "jinja2", "flask": "Flask",
        "playwright": "playwright", "pypdf": "pypdf",
    }
    missing = []
    for mod, pkg in packages.items():
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    pkg_ok = len(missing) == 0
    check("Python packages installed", pkg_ok,
          f"Run: pip install -r requirements.txt --break-system-packages  Missing: {missing}"
          if not pkg_ok else "", warn_only=True)
    # google-genai / groq / openai are only hard-required for LIVE mode, not --simulate
    if not pkg_ok and not all(p in missing for p in ["google-genai", "groq", "openai"]):
        pass

    # ── Database ─────────────────────────────────────────────────────────
    section("Database")

    db_path = ROOT / "pulseops.db"
    db_ok = db_path.exists()
    check("pulseops.db exists", db_ok,
          "Will be created on first run (python main.py --simulate)" if not db_ok else
          f"Size: {db_path.stat().st_size / 1024:.1f} KB")

    if db_ok:
        _check_migrations()

    # ── Send State ───────────────────────────────────────────────────────
    section("Send State")

    send_paused = _is_send_paused()
    check("Auto-send active", not send_paused,
          "Sends are PAUSED \u2014 run: python main.py --resume-sends" if send_paused else
          "Auto-send is live", warn_only=send_paused)

    # ── Memory ───────────────────────────────────────────────────────────
    section("Memory")

    pending = _get_pending_cv_candidates()
    if pending:
        check(f"cv_candidate memories pending ({len(pending)})", True,
              "Run: python doctor.py --apply-memories to review", warn_only=True)
    else:
        check("No pending cv_candidate memories", True)

    stale = _get_stale_queue_items()
    if stale:
        check(f"Stale queue items ({len(stale)} items > 3 days)", False,
              "Check send_queue table \u2014 items may be stuck", warn_only=True)
    else:
        check("Send queue clean", True)

    # ── Summary ──────────────────────────────────────────────────────────
    print(f"\n{'\u2500' * 54}")
    if all_ok:
        print(f"{GREEN}{BOLD}All required checks passed. PulseOps is ready.{RESET}")
        print("Run: python main.py --simulate")
    else:
        print(f"{RED}{BOLD}Some required checks failed. Fix the above before running live.{RESET}")
        print("Re-run: python doctor.py --check")
        print(f"{YELLOW}Note: python main.py --simulate works regardless (zero API keys, always).{RESET}")
    print()

    return all_ok


# ── Subcommands ──────────────────────────────────────────────────────────

def init_profile() -> None:
    """First-run: parse cv.md → LLM (or keyword fallback) → profile.yml"""
    cv_path = ROOT / "cv.md"
    if not cv_path.exists():
        print(f"{FAIL} cv.md not found. Create it first.")
        sys.exit(1)

    print(f"{INFO}Parsing cv.md...")
    try:
        from core.cv_parser import parse_cv
        from core.profile_builder import build_profile

        cv_data = parse_cv(str(cv_path))
        n_projects = len(getattr(cv_data, "projects", []) or [])
        print(f"{PASS} CV parsed: {n_projects} project(s) found")

        print(f"{INFO}Building profile.yml...")
        path = build_profile(cv_data, cv_diff=None)
        _store_cv_hash(cv_path)
        print(f"{PASS} profile.yml generated at {path}")
        print(f"{INFO}Review it, then run: python main.py --simulate")
    except Exception as e:
        print(f"{FAIL} Init failed: {e}")
        sys.exit(1)


def sync_profile() -> None:
    """Resync profile.yml after cv.md changes (Non-negotiable #7)."""
    cv_path = ROOT / "cv.md"
    if not cv_path.exists():
        print(f"{FAIL} cv.md not found.")
        sys.exit(1)

    print(f"{INFO}Detecting cv.md changes...")
    try:
        from core.cv_diff import compute_diff
        from core.cv_parser import parse_cv
        from core.profile_builder import build_profile

        diff = compute_diff(str(cv_path))
        cv_data = parse_cv(str(cv_path))

        if not diff.has_changes:
            print(f"{PASS} No changes detected in cv.md \u2014 profile.yml is up to date")
            return

        print(f"{INFO}Changes detected: {diff.summary()}")
        print(f"{INFO}Resyncing profile.yml...")
        path = build_profile(cv_data, cv_diff=diff)
        print(f"{PASS} profile.yml resynced at {path}")
    except Exception as e:
        print(f"{FAIL} Sync failed: {e}")
        sys.exit(1)


def apply_memories() -> None:
    """Review cv_candidate memories. Never auto-writes cv.md (Non-negotiable #4)."""
    try:
        from persistence.db_manager import get_cv_candidates

        candidates = get_cv_candidates()
        if not candidates:
            print(f"{PASS} No pending cv_candidate memories.")
            return

        print(f"\n{BOLD}Pending CV Candidates ({len(candidates)} items):{RESET}\n")
        for i, mem in enumerate(candidates, 1):
            print(f"  {i}. [{mem.get('category', '?')}] {str(mem.get('raw_text', ''))[:120]}")
            parsed = mem.get("parsed") or {}
            if isinstance(parsed, dict) and parsed.get("skills"):
                print(f"     Skills: {', '.join(parsed['skills'])}")
            print()

        print("This tool only flags candidates for YOUR review \u2014 it never edits cv.md.")
        print("Options: [a]cknowledge (you'll add it to cv.md yourself)  [d]ismiss  [s]kip\n")

        from persistence.db_manager import get_connection

        for mem in candidates:
            resp = input(
                f"Memory #{mem['id']}: '{str(mem.get('raw_text', ''))[:60]}...' \u2192 [a/d/s] "
            ).strip().lower()
            if resp == "a":
                _clear_cv_candidate_flag(mem["id"])
                print(f"  {PASS} Acknowledged \u2014 now edit cv.md by hand, then run --sync-profile")
            elif resp == "d":
                _deactivate_memory(mem["id"])
                print(f"  {INFO}Dismissed")
            else:
                print(f"  {INFO}Skipped (will reappear next time)")
    except Exception as e:
        print(f"{FAIL} apply-memories failed: {e}")
        sys.exit(1)


# ── Helpers ──────────────────────────────────────────────────────────────

def _file_hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _store_cv_hash(cv_path: Path) -> None:
    hash_file = ROOT / "config" / ".cv_hash"
    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(_file_hash(cv_path), encoding="utf-8")


def _read_cv_hash() -> str:
    hash_file = ROOT / "config" / ".cv_hash"
    return hash_file.read_text(encoding="utf-8").strip() if hash_file.exists() else ""


def _is_send_paused() -> bool:
    if not (ROOT / "pulseops.db").exists():
        return False
    try:
        from persistence.db_manager import get_send_paused
        return get_send_paused()
    except Exception:
        return False


def _check_migrations() -> None:
    try:
        from persistence.db_manager import get_connection
        conn = get_connection()
        applied = {r[0] for r in conn.execute(
            "SELECT filename FROM migrations_applied").fetchall()}
        conn.close()
        migration_dir = ROOT / "migrations"
        if migration_dir.exists():
            all_files = sorted(p.name for p in migration_dir.glob("*.sql"))
            pending = [f for f in all_files if f not in applied]
            if pending:
                check("Migrations up to date", False,
                      f"Pending: {pending} \u2014 will run on next main.py start", warn_only=True)
            else:
                check("Migrations up to date", True, f"{len(applied)} applied")
    except Exception as e:
        check("Migrations up to date", False, f"Could not read migration state: {e}", warn_only=True)


def _get_pending_cv_candidates() -> list:
    if not (ROOT / "pulseops.db").exists():
        return []
    try:
        from persistence.db_manager import get_cv_candidates
        return get_cv_candidates()
    except Exception:
        return []


def _get_stale_queue_items() -> list:
    if not (ROOT / "pulseops.db").exists():
        return []
    try:
        from persistence.db_manager import get_stale_queue_items
        return get_stale_queue_items(days=3)
    except Exception:
        return []


def _clear_cv_candidate_flag(memory_id: int) -> None:
    from persistence.db_manager import get_connection
    conn = get_connection()
    try:
        conn.execute("UPDATE memories SET cv_candidate=0 WHERE id=?", (memory_id,))
        conn.commit()
    finally:
        conn.close()


def _deactivate_memory(memory_id: int) -> None:
    from persistence.db_manager import get_connection
    conn = get_connection()
    try:
        conn.execute("UPDATE memories SET active=0 WHERE id=?", (memory_id,))
        conn.commit()
    finally:
        conn.close()


# ── Entry Point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="PulseOps Health Check + Init")
    parser.add_argument("--check", action="store_true", help="Run all health checks")
    parser.add_argument("--init", action="store_true", help="First-run: generate profile.yml")
    parser.add_argument("--sync-profile", action="store_true", help="Resync profile.yml from cv.md")
    parser.add_argument("--apply-memories", action="store_true", help="Review cv_candidate memories")
    cli_args = parser.parse_args()

    if cli_args.init:
        init_profile()
    elif cli_args.sync_profile:
        sync_profile()
    elif cli_args.apply_memories:
        apply_memories()
    else:
        ok = run_checks()
        sys.exit(0 if ok else 1)
