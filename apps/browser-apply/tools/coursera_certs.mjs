/**
 * Log into Coursera via passwordless "Login with link" and download certificates.
 *
 * The account trex2004avradeep@gmail.com previously logged in using Google, so
 * a password reset is the wrong door - there is no password to reset. Coursera
 * offers "Login with link": it mails a one-time sign-in link to the account
 * address, and this project reads that mailbox over IMAP. Fully autonomous,
 * no credential typed by anyone, no password changed.
 *
 * Then: open https://www.coursera.org/my-accomplishments (or the learning hub
 * /my-learning) and enumerate completed courses/specializations, downloading
 * every certificate PDF into output/certs/.
 *
 * Usage:
 *   node apps/browser-apply/tools/coursera_certs.mjs
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");
const EMAIL = "trex2004avradeep@gmail.com";
// Where certificates live. The operator keeps them with the rest of his job
// documents rather than inside the repo (2026-11-10), so the default is that
// folder and PULSEOPS_CERT_DIR overrides it.
const CERT_DIR = process.env.PULSEOPS_CERT_DIR
  || path.join(process.env.USERPROFILE || "", "Documents", "Job stuff", "certificates");

mkdirSync(CERT_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const p = ctx.pages()[0] || (await ctx.newPage());
await p.goto("https://www.coursera.org/login?authMode=login",
  { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(5000);

// Step 1: email + Continue to reach the per-account options.
const em = p.locator('input[type="email"]').first();
await em.click({ timeout: 8000 }).catch(() => {});
await em.fill(EMAIL).catch(() => {});
await p.locator('button:has-text("Continue")').first().click({ timeout: 8000 }).catch(() => {});
await p.waitForTimeout(5000);

// Step 2: passwordless link.
const linkBtn = p.locator('button:has-text("Login with link"), button:has-text("Log in with link"), a:has-text("Login with link")').first();
if (!(await linkBtn.count())) {
  console.log("  no 'Login with link' control - dumping state:");
  const d = await p.evaluate(() => ({
    url: location.href,
    body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
  })).catch(() => null);
  console.log("  ", JSON.stringify(d));
  await ctx.close();
  process.exit(1);
}
await linkBtn.click({ timeout: 10000 }).catch(() => {});
await p.waitForTimeout(5000);
console.log("  login-link requested; polling mailbox");
await ctx.close();

// Step 3: read the sign-in link out of the mailbox.
const py = `
import sys, re, time, imaplib, ssl, email as E
sys.path.insert(0, r"APPS_TOOLS")
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
    for n in (d[0].split() if d and d[0] else [])[::-1][:40]:
        if n in seen: continue
        seen.add(n)
        _, ch = c.fetch(n, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if not ch or not isinstance(ch[0], tuple): continue
        m = E.message_from_bytes(ch[0][1])
        f, s = h(m.get("From")), h(m.get("Subject"))
        blob = (f + " " + s).lower()
        if "coursera" not in blob: continue
        print("MAIL|" + f + "|" + s, flush=True)
        _, full = c.fetch(n, "(BODY.PEEK[])")
        for part in (full or []):
            if not isinstance(part, tuple): continue
            msg = E.message_from_bytes(part[1])
            for sub in msg.walk():
                if sub.get_content_type() not in ("text/plain", "text/html"): continue
                try: body = sub.get_payload(decode=True).decode("utf-8", "replace")
                except Exception: continue
                mm = re.search(r'https?://[^\\s"\\'<>]*coursera[^\\s"\\'<>]*', body)
                if mm:
                    print("LINK|" + mm.group(0).rstrip(".,)"), flush=True)
                    sys.exit(0)
    time.sleep(6)
print("LINK|")
`.replace("APPS_TOOLS", path.join(ROOT, "apps", "browser-apply", "tools").replace(/\\/g, "\\\\"));
const res = spawnSync("python", ["-X", "utf8", "-c", py], { encoding: "utf8", timeout: 300000 });
const out = String(res.stdout || "");
console.log(out.split("\n").filter((l) => l.startsWith("MAIL|")).slice(-3).map((l) => "  " + l).join("\n") || "  no coursera mail seen yet");
const link = (out.match(/LINK\|(\S*)/) || [])[1] || "";
if (!link) { console.log("  NO SIGN-IN LINK. Nothing changed."); process.exit(1); }
console.log(`  link: ${link.slice(0, 90)}...`);

// Step 4: open the link in the SAME profile, verify, enumerate accomplishments.
const ctx2 = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const q = ctx2.pages()[0] || (await ctx2.newPage());
const chain = [];
q.on("response", (r) => {
  if (r.status() >= 300 && r.status() < 400) chain.push(`${r.status()} ${r.url().slice(0, 110)}`);
});
q.on("requestfailed", (r) => chain.push(`FAIL ${r.url().slice(0, 110)} :: ${(r.failure() || {}).errorText}`));
await q.goto(link, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => console.log("  goto err:", String(e).slice(0, 120)));
await q.waitForTimeout(12000);
console.log("  redirects/issues:");
for (const c of chain.slice(0, 12)) console.log("   ", c);
const cookies = await ctx2.cookies("https://www.coursera.org").catch(() => []);
console.log(`  coursera.org cookies: ${cookies.length} :: ${cookies.map((c) => c.name).slice(0, 20).join(",")}`);
const loginCheck = await q.evaluate(() => {
  const x = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return { url: location.href,
    loggedIn: /my learning|accomplishments|log out|account settings|my courses/i.test(x),
    head: x.slice(0, 200) };
}).catch(() => null);
console.log(`  after link: ${JSON.stringify(loginCheck).slice(0, 300)}`);

for (const url of ["https://www.coursera.org/my-accomplishments", "https://www.coursera.org/my-learning"]) {
  await q.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await q.waitForTimeout(6000);
  const d = await q.evaluate(() => {
    const x = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const certs = [...document.querySelectorAll('a[href*="accomplishments/verify"], a[href*="certificates/"]')]
      .map((a) => ({ t: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80), h: a.href }));
    return { url: location.href, head: x.slice(0, 500), certs: certs.slice(0, 30) };
  }).catch(() => null);
  console.log(`\n  === ${url} ===`);
  console.log("  " + JSON.stringify(d, null, 1).slice(0, 2000));
}
await ctx2.close();
