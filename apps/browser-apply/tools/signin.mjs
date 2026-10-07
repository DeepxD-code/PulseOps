/**
 * One-time sign-in, in the profile the pipeline actually uses.
 *
 * Ten of the twelve unconfirmed applications are Instahyre, and all ten stop at
 * the same place. Measured, not inferred: clicking "Apply now" navigates the
 * current tab to
 *
 *     https://www.instahyre.com/candidates/register/
 *
 * so the blocker is neither Cloudflare nor an outbound redirect to the employer's
 * ATS. Instahyre requires a candidate account before it will accept an
 * application, and 21 attempts ended against that wall without anyone noticing,
 * because the log only recorded "clicked final Apply now" and then nothing.
 *
 * The signup page offers "Sign up with LinkedIn" and "Sign up with Google", or a
 * name/email/password form. Registering is the account holder's action, not the
 * agent's: it involves accepting the Terms of Service on someone's behalf and
 * choosing a credential. So this script does not do it. It opens the real
 * persistent profile the pipeline uses and waits, so the operator signs in once
 * by hand and every later run inherits the session.
 *
 * Why the persistent profile specifically. apply.mjs has two launch paths: the
 * default chromium.launch(), which keeps no profile between runs, and --edge,
 * which uses launchPersistentContext() against .edge-profile. A session created
 * in a throwaway browser is discarded when that browser exits, so signing in
 * anywhere else - including a separate automation window - changes nothing for
 * the pipeline. Signing in HERE does.
 *
 * Usage:
 *   node apps/browser-apply/tools/signin.mjs instahyre
 *   node apps/browser-apply/tools/signin.mjs wellfound
 *
 * The window stays open until you close it. Closing it is what saves the session,
 * so do not kill the process instead.
 */

import { chromium } from "playwright";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");

const TARGETS = {
  instahyre: "https://www.instahyre.com/candidates/register/",
  wellfound: "https://wellfound.com/",
  linkedin: "https://www.linkedin.com/",
};

const which = String(process.argv[2] || "instahyre").toLowerCase();
const url = TARGETS[which];
if (!url) {
  console.error(`  unknown target "${which}". known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
if (!existsSync(PROFILE)) {
  console.error(`  persistent profile not found at ${PROFILE}`);
  console.error("  run apply.mjs with --edge once first to create it");
  process.exit(1);
}

console.log(`  profile : ${PROFILE}`);
console.log(`  opening : ${url}\n`);
console.log("  ---------------------------------------------------------------");
console.log("   Sign in now, in that window. Then CLOSE the window.");
console.log("   Closing it is what writes the session to disk - killing this");
console.log("   process instead will lose it.");
console.log("  ---------------------------------------------------------------\n");

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

// Wait for the operator to finish, then close so the profile is flushed.
await new Promise((resolve) => {
  let settled = false;
const done = async () => {
    if (settled) return;
    settled = true;
    console.log("\n  window closed - checking whether the session persisted...\n");

    // Explicitly no verdict until a page has actually been read. This script
    // exists to answer one question, and answering it from an empty body after a
    // crash is how it previously reported success on its one unverifiable run.
    let body = "";
    let landed = null;
    try {
      const check = await chromium.launchPersistentContext(PROFILE, {
        channel: "msedge",
        headless: true,
      });
      try {
        const p = check.pages()[0] || (await check.newPage());
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await p.waitForTimeout(5000);
        landed = p.url();
        body = (await p.locator("body").innerText()).replace(/\s+/g, " ").trim();
      } finally {
        await check.close().catch(() => {});
      }
    } catch (e) {
      console.log(`  COULD NOT VERIFY: ${String(e.message || e).slice(0, 150)}`);
      console.log("  No verdict is possible. Treat the session as NOT confirmed and");
      console.log("  re-run this script, signing in before closing the window.");
      resolve();
      return;
    }

    if (landed) console.log(`  landed: ${String(landed).slice(0, 110)}`);
    if (!body) {
      console.log("  COULD NOT VERIFY: the page rendered no text.");
      console.log("  No verdict is possible - re-run and check the window yourself.");
      resolve();
      return;
    }

    // Report what was observed, not a single optimistic boolean.
    const askingToRegister = /sign ?up|candidate sign ?up|create an account|log ?in/i.test(
      body.slice(0, 600),
    );
    const signedIn = /sign out/i.test(body);
    console.log(`  shows a sign-up/log-in prompt: ${askingToRegister}`);
    console.log(`  shows a signed-in marker (SIGN OUT): ${signedIn}`);
    if (askingToRegister) {
      console.log("  session: NOT persisted - still being asked to register.");
      console.log("  The pipeline will hit the same auth wall on the next run.");
    } else if (signedIn) {
      console.log("  session: persisted. The pipeline will inherit it.");
    } else {
      console.log("  session: UNKNOWN - neither a wall nor a signed-in marker.");
      console.log("  Re-run apps/browser-apply/tools/check_profile_session.mjs for detail.");
    }
    resolve();
  };

  ctx.on("close", done);
  // Also exit if the operator just closes the last tab.
  const iv = setInterval(() => {
    if (settled) { clearInterval(iv); return; }
    try {
      if (ctx.pages().length === 0) done();
    } catch { /* context already closing */ }
  }, 2000);
});
