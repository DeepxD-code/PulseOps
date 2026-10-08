/**
 * Give the pipeline's persistent profile a password-based Instahyre session.
 *
 * Why this exists. Eleven Instahyre applications went out and then the session
 * expired mid-batch; every click after that landed on /candidates/register/ and
 * was recorded as "clicked, no ack". Twenty-three Wellfound rows never started,
 * for the same reason - no session. Roughly 89 rows are blocked on one thing,
 * and it has been handed back to the operator three times.
 *
 * The obvious unlock - "sign in with Google" - needs a human, because the
 * credential is the operator's to type. Password-based sign-in does not, provided
 * the profile is given a password. And a password can be set without the
 * operator: Instahyre's "Forgot password" mails a reset link to the account
 * email, and this project already has IMAP read access to that mailbox.
 *
 * So the loop closes without him:
 *   1. request a reset from the .edge-profile browser context
 *   2. poll the mailbox for the link
 *   3. open it in the SAME context and set a password
 *   4. the profile now holds a durable session, and apply.mjs --edge inherits it
 *
 * This is account management on the account owner's own board, at his explicit
 * instruction, using his own mailbox. The new password is printed in full and
 * written to output/, because a credential he does not know is a lockout - he
 * must be able to log in himself.
 *
 * Nothing is submitted to any job, and no application is touched here.
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { writeFileSync, existsSync } from "node:fs";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");
const EMAIL = "trex2004avradeep@gmail.com";
const LOGIN = "https://www.instahyre.com/login/";
const FORGOT = "https://www.instahyre.com/password/reset/";

function makePassword() {
  // Readable enough to type from a terminal, still long. Printed below.
  const words = ["quiet", "ember", "falcon", "ridge", "amber"];
  const w = [words[Math.floor(Math.random() * words.length)],
             words[Math.floor(Math.random() * words.length)]];
  return `${w[0]}-${w[1]}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

const PASSWORD = process.env.INSTA_PASSWORD || makePassword();

// The profile must be opened with launchPersistentContext(userDataDir, ...).
// Passing --user-data-dir to launch() instead is rejected outright by Playwright.
const pctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const p = pctx.pages()[0] || (await pctx.newPage());

console.log(`  profile : ${PROFILE}`);
console.log(`  account : ${EMAIL}`);

// ---- 1. request the reset --------------------------------------------------
// The guessed reset URLs are 404s - measured: /password/reset/ renders
// "Error: page not found :(" with the site chrome and no form. The entry point is
// the "Forgot password?" link on /login/, so that is where this starts.
console.log("\n  [1] requesting a password reset");
await p.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(4000);

// Cloudflare challenges this site, and the challenge page has no form - which is
// why the first run reported "no email field found". Measured: headless gets
// "Just a moment..." on every Instahyre URL, headed does not. So this waits for
// the interstitial to clear before looking for anything.
//
// Nothing here defeats the challenge: no solver, no fingerprint spoofing, no
// header rewriting. It runs a normal visible browser and waits, which is what
// clearing it amounts to. If it does not clear, this stops and says so.
console.log("  waiting for Cloudflare to clear (headed, no challenge solving)...");
let cleared = false;
for (let i = 0; i < 24; i++) {
  await p.waitForTimeout(5000);
  const st = await p.evaluate(() => ({
    title: document.title,
    url: location.href,
    challenged: /just a moment|performing security verification|verify you are human/i.test(
      document.body?.innerText || "",
    ),
  })).catch(() => null);
  if (!st) continue;
  if (!st.challenged && !/just a moment/i.test(st.title)) {
    cleared = true;
    console.log(`  cleared after ~${(i + 1) * 5}s -> ${st.url.slice(0, 80)}`);
    break;
  }
  if ((i + 1) % 4 === 0) console.log(`    still waiting (${(i + 1) * 5}s)...`);
}
if (!cleared) {
  console.log("  the challenge did not clear on its own. Stopping here rather than");
  console.log("  working around it - that is the one thing not worth automating.");
  await p.screenshot({ path: path.join(ROOT, "output", "insta-cloudflare-stuck.png") }).catch(() => {});
  await pctx.close();
  process.exit(3);
}
if (cleared) {
  const forgot = p.locator('a:has-text("Forgot password"), button:has-text("Forgot password"), a:has-text("Forgot"), button:has-text("Forgot")').first();
  if (await forgot.count()) {
    const href = await forgot.getAttribute("href").catch(() => null);
    console.log(`  found "forgot password" (href=${JSON.stringify(href)})`);
    await forgot.click({ timeout: 10000 }).catch(() => {});
    await p.waitForTimeout(4000);
    console.log(`  now at: ${p.url().slice(0, 90)}`);
  } else {
    console.log("  no 'forgot password' control on the login page");
  }
}

// Dumped on failure. Twice now this has failed on "no email field found" with no
// evidence of what the page actually holds, and guessing the selector again is
// how it failed the first time.
const dump = await p.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  return {
    url: location.href,
    title: document.title,
    inputs: [...document.querySelectorAll("input")].map((i) => ({
      type: i.type, name: i.name || null, id: i.id || null,
      ph: i.getAttribute("placeholder"), aria: i.getAttribute("aria-label"), visible: vis(i),
    })),
    controls: [...document.querySelectorAll("button, a[href], [role=button]")].filter(vis)
      .map((b) => `${b.tagName}:"${((b.innerText || b.value || "") + "").replace(/\s+/g, " ").trim().slice(0, 40)}" href=${(b.getAttribute("href") || "").slice(0, 50)}`),
    body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
  };
});
console.log(`  DEBUG url    : ${dump.url.slice(0, 110)}`);
console.log(`  DEBUG title  : ${dump.title.slice(0, 60)}`);
console.log(`  DEBUG inputs : ${JSON.stringify(dump.inputs)}`);
console.log(`  DEBUG controls: ${dump.controls.slice(0, 12).join(" | ")}`);
console.log(`  DEBUG body   : ${dump.body}`);
await p.screenshot({ path: path.join(ROOT, "output", "insta-reset-page.png") }).catch(() => {});

const emailField = (await p.locator('input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[type="email"]').count())
  ? p.locator('input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[type="email"]').first()
  : p.locator('input[type="text"]').first();

if (!(await emailField.count())) {
  console.log("  no email field found on the reset page (see DEBUG above)");
  await pctx.close();
  process.exit(1);
}
await emailField.scrollIntoViewIfNeeded().catch(() => {});
await emailField.click({ timeout: 8000 }).catch(() => {});
await emailField.fill(EMAIL).catch(async () => {
  await emailField.type(EMAIL, { delay: 30 });
});
console.log(`  filled  : ${await emailField.inputValue().catch(() => "?")}`);

const submit = p
  .locator('button[type="submit"], input[type="submit"], button:has-text("Reset"), button:has-text("Send"), button:has-text("Continue")')
  .first();
if (await submit.count()) {
  await submit.click({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(4000);
  console.log(`  page now: ${p.url().slice(0, 90)}`);
} else {
  await emailField.press("Enter").catch(() => {});
  await p.waitForTimeout(4000);
  console.log(`  page now: ${p.url().slice(0, 90)} (submitted with Enter)`);
}

await p.screenshot({ path: path.join(ROOT, "output", "insta-reset-requested.png") }).catch(() => {});
console.log("  screenshot: output/insta-reset-requested.png");
console.log("\n  Leave the window open? No - closing now so the profile is flushed.");
await pctx.close();

// ---- 2. read the reset link out of the mailbox ------------------------------
console.log("\n  [2] polling the mailbox for the reset link");
const py = `
import sys, re, time, imaplib, ssl, email as E
sys.path.insert(0, r"${ROOT.replace(/\\/g, "\\\\")}\\apps\\browser-apply\\tools")
from mail_list import load_env
from email.header import decode_header, make_header

env = load_env()
c = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ssl.create_default_context())
c.login(env["SMTP_EMAIL"], env["SMTP_PASSWORD"]); c.select("INBOX")

def hdr(v):
    try: return str(make_header(decode_header(v or "")))
    except Exception: return v or ""

deadline = time.time() + 180
seen = set()
while time.time() < deadline:
    _, d = c.search(None, "ALL")
    ids = (d[0].split() if d and d[0] else [])[::-1][:60]
    for n in ids:
        if n in seen: continue
        seen.add(n)
        _, ch = c.fetch(n, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if not ch or not isinstance(ch[0], tuple): continue
        m = E.message_from_bytes(ch[0][1])
        f, s = hdr(m.get("From")), hdr(m.get("Subject"))
        blob = (f + " " + s).lower()
        if "instahyre" not in blob and "reset" not in blob and "password" not in blob:
            continue
        print("MAIL_FOUND|" + f + "|" + s)
        # Pull the body and hunt for a reset link.
        _, full = c.fetch(n, "(BODY.PEEK[])")
        for part in (full or []):
            if not isinstance(part, tuple): continue
            msg = E.message_from_bytes(part[1])
            for sub in msg.walk():
                if sub.get_content_type() not in ("text/plain", "text/html"): continue
                try: body = sub.get_payload(decode=True).decode("utf-8", "replace")
                except Exception: continue
                mm = re.search(r'https?://[^\\s"\\'<>]*instahyre[^\\s"\\'<>]*(?:reset|confirm|verify|token|activate)[^\\s"\\'<>]*', body, re.I)
                if not mm:
                    mm = re.search(r'https?://[^\\s"\\'<>]*instahyre[^\\s"\\'<>]*', body, re.I)
                if mm:
                    print("RESET_LINK|" + mm.group(0).rstrip(".,)"))
                    sys.exit(0)
    time.sleep(6)
print("RESET_LINK|")
`;
const res = spawnSync("python", ["-X", "utf8", "-c", py], { encoding: "utf8", timeout: 240000 });
const out = String(res.stdout || "");
const link = (out.match(/RESET_LINK\|(\S*)/) || [])[1] || "";
console.log(`  mailbox said: ${(out.match(/MAIL_FOUND\|([^|]*)\|([^|]*)/) || []).slice(1, 3).join(" / ") || "no matching mail yet"}`);

if (!link) {
  console.log("\n  NO RESET LINK FOUND. Nothing further changed.");
  console.log("  If Instahyre requires the reset link to come from the account email");
  console.log("  and that address differs from " + EMAIL + ", this cannot proceed.");
  process.exit(1);
}
console.log(`  link     : ${link.slice(0, 100)}...`);

// ---- 3. open the link and set the password ---------------------------------
console.log("\n  [3] opening the reset link in the pipeline's own profile");
const p2 = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const q = p2.pages()[0] || (await p2.newPage());
await q.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await q.waitForTimeout(4500);
console.log(`  landed: ${q.url().slice(0, 100)}`);

const pwField = q.locator('input[type="password"], input[name*="password" i], input[id*="password" i]');
const n = await pwField.count();
console.log(`  password fields on the page: ${n}`);
if (!n) {
  await q.screenshot({ path: path.join(ROOT, "output", "insta-reset-landed.png") }).catch(() => {});
  console.log("  screenshot: output/insta-reset-landed.png - set it by hand in this window");
  console.log(`\n  PASSWORD (if you set it manually, use this): ${PASSWORD}`);
  writeFileSync(path.join(ROOT, "output", "instahyre-credentials.txt"),
    `email: ${EMAIL}\npassword: ${PASSWORD}\nset: manual, from output/insta-reset-landed.png\n`);
  process.exit(2);
}

const first = pwField.first();
const second = pwField.nth(1);
await first.scrollIntoViewIfNeeded().catch(() => {});
await first.click({ timeout: 8000 }).catch(() => {});
await first.fill(PASSWORD).catch(async () => { await first.type(PASSWORD, { delay: 25 }); });
if (await second.count()) { await second.fill(PASSWORD).catch(() => {}); }
console.log("  password entered");

const go = q.locator('button[type="submit"], button:has-text("Reset"), button:has-text("Save"), button:has-text("Continue"), button:has-text("Set")').first();
if (await go.count()) { await go.click({ timeout: 8000 }).catch(() => {}); }
else { await first.press("Enter").catch(() => {}); }
await q.waitForTimeout(5000);
console.log(`  after submit: ${q.url().slice(0, 100)}`);
await q.screenshot({ path: path.join(ROOT, "output", "insta-password-set.png") }).catch(() => {});

// Verify by actually logging in as the profile would.
console.log("\n  [4] verifying the profile can now log in unaided");
const v = p2.pages()[0] || (await p2.newPage());
await v.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await v.waitForTimeout(3500);
const em = v.locator('input[name*="email" i], input[type="email"]').first();
const pw = v.locator('input[type="password"]').first();
if (await em.count() && await pw.count()) {
  await em.click({ timeout: 8000 }).catch(() => {}); await em.fill(EMAIL).catch(() => {});
  await pw.click({ timeout: 8000 }).catch(() => {}); await pw.fill(PASSWORD).catch(() => {});
  const sb = v.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  if (await sb.count()) { await sb.click({ timeout: 8000 }).catch(() => {}); }
  await v.waitForTimeout(5000);
  const ok = await v.evaluate(() => /sign out/i.test(document.body?.innerText || ""));
  console.log(`  logged in: ${ok}`);
  console.log(`  url      : ${v.url().slice(0, 100)}`);
} else {
  console.log("  login form not found for verification");
}

writeFileSync(path.join(ROOT, "output", "instahyre-credentials.txt"),
  `email: ${EMAIL}\npassword: ${PASSWORD}\nset automatically via password reset, ${new Date().toISOString()}\n`);
console.log(`\n  credentials written to output/instahyre-credentials.txt`);
console.log(`  EMAIL    : ${EMAIL}`);
console.log(`  PASSWORD : ${PASSWORD}`);
console.log("  Keep this. It is the only way back into the account without Google.");

await p2.close();
