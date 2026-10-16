/**
 * Give the pipeline's persistent profile a password session on any board.
 *
 * Generalises insta_password_reset.mjs, which worked on Instahyre and which had
 * four wrong guesses in it before it worked. Every guess here was a lesson from
 * those, so they are not repeated:
 *
 *   - Do NOT guess the reset URL. /password/reset/ and /forgot-password/ are both
 *     404 on Instahyre; the entry point is a "Forgot password?" link on /login/.
 *     So this looks for that link by TEXT, on the login page, on any board.
 *   - Run HEADED. Instahyre's Cloudflare challenge never clears headless ("Just
 *     moment...", cf-turnstile-response) and clears in ~5s headed. This waits for
 *     it and stops if it does not clear. No solver, no fingerprint spoofing, no
 *     header rewriting - a normal visible browser that waits is the whole of it.
 *   - Dump the page on failure. "no email field found" twice with no evidence of
 *     what the page held is how four guesses happened; this prints the real
 *     inputs, controls and body every time it cannot proceed.
 *   - Open the reset link with evaluateHandle, not evaluate, so the result is an
 *     ElementHandle. evaluate returns a plain value.
 *
 * The loop this closes: request a reset, read the mail through this project's own
 * IMAP access, open the link in the SAME profile, set a password, then verify by
 * logging in unaided. Nobody types a credential.
 *
 * Usage:
 *   node apps/browser-apply/tools/board_login.mjs wellfound
 *   node apps/browser-apply/tools/board_login.mjs naukri
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");
const EMAIL = "trex2004avradeep@gmail.com";

const BOARDS = {
  instahyre: {
    login: "https://www.instahyre.com/login/",
    match: "instahyre",
    id: "Instahyre",
  },
  wellfound: {
    login: "https://wellfound.com/signin",
    match: "wellfound",
    id: "Wellfound",
  },
  naukri: {
    login: "https://www.naukri.com/nlogin/login",
    match: "naukri",
    id: "Naukri",
  },
  jobhai: {
    login: "https://www.jobhai.com/login",
    match: "jobhai",
    id: "Job Hai",
  },
  coursera: {
    login: "https://www.coursera.org/login?authMode=login",
    match: "coursera",
    id: "Coursera",
  },
};

const which = String(process.argv[2] || "").toLowerCase();
const board = BOARDS[which];
if (!board) {
  console.error(`  unknown board "${which}". known: ${Object.keys(BOARDS).join(", ")}`);
  process.exit(1);
}
const PASSWORD = process.env[`${which.toUpperCase()}_PASSWORD`] ||
  `${which.slice(0, 2)}-${which.slice(2, 5)}-${Math.floor(Math.random() * 9000 + 1000)}`;

mkdirSync(path.join(ROOT, "output"), { recursive: true });

const dump = async (p, label) => {
  const d = await p.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    return {
      url: location.href,
      title: document.title,
      inputs: [...document.querySelectorAll("input")].map((i) => ({
        t: i.type, n: i.name || null, id: i.id || null,
        ph: i.getAttribute("placeholder"), a: i.getAttribute("aria-label"), v: vis(i),
      })),
      controls: [...document.querySelectorAll("button, a[href], [role=button]")].filter(vis)
        .map((b) => `<${b.tagName}> "${((b.innerText || b.value || "") + "").replace(/\s+/g, " ").trim().slice(0, 38)}"${b.getAttribute("href") ? " -> " + b.getAttribute("href").slice(0, 44) : ""}`)
        .slice(0, 14),
      body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 320),
    };
  }).catch(() => null);
  if (!d) { console.log(`  [${label}] could not read the page`); return; }
  console.log(`  [${label}] ${d.url.slice(0, 100)}  "${d.title.slice(0, 46)}"`);
  console.log(`  [${label}] inputs : ${JSON.stringify(d.inputs).slice(0, 300)}`);
  console.log(`  [${label}] controls: ${d.controls.join(" | ").slice(0, 300)}`);
  console.log(`  [${label}] body    : ${d.body}`);
};

const waitClear = async (p, label) => {
  for (let i = 0; i < 24; i++) {
    await p.waitForTimeout(5000);
    const st = await p.evaluate(() => ({
      t: document.title,
      c: /just a moment|performing security verification|verify you are human|checking your browser/i
        .test(document.body?.innerText || ""),
    })).catch(() => null);
    if (!st) continue;
    if (!st.c && !/just a moment/i.test(st.t)) {
      console.log(`  [${label}] challenge cleared after ~${(i + 1) * 5}s`);
      return true;
    }
    if ((i + 1) % 4 === 0) console.log(`  [${label}] still waiting (${(i + 1) * 5}s)`);
  }
  console.log(`  [${label}] the challenge did not clear on its own. Not working around it.`);
  return false;
};

console.log(`  board  : ${board.id}`);
console.log(`  profile: ${PROFILE}`);
console.log(`  account: ${EMAIL}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(board.login, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
if (!(await waitClear(page, "login"))) { await ctx.close(); process.exit(3); }
await dump(page, "login");

// ---- find the reset entry point by TEXT, not by guessing a URL -------------
const forgot = page
  .locator('a:has-text("Forgot password"), button:has-text("Forgot password"), a:has-text("Forgot"), button:has-text("Forgot"), a:has-text("Forgot Password")')
  .first();
if (!(await forgot.count())) {
  console.log("\n  no 'forgot password' control on the login page.");
  console.log("  Check the controls listed above for the board's own wording.");
  await page.screenshot({ path: path.join(ROOT, "output", `${which}-login.png`) }).catch(() => {});
  await ctx.close();
  process.exit(1);
}
console.log(`  forgot-password link: ${await forgot.getAttribute("href").catch(() => "(no href)")}`);
await forgot.click({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(4000);
if (!(await waitClear(page, "reset"))) { await ctx.close(); process.exit(3); }
await dump(page, "reset");

// ---- submit the account email ----------------------------------------------
const emailSel = 'input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[type="email"], input[type="text"]';
const field = page.locator(emailSel).first();
if (!(await field.count())) {
  console.log("  no email input on the reset page (see the dump above)");
  await page.screenshot({ path: path.join(ROOT, "output", `${which}-reset.png`) }).catch(() => {});
  await ctx.close();
  process.exit(1);
}
await field.scrollIntoViewIfNeeded().catch(() => {});
await field.click({ timeout: 8000 }).catch(() => {});
await field.fill(EMAIL).catch(async () => { await field.type(EMAIL, { delay: 30 }); });
console.log(`  filled : ${await field.inputValue().catch(() => "?")}`);
const go = page.locator('button[type="submit"], input[type="submit"], button:has-text("Reset"), button:has-text("Send"), button:has-text("Continue"), button:has-text("Submit")').first();
if (await go.count()) { await go.click({ timeout: 8000 }).catch(() => {}); }
else { await field.press("Enter").catch(() => {}); }
await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(ROOT, "output", `${which}-reset-requested.png`) }).catch(() => {});
console.log(`  submitted; now at ${page.url().slice(0, 90)}`);
await ctx.close();

// ---- read the link from the mailbox ----------------------------------------
console.log("\n  polling the mailbox for the reset link");
const py = `
import sys, re, time, imaplib, ssl, email as E
sys.path.insert(0, r"${ROOT.replace(/\\/g, "\\\\")}\\\\apps\\\\browser-apply\\\\tools")
from mail_list import load_env
from email.header import decode_header, make_header
env = load_env()
c = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
c.login(env["SMTP_EMAIL"], env["SMTP_PASSWORD"]); c.select("INBOX")
def h(v):
    try: return str(make_header(decode_header(v or "")))
    except Exception: return v or ""
deadline = time.time() + 240
seen = set()
while time.time() < deadline:
    _, d = c.search(None, "ALL")
    for n in (d[0].split() if d and d[0] else [])[::-1][:70]:
        if n in seen: continue
        seen.add(n)
        _, ch = c.fetch(n, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT))]")
        if not ch or not isinstance(ch[0], tuple): continue
        m = E.message_from_bytes(ch[0][1])
        f, s = h(m.get("From")), h(m.get("Subject"))
        blob = (f + " " + s).lower()
        if "${board.match}" not in blob: continue
        if not re.search(r"reset|password|verify|confirm|activate", blob): continue
        print("MAIL|" + f + "|" + s)
        _, full = c.fetch(n, "(BODY.PEEK[])")
        for part in (full or []):
            if not isinstance(part, tuple): continue
            msg = E.message_from_bytes(part[1])
            for sub in msg.walk():
                if sub.get_content_type() not in ("text/plain", "text/html"): continue
                try: body = sub.get_payload(decode=True).decode("utf-8", "replace")
                except Exception: continue
                mm = re.search(r'https?://[^\\s"\\'<>]+(?:reset|set[_-]?password|verify|confirm|token|activate)[^\\s"\\'<>]*', body, re.I)
                if mm:
                    print("LINK|" + mm.group(0).rstrip(".,)\\""))
                    sys.exit(0)
        print("MAIL_NOLINK|" + s)
    time.sleep(6)
print("LINK|")
`;
const res = spawnSync("python", ["-X", "utf8", "-c", py], { encoding: "utf8", timeout: 300000 });
const out = String(res.stdout || "");
const link = (out.match(/LINK\|(\S*)/) || [])[1] || "";
console.log(`  mailbox: ${(out.match(/MAIL\|([^|]*)\|([^|]*)/) || []).slice(1, 3).join(" / ") || "nothing yet"}`);
if (!link) {
  console.log("\n  NO RESET LINK. Nothing changed on the account.");
  await ctx.close().catch(() => {});
  process.exit(1);
}
console.log(`  link   : ${link.slice(0, 96)}...`);

// ---- set the password in the same profile, then verify ----------------------
const ctx2 = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const p2 = ctx2.pages()[0] || (await ctx2.newPage());
await p2.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await p2.waitForTimeout(4500);
if (!(await waitClear(p2, "setpw"))) { await ctx2.close(); process.exit(3); }
await dump(p2, "setpw");

const pw = p2.locator('input[type="password"], input[name*="password" i], input[id*="password" i]');
if (!(await pw.count())) {
  console.log("  no password field after the link - set it by hand in that window.");
  console.log(`  use this password: ${PASSWORD}`);
  writeFileSync(path.join(ROOT, "output", `${which}-credentials.txt`),
    `email: ${EMAIL}\npassword: ${PASSWORD}\nset: MANUAL - complete in the open window\n`);
  process.exit(2);
}
const f1 = pw.first();
const f2 = pw.nth(1);
await f1.scrollIntoViewIfNeeded().catch(() => {});
await f1.click({ timeout: 8000 }).catch(() => {});
await f1.fill(PASSWORD).catch(async () => { await f1.type(PASSWORD, { delay: 25 }); });
if (await f2.count()) await f2.fill(PASSWORD).catch(() => {});
const submit = p2.locator('button[type="submit"], button:has-text("Reset"), button:has-text("Save"), button:has-text("Continue"), button:has-text("Set")').first();
if (await submit.count()) await submit.click({ timeout: 8000 }).catch(() => {});
else await f1.press("Enter").catch(() => {});
await p2.waitForTimeout(5000);
console.log(`  after submit: ${p2.url().slice(0, 90)}`);

console.log("\n  verifying the profile can log in unaided");
const v = ctx2.pages()[0] || (await ctx2.newPage());
await v.goto(board.login, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await v.waitForTimeout(4000);
const em = v.locator('input[type="email"], input[name*="email" i], input[type="text"]').first();
const pwv = v.locator('input[type="password"]').first();
if (await em.count() && await pwv.count()) {
  await em.click({ timeout: 8000 }).catch(() => {}); await em.fill(EMAIL).catch(() => {});
  await pwv.click({ timeout: 8000 }).catch(() => {}); await pwv.fill(PASSWORD).catch(() => {});
  const sb = v.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  if (await sb.count()) await sb.click({ timeout: 8000 }).catch(() => {});
  await v.waitForTimeout(5000);
  const body = (await v.locator("body").innerText().catch(() => "")) || "";
  const ok = /sign out|log out|my account|my profile|messages|applied/i.test(body);
  console.log(`  logged in : ${ok}`);
  console.log(`  url       : ${v.url().slice(0, 90)}`);
} else {
  console.log("  login form not found for verification");
}

writeFileSync(path.join(ROOT, "output", `${which}-credentials.txt`),
  `email: ${EMAIL}\npassword: ${PASSWORD}\nset automatically ${new Date().toISOString()}\n`);
console.log(`\n  EMAIL    : ${EMAIL}`);
console.log(`  PASSWORD : ${PASSWORD}`);
console.log(`  saved to output/${which}-credentials.txt`);
await ctx2.close();
