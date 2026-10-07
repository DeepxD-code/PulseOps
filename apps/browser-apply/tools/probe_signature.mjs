/**
 * Measure the real controlSignatureMatcher() against Scale AI's live form.
 *
 * Why this exists. Two questions blocked #333 and neither earlier guess was
 * right:
 *
 *   - "How would you characterize your technical skills?" - combo() logged
 *     "no control matched (8 combobox checked)". Its control is a react-select
 *     carrying NO aria-label; the prompt arrives only via
 *     aria-labelledby="question_9035041005-label". controlSignatureMatcher()
 *     builds its own-attribute text from aria-label, id, name, placeholder and
 *     data-placeholder, and never resolves aria-labelledby.
 *   - "Are you fluent or proficient in Arabic?" - a plain input that DOES carry
 *     an aria-label, and is now answered.
 *
 * Whether the ancestor walk rescues the skills select is not knowable by reading
 * the matcher: it depends on which wrapper first yields non-empty text after
 * stripping widget internals. That is exactly the kind of thing to measure
 * instead of assume, so this extracts the matcher verbatim from apply.mjs and
 * runs it against every combobox on the live form.
 *
 * Extraction is by source text so the tested function is the shipped one - no
 * reimplementation that could drift from it and quietly prove nothing.
 *
 * Read-only: opens the form, reads signatures, fills nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const SRC = "apps/browser-apply/apply.mjs";

// --- extract the matcher verbatim -------------------------------------------
const text = readFileSync(SRC, "utf8");
const start = text.indexOf("function controlSignatureMatcher() {");
if (start < 0) {
  console.error("  controlSignatureMatcher not found in apply.mjs");
  process.exit(1);
}
let depth = 0;
let end = -1;
for (let i = text.indexOf("{", start); i < text.length; i++) {
  if (text[i] === "{") depth++;
  else if (text[i] === "}") {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
const fnSource = text.slice(start, end);
console.log(`  extracted matcher: ${fnSource.length} chars\n`);

const tmp = "apps/browser-apply/tools/.sigmatcher.mjs";
writeFileSync(tmp, `export ${fnSource}\n`, "utf8");
const { controlSignatureMatcher } = await import(`./.sigmatcher.mjs?v=${Date.now()}`);

// --- the hints that failed ---------------------------------------------------
const HINTS = [
  ["technical skills", /characteri[sz]e your technical skills|describe your technical skills|your technical strengths/i],
  ["in-person availability", /in person|in-person|office \d+ times? a week/i],
  ["non-compete", /bound by any agreements? with a current or former employer|non-?compete/i],
  ["work authorisation", /legally authorized to work|work authorization/i],
  ["visa sponsorship", /require company sponsorship|visa support|sponsorship/i],
];

const URL = process.argv[2] || "https://job-boards.greenhouse.io/scaleai/jobs/4711544005";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
const apply = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
if (await apply.count()) {
  await apply.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

const boxes = page.locator('[role="combobox"]');
const total = await boxes.count();
console.log(`  ${total} combobox(es) on the form\n`);

const matches = [];
for (let i = 0; i < total; i++) {
  const box = boxes.nth(i);
  if (!(await box.isVisible().catch(() => false))) continue;
  const sig = await box.evaluate(controlSignatureMatcher()).catch((e) => `MATCHER-FAILED: ${e.message}`);

  // The information the matcher throws away.
  const labelledby = await box.evaluate((el) => {
    const by = el.getAttribute("aria-labelledby");
    if (!by) return null;
    return [...by.split(/\s+/)].map((x) => document.getElementById(x)?.textContent?.replace(/\s+/g, " ").trim() ?? null).join(" | ");
  }).catch(() => null);

  console.log(`  [#${i}] ${box ? "" : ""}${await box.getAttribute("id")}`);
  console.log(`      aria-labelledby -> ${labelledby ? JSON.stringify(labelledby.slice(0, 90)) : "null"}`);
  console.log(`      signature       -> ${JSON.stringify(String(sig).replace(/\s+/g, " ").trim().slice(0, 150))}`);
  for (const [tag, re] of HINTS) {
    if (re.test(String(sig))) matches.push({ i, tag });
  }
  console.log("");
}

console.log("  === hint matches against the shipped signature ===");
if (!matches.length) console.log("    (none - every hint missed every control)");
for (const m of matches) console.log(`    control #${m.i} matched "${m.tag}"`);

// Report, per control, whether a hint WOULD match if aria-labelledby were resolved.
console.log("\n  === same hints, but against the aria-labelledby text instead ===");
let rescued = 0;
for (let i = 0; i < total; i++) {
  const box = boxes.nth(i);
  if (!(await box.isVisible().catch(() => false))) continue;
  const lab = await box.evaluate((el) => {
    const by = el.getAttribute("aria-labelledby");
    if (!by) return el.getAttribute("aria-label") || "";
    return [...by.split(/\s+/)].map((x) => document.getElementById(x)?.textContent ?? "").join(" ");
  }).catch(() => "");
  for (const [tag, re] of HINTS) {
    if (re.test(lab)) { console.log(`    control #${i} would match "${tag}"`); rescued++; }
  }
}
console.log(`\n  ${rescued} match(es) currently unreachable because aria-labelledby is not resolved`);

await browser.close();
