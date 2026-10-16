"""Watch exactly what Instahyre's "Apply now" does.

The pipeline logs `[submit] clicked final Apply now` and then nothing - no second
navigation, no confirmation - so every one of 21 attempts today stopped there. The
open question is WHY, and it matters because the two possible answers need
opposite fixes:

  (a) the click opens an outbound hop the navigation guard refuses  -> the guard
      is too strict for the legitimate final step of an application, and should
      be widened carefully
  (b) the click opens a modal, a login wall, or an interstitial, and never
      reaches a form  -> nothing to widen; the flow needs a different step

Guessing between them would mean loosening a security guard on a hunch. So this
clicks the button with no navigation guard installed at all, and reports what the
browser actually lands on and what is on the page.

Read-only: it clicks "Apply now" to observe the redirect, and stops there. It
does not fill or submit anything.
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(r"E:\Potential-gold\PluseOPS")
sys.path.insert(0, str(ROOT / "apps" / "browser-apply"))

URL = "https://www.instahyre.com/job-444263-ai-ml-engineer-at-accenture-2-gurgaon-kolkata/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    print(f"  goto {URL}")
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)

    print(f"  title: {page.title()}")
    print(f"  url  : {page.url}")

    # Find the Apply control the way a person would see it.
    buttons = page.locator("button, a")
    total = buttons.count()
    target = None
    for i in range(min(total, 200)):
        el = buttons.nth(i)
        try:
            if not el.is_visible():
                continue
            txt = (el.inner_text() or "").strip().lower()
        except Exception:
            continue
        if txt.startswith("apply"):
            target = el
            print(f"  found control #{i}: <{el.evaluate('e => e.tagName')}> "
                  f"text={(el.inner_text() or '').strip()[:40]!r} "
                  f"href={el.get_attribute('href')!r}")
            break
    if target is None:
        print("  no visible Apply control found")
        browser.close()
        sys.exit(1)

    # Watch every frame and popup the click produces.
    seen = []
    page.on("framenavigated", lambda f: seen.append(("frame", f.url)))
    page.on("popup", lambda pp: seen.append(("popup", pp.url)))

    print("  clicking Apply now ...")
    try:
        target.click(timeout=15000)
    except Exception as e:
        print(f"  click failed: {type(e).__name__}: {str(e)[:120]}")

    page.wait_for_timeout(9000)

    print(f"\n  url after click : {page.url}")
    print(f"  title          : {page.title()}")
    print(f"  frames now     : {len(page.frames)}")
    for kind, u in seen:
        print(f"    {kind}: {u[:110]}")

    print("\n  --- what is on the page now ---")
    for sel in ("h1", "h2", "[role='dialog']", "form", "input[type=email]",
                "input[type=tel]", "textarea", "iframe"):
        try:
            n = page.locator(sel).count()
        except Exception:
            n = 0
        if n:
            print(f"    {sel:<22} x{n}")
    body = ""
    try:
        body = " ".join(page.locator("body").inner_text().split())
    except Exception:
        pass
    print(f"\n  body text ({len(body)} chars):")
    print("   ", body[:1200])

    browser.close()