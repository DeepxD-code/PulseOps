/**
 * Identify the real control behind Scale AI's business-travel question.
 *
 * #716 ("Applied AI Engineer, Global Public Sector") is blocked on exactly one
 * field: "Are you ready to go on business trips every 6-8 weeks?". The operator
 * has answered it - he is okay to travel - and it is registered as a commitment,
 * but the field stays empty:
 *
 *     [combo] business trips?|travel ... : no control matched (7 combobox checked)
 *     [blocked-by] required fields still empty: Are you ready to go on business
 *                  trips every 6-8 weeks?
 *
 * So it is not a react-select. A radio() fallback was added and it matched
 * nothing either, which means the inputs either carry no name attribute or are a
 * third widget type. Guessing has been wrong three times on this form already -
 * the Arabic question was assumed to be a radio and was a plain text input, and
 * the technical-skills question was assumed to be free text and was a five-option
 * select - so this measures the DOM instead.
 *
 * Reports, for the question's own field group: every element, its tag, type,
 * role, name, id, and the classes a handler could key on. Also reports what
 * radio() keys on, so the two can be compared directly.
 *
 * Read-only. Fills nothing, submits nothing.
 */

import { chromium } from "playwright";

const URL = "https://job-boards.greenhouse.io/scaleai/jobs/4413992005";
const QUESTION = /business trips? every\s*6\s*-\s*8|6-8 weeks/i;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
const apply = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
if (await apply.count()) {
  await apply.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

const found = await page.evaluate((src) => {
  const re = new RegExp(src, "i");

  // Locate the group by walking up from any element whose text contains the
  // question, rather than searching for the field directly.
  let anchor = null;
  for (const el of document.querySelectorAll("label, legend, div, span, p")) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (re.test(t) && t.length < 400) { anchor = el; break; }
  }
  if (!anchor) return { found: false };

  // Climb to the smallest wrapper that still contains any form control, which
  // is this question's own group and not the whole form.
  let group = anchor;
  for (let i = 0; i < 6; i++) {
    if (group.querySelectorAll("input,textarea,select,[role]").length) break;
    if (!group.parentElement) break;
    group = group.parentElement;
  }

  const controls = [...group.querySelectorAll("input,textarea,select,button,[role]")].map((el) => ({
    tag: el.tagName,
    type: el.getAttribute("type"),
    role: el.getAttribute("role"),
    name: el.getAttribute("name"),
    id: el.id || null,
    value: (el.value || "").slice(0, 30) || null,
    ariaLabel: el.getAttribute("aria-label"),
    ariaLabelledby: el.getAttribute("aria-labelledby"),
    classes: String(el.className || "").slice(0, 70),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
  }));

  return {
    found: true,
    question: (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    groupTag: group.tagName,
    groupClasses: String(group.className || "").slice(0, 90),
    groupHTML: group.outerHTML.slice(0, 1200),
    controls,
  };
}, QUESTION.source);

console.log(`  question located : ${found.found}`);
if (!found.found) {
  await browser.close();
  process.exit(1);
}
console.log(`  text             : ${found.question}`);
console.log(`  group            : <${found.groupTag}> class="${found.groupClasses}"`);
console.log(`\n  controls inside the group (${found.controls.length}):`);
for (const c of found.controls) {
  console.log(`    <${c.tag}> type=${c.type} role=${c.role}`);
  console.log(`       name=${JSON.stringify(c.name)} id=${JSON.stringify(c.id)} value=${JSON.stringify(c.value)}`);
  console.log(`       class=${JSON.stringify(c.classes)}`);
  if (c.text) console.log(`       text=${JSON.stringify(c.text)}`);
}
console.log(`\n  --- group HTML ---\n  ${found.groupHTML}`);

await browser.close();
