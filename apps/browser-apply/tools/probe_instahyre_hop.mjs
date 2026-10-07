/**
 * What does Instahyre's "Apply now" actually do, seen from the persistent profile?
 *
 * Ten of the twelve unconfirmed applications are Instahyre, and every one stops
 * at the same line: "[submit] clicked final Apply now" and then nothing - no
 * confirmation, no second navigation. 21 attempts have ended there.
 *
 * Three things have already been ruled out, so this does not repeat them:
 *
 *   - the click is not blocked. The only [subresource-block] lines are analytics
 *     (Cloudflare Insights beacon, Sentry, GTM, LinkedIn insight); the apply
 *     handler's own JS loads.
 *   - it is not the outbound-navigation guard refusing a hop to the employer's
 *     ATS. Bare Playwright gets "Just a moment..." from Cloudflare, so the hop
 *     was never reachable from that probe, but --edge with the persistent profile
 *     clears Cloudflare and still stops at the same line with no second
 *     navigation logged.
 *   - it is not a link. href is undefined; the control is a JS-handled button.
 *
 * So the remaining possibilities are that it opens a NEW TAB, opens a MODAL or
 * LOGIN WALL, or POSTs to an API and shows a success state inline. Those have
 * different fixes, and guessing between them is what has produced two wrong
 * diagnoses already. This reports what the click produces: every page the context
 * now owns, dialogs, new tabs, frames, and what is on the page afterwards.
 *
 * Uses the same persistent profile as --edge, so this is the real run's view.
 * Clicks "Apply now" to observe the redirect and stops. Fills nothing, submits
 * nothing.
 */

import { chromium } from "playwright";
import path from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");
const URL =
  "https://www.instahyre.com/job-444263-ai-ml-engineer-at-accenture-2-gurgaon-kolkata/";
const SHOTS = path.join(ROOT, "output", "probe-instahyre");
mkdirSync(SHOTS, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});

const before = ctx.pages().length;
const page = ctx.pages()[0] || (await ctx.newPage());

const dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`);
  await d.dismiss().catch(() => {});
});

console.log(`  goto ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);

console.log(`  title  : ${await page.title()}`);
console.log(`  url    : ${page.url()}`);
console.log(`  pages before click: ${before}`);

const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
console.log(`  cloudflare interstitial: ${/just a moment|verify you are human|checking your browser/i.test(body)}`);
console.log(`  body length: ${body.length}`);
console.log(`  body head  : ${body.slice(0, 300)}`);

// Locate the Apply control.
const buttons = page.locator("button, a");
const total = await buttons.count();
let target = null;
for (let i = 0; i < Math.min(total, 300); i++) {
  const el = buttons.nth(i);
  if (!(await el.isVisible().catch(() => false))) continue;
  const txt = ((await el.innerText().catch(() => "")) || "").trim().toLowerCase();
  if (!txt.startsWith("apply")) continue;
  target = el;
  console.log(`  control #${i}: <${await el.evaluate((e) => e.tagName)}> ${JSON.stringify(txt.slice(0, 40))}`);
  break;
}
if (!target) {
  console.log("  no visible Apply control");
  await ctx.close();
  process.exit(1);
}

console.log("\n  clicking Apply now ...");
await target.click({ timeout: 20000 }).catch((e) => console.log(`  click error: ${String(e).slice(0, 140)}`));
await page.waitForTimeout(12000);

const after = ctx.pages();
console.log(`\n  pages after click: ${after.length}  (was ${before})`);
// forEach cannot await, so collect then print.
const pages = [];
for (const [i, p] of after.entries()) {
  pages.push({ i, url: p.url(), title: await p.title().catch(() => "") });
}
for (const p of pages) {
  console.log(`    [${p.i}] ${p.url.slice(0, 130)}`);
  console.log(`        title: ${String(p.title).slice(0, 90)}`);
}

if (dialogs.length) {
  console.log("\n  dialogs:");
  for (const d of dialogs) console.log(`    ${d}`);
}

console.log("\n  --- controls present after the click ---");
for (const sel of [
  "h1", "h2", "[role=dialog]", "form", "input[type=email]", "input[type=tel]",
  "input[type=text]", "textarea", "iframe", "button[type=submit]",
  "button:has-text('Submit')", "a:has-text('Submit')",
]) {
  const n = await page.locator(sel).count().catch(() => 0);
  if (n) console.log(`    ${sel.padEnd(28)} x${n}`);
}

const afterBody = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
console.log(`\n  body after click (${afterBody.length} chars):`);
console.log(`   ${afterBody.slice(0, 1500)}`);

// Did anything look like a success or an error?
for (const [tag, re] of [
  ["SUCCESS", /applied|application (?:has been )?sent|submitted successfully|we(?:'ve| have) received your application|thank you for applying/i],
  ["ERROR", /something went wrong|an error occurred|try again|unable to/i],
  ["LOGIN", /log ?in|sign ?in|create an account|register/i],
]) {
  const hit = afterBody.match(re);
  if (hit) console.log(`\n  [${tag}] matched: ${JSON.stringify(hit[0])}`);
}

const shot = path.join(SHOTS, "after-click.png");
await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
console.log(`\n  screenshot: ${shot}`);

await ctx.close();
