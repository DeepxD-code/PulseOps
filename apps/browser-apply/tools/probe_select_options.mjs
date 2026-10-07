/**
 * Read the real option list of one react-select, scoped to that control.
 *
 * Job #333 blocked on "How would you characterize your technical skills?"
 * (#question_9035041005). An earlier probe typed into it and reported 249
 * options that were all COUNTRY DIALL CODES - "Afghanistan+93", "Albania+355".
 * That was a measurement error, not the control's content:
 *
 *   Greenhouse renders every react-select's full option set into the DOM for
 *   accessibility, closed or not. Querying [role="option"] document-wide
 *   therefore returns the union of all seven selects on the page, and the
 *   Country select alone has 249 entries, so it dominates the list.
 *
 * The correct read is scoped to the opened control's own subtree. This matters
 * beyond the probe: if apply.mjs's combo() resolves options document-wide it can
 * select an option belonging to a DIFFERENT question and write it into the
 * wrong field, which is a silent correctness bug rather than a visible failure.
 *
 * Opens the form, opens the target select, and reports:
 *   - which select actually expanded
 *   - the option list scoped to that select
 *   - whether document-wide and scoped reads disagree
 *
 * Fills nothing and submits nothing.
 */

import { chromium } from "playwright";

const URL = "https://job-boards.greenhouse.io/scaleai/jobs/4711544005";
const TARGET = "question_9035041005";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);

const apply = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
if (await apply.count()) {
  await apply.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

const sel = page.locator(`input[role="combobox"][id="${TARGET}"]`);
await sel.click({ timeout: 10000 });
await page.keyboard.type("e", { delay: 120 });
await page.waitForTimeout(1500);

const report = await page.evaluate((targetId) => {
  // Which selects claim to be open right now.
  const expanded = [...document.querySelectorAll('[role="combobox"][aria-expanded="true"]')].map(
    (n) => n.id,
  );

  // Scoped: walk up from the target to the nearest ancestor that actually
  // CONTAINS options. Matching on a class name is not enough - the input itself
  // is class "select__input", so a naive name match stops on the input and reads
  // zero options.
  const input = document.getElementById(targetId);
  let root = null;
  let e = input;
  for (let i = 0; i < 8 && e; i++) {
    if (e.querySelectorAll('[role="option"]').length) { root = e; break; }
    e = e.parentElement;
  }
  const scoped = root
    ? [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent.replace(/\s+/g, " ").trim())
    : [];

  // Unscoped, for comparison.
  const unscoped = [...document.querySelectorAll('[role="option"]')].map((o) =>
    o.textContent.replace(/\s+/g, " ").trim(),
  );

  return {
    targetExpanded: input?.getAttribute("aria-expanded"),
    expandedIds: expanded,
    rootClass: root ? String(root.className).slice(0, 60) : null,
    scopedCount: scoped.length,
    scopedOptions: scoped.slice(0, 30),
    unscopedCount: unscoped.length,
  };
}, TARGET);

console.log(`  target aria-expanded : ${report.targetExpanded}`);
console.log(`  selects expanded     : ${JSON.stringify(report.expandedIds)}`);
console.log(`  root class           : ${report.rootClass}`);
console.log(`\n  scoped to this select: ${report.scopedCount} option(s)`);
for (const o of report.scopedOptions) console.log(`    - ${o}`);
console.log(`\n  document-wide        : ${report.unscopedCount} option(s)  <-- what the old probe read`);
console.log(`  the two disagree     : ${report.scopedCount !== report.unscopedCount}`);

// Now open it with no filter, to get the complete list for this question.
await sel.click({ timeout: 5000 }).catch(() => {});
for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace").catch(() => {});
await page.keyboard.press("ArrowDown").catch(() => {});
await page.waitForTimeout(1200);

const full = await page.evaluate((targetId) => {
  const input = document.getElementById(targetId);
  let root = null;
  let e = input;
  for (let i = 0; i < 8 && e; i++) {
    if (e.querySelectorAll('[role="option"]').length) { root = e; break; }
    e = e.parentElement;
  }
  const opts = root
    ? [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent.replace(/\s+/g, " ").trim())
    : [];
  return { expanded: input?.getAttribute("aria-expanded"), count: opts.length, options: opts };
}, TARGET);

console.log(`\n  unfiltered, scoped   : ${full.count} option(s)`);
for (const o of full.options) console.log(`    - ${o}`);

await browser.close();
