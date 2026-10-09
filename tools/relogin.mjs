/**
 * Re-establish a password session in the pipeline's own browser profile.
 *
 * Needed because a session expires. The 2026-10-09 full run processed 2 eligible
 * jobs and both stopped at:
 *
 *     [sso] auth wall at .../candidates/register/ — pressing "Sign up with Google"
 *     [sso] Google is asking for credentials — stopping without entering anything
 *
 * The Instahyre password set on 2026-10-08 no longer holds. Re-running the reset
 * would be wrong - it changes the credential and mails the operator again for no
 * reason. This simply logs in with the credential already on disk.
 *
 * This is why the password route was worth doing at all: a password can be
 * replayed unattended forever, whereas a Google sign-in needs a human every time
 * it lapses. That is the whole difference between a pipeline that recovers from an
 * expired session on its own and one that stops dead.
 *
 * Usage:
 *   node tools/relogin.mjs instahyre
 *   node tools/relogin.mjs instahyre --verify
 *
 * Credentials come from output/<board>-credentials.txt, written when the password
 * was first set. Never from argv, so it cannot end up in shell history.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");
const which = String(process.argv[2] || "instahyre").toLowerCase();

const LOGIN = {
  instahyre: "https://www.instahyre.com/login/",
  wellfound: "https://wellfound.com/login",
  naukri: "https://www.naukri.com/nlogin/login",
};

const credFile = path.join(ROOT, "output", `${which}-credentials.txt`);
if (!existsSync(credFile)) {
  console.error(`  no credentials at output/${which}-credentials.txt`);
  console.error("  run tools/board_login.mjs " + which + " once to set a password");
  process.exit(1);
}

// Only the two keys it needs. Parsing every "key: value" line let the
// "set automatically via password reset, 2026-10-08T13:41:51.557Z" line in, whose
// split-on-first-colon key is a whole sentence - and the resulting object was then
// missing the real keys.
const creds = {};
for (const line of readFileSync(credFile, "utf8").split("\n")) {
  const at = line.indexOf(":");
  if (at < 0) continue;
  const key = line.slice(0, at).trim().toLowerCase();
  if (key !== "email" && key !== "password") continue;
  creds[key] = line.slice(at + 1).trim();
}
const email = creds["email"];
const password = creds["password"];
if (!email || !password) {
  console.error(`  ${credFile} is missing email or password`);
  console.error(`  parsed: ${JSON.stringify(Object.keys(creds))}`);
  process.exit(1);
}

console.log(`  board  : ${which}`);
console.log(`  profile: ${PROFILE}`);
console.log(`  account: ${email}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(LOGIN[which], { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);

const VIS = `const vis=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};`;

// Already signed in? Then there is nothing to do, and that is worth reporting
// rather than blankly re-authenticating.
const before = await page.evaluate(() => /sign out|log out|my account/i.test(document.body?.innerText || ""));
console.log(`  already signed in : ${before}`);

if (!before) {
  const em = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[type="text"]').first();
  const pw = page.locator('input[type="password"], input[name*="password" i], input[id*="password" i]').first();
  if (!(await em.count()) || !(await pw.count())) {
    console.log("  no email/password pair on the login page; leaving it to you");
    await page.screenshot({ path: path.join(ROOT, "output", `${which}-relogin-blocked.png`) }).catch(() => {});
    await ctx.close();
    process.exit(2);
  }
  await em.scrollIntoViewIfNeeded().catch(() => {});
  await em.click({ timeout: 8000 }).catch(() => {});
  await em.fill(email).catch(async () => { await em.type(email, { delay: 25 }); });
  await pw.click({ timeout: 8000 }).catch(() => {});
  await pw.fill(password).catch(async () => { await pw.type(password, { delay: 25 }); });
  console.log(`  filled  : ${await em.inputValue().catch(() => "?")}`);

  const submit = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Submit")').first();
  if (await submit.count()) await submit.click({ timeout: 8000 }).catch(() => {});
  else await pw.press("Enter").catch(() => {});
  await page.waitForTimeout(6000);
}

const after = await page.evaluate(() => ({
  signedIn: /sign out|log out|my account|my profile|messages|ready to interview/i.test(document.body?.innerText || ""),
  url: location.href,
  title: document.title,
}));
console.log(`  signed in after : ${after.signedIn}`);
console.log(`  url             : ${after.url.slice(0, 90)}`);
console.log(`  title           : ${after.title.slice(0, 50)}`);

// Verify the thing that actually matters: a job page is reachable.
const check = await page.goto("https://www.instahyre.com/job-444263-ai-ml-engineer-at-accenture-2-gurgaon-kolkata/", {
  waitUntil: "domcontentloaded", timeout: 60000,
}).then(() => page.waitForTimeout(5000)).then(() => page.evaluate(() => ({
  wall: /\/(candidates\/register|login)\//i.test(location.pathname),
  signedIn: /sign out/i.test(document.body?.innerText || ""),
  url: location.href,
}))).catch((e) => ({ err: String(e).slice(0, 80) }));

console.log(`  job page reached: ${check.wall ? "NO - still on the wall" : "yes"}`);
console.log(`  signed in there : ${check.signedIn}`);
console.log(`  landing url     : ${(check.url || "").slice(0, 90)}`);

await page.screenshot({ path: path.join(ROOT, "output", `${which}-relogin.png`) }).catch(() => {});
await ctx.close();
process.exit(check.wall ? 3 : 0);
