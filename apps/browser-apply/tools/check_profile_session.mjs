/**
 * Report the real sign-in state inside the pipeline's persistent profile.
 *
 * "230 files changed in .edge-profile in the last 20 minutes" looked like evidence
 * that the operator had signed in there. It is not: every --edge run writes cache,
 * history and profile data on exit, so the count rises whether or not anyone
 * signed in. Inferring a session from filesystem timestamps would have been
 * exactly the kind of convenient guess this whole exercise has been correcting.
 *
 * So this asks the two questions that actually matter, in the profile the pipeline
 * uses:
 *   1. is Google authenticated there?
 *   2. is Instahyre authenticated there, and has onboarding been completed?
 *
 * Read-only. Opens pages, reads text, closes. Signs in to nothing and clicks
 * nothing that changes state.
 */

import { chromium } from "playwright";
import path from "node:path";

const PROFILE = path.resolve(".edge-profile");

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: true,
  viewport: { width: 1366, height: 900 },
});

// A Cloudflare interstitial is not page content. Reading "verifies you are not a
// bot" as the page and concluding "not signed in" is reporting on the wrong
// thing, so it gets its own outcome and no verdict is drawn from it.
const CLOUDFLARE_RE =
  /performing security verification|verifies you are not a bot|just a moment|checking your browser|enable javascript and cookies/i;

const read = async (url) => {
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(4500);
    const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return { url: p.url(), body, blocked: CLOUDFLARE_RE.test(body) };
  } finally {
    await p.close().catch(() => {});
  }
};

const verdict = (r, signedInTest) => {
  if (r.blocked) return "COULD NOT READ (Cloudflare interstitial - no verdict)";
  return signedInTest(r) ? "signed in" : "NOT signed in";
};

// 1. Google - judged on the URL alone. accounts.google.com bounces an
// unauthenticated visitor to /v3/signin/identifier, so that path is proof of
// logged-out. The previous body-text test matched Google's own "Use your Google
// Account" boilerplate and called a signed-out page signed-in.
const g = await read("https://accounts.google.com/");
const googleOut = /\/v3\/signin\/identifier|\/ServiceLogin|accounts\.google\.com\/signin/i.test(g.url);
console.log(`  GOOGLE   url : ${g.url.slice(0, 100)}`);
console.log(`  GOOGLE   auth: ${g.blocked ? "COULD NOT READ (Cloudflare)" : googleOut ? "NOT signed in" : "signed in"}`);
console.log(`           head: ${g.body.slice(0, 140)}\n`);

// 2. Instahyre - its authenticated header renders SIGN OUT.
const i = await read("https://www.instahyre.com/");
console.log(`  INSTA    url : ${i.url.slice(0, 100)}`);
console.log(`  INSTA    auth: ${verdict(i, (r) => /sign out/i.test(r.body))}`);
console.log(`           head: ${i.body.slice(0, 160)}\n`);

const j = await read("https://www.instahyre.com/candidates/register/");
console.log(`  REGISTER url : ${j.url.slice(0, 100)}`);
console.log(`  REGISTER auth: ${verdict(j, (r) => /sign out/i.test(r.body))}`);
console.log(`           head: ${j.body.slice(0, 160)}\n`);

const k = await read("https://www.instahyre.com/candidate/onboard/");
console.log(`  ONBOARD  url : ${k.url.slice(0, 100)}`);
if (k.blocked) {
  console.log("  ONBOARD  steps: COULD NOT READ (Cloudflare interstitial - no verdict)");
} else {
  const steps = ["Add skills", "Job preferences", "Upload resume", "Privacy settings"].filter((s) =>
    k.body.toLowerCase().includes(s.toLowerCase()),
  );
  console.log(`  ONBOARD  steps still shown: ${steps.length ? steps.join(", ") : "(none - looks complete)"}`);
  console.log(`           head: ${k.body.slice(0, 260)}`);
}

await ctx.close();
