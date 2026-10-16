/**
 * Watch exactly what Instahyre's "Apply now" does.
 *
 * The pipeline logs `[submit] clicked final Apply now` and then nothing - no
 * second navigation, no confirmation - so all 21 attempts today stopped at that
 * line. Two possible causes, opposite fixes:
 *
 *   (a) the click opens an outbound hop the navigation guard refuses  -> the
 *       guard is too strict for the legitimate final step of an application
 *   (b) the click opens a modal, a login wall or an interstitial and never
 *       reaches a form  -> nothing to widen
 *
 * Guessing would mean loosening a security guard on a hunch. So this clicks the
 * control with no guard installed and reports where the browser actually lands.
 *
 * Read-only: it clicks "Apply now" to observe the redirect and stops. It does not
 * fill or submit anything.
 */

import { chromium } from "playwright";

const URL =
  "https://www.instahyre.com/job-444263-ai-ml-engineer-at-accenture-2-gurgaon-kolkata/";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const seen = [];
page.on("framenavigated", (f) => seen.push(["frame", f.url()]));
page.on("popup", (pp) => seen.push(["popup", pp.url()]));

console.log(`  goto ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

console.log(`  title: ${await page.title()}`);
console.log(`  url  : ${page.url()}`);

const buttons = page.locator("button, a");
const total = await buttons.count();
let target = null;
for (let i = 0; i < Math.min(total, 300); i++) {
  const el = buttons.nth(i);
  if (!(await el.isVisible().catch(() => false))) continue;
  const txt = ((await el.innerText().catch(() => "")) || "").trim().toLowerCase();
  if (!txt.startsWith("apply")) continue;
  target = el;
  const tag = await el.evaluate((e) => e.tagName);
  const href = await el.getAttribute("href");
  console.log(`  found #${i}: <${tag}> text=${JSON.stringify(txt.slice(0, 40))} href=${JSON.stringify(href)}`);
  break;
}

if (!target) {
  console.log("  no visible Apply control found");
  await browser.close();
  process.exit(1);
}

console.log("  clicking Apply now ...");
await target.click({ timeout: 15000 }).catch((e) => console.log(`  click failed: ${String(e).slice(0, 120)}`));
await page.waitForTimeout(9000);

console.log(`\n  url after click : ${page.url()}`);
console.log(`  title           : ${await page.title()}`);
console.log(`  frames          : ${page.frames().length}`);
for (const [kind, u] of seen) console.log(`    ${kind}: ${String(u).slice(0, 120)}`);

console.log("\n  --- controls present now ---");
for (const sel of ["h1", "h2", "[role=dialog]", "form", "input[type=email]",
                   "input[type=tel]", "input[type=text]", "textarea", "iframe",
                   "button[type=submit]"]) {
  const n = await page.locator(sel).count().catch(() => 0);
  if (n) console.log(`    ${sel.padEnd(20)} x${n}`);
}

const body = await page.locator("body").innerText().catch(() => "");
const flat = body.replace(/\s+/g, " ").trim();
console.log(`\n  body text (${flat.length} chars):`);
console.log("   ", flat.slice(0, 1400));

await browser.close();