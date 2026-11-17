/**
 * Dump the controls on a page, as the DOM actually renders them.
 *
 * Written for the multi-step forms the applier stalls on: a wizard whose only
 * advance control is "Next" is read by the walker as a form with no navigation
 * control at all, and the reason is always in the element itself - an
 * <input type=submit value="Next">, an <a>, a role="button" div, or a button
 * that only looks like one.
 *
 *   node apps/browser-apply/tools/dump_controls.mjs <url>
 */
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("usage: dump_controls.mjs <url>");
  process.exit(1);
}

const CDP = process.env.PULSEOPS_CDP_URL || "http://127.0.0.1:9333";
const browser = await chromium.connectOverCDP(CDP, { timeout: 30000 });
const context = browser.contexts()[0] || (await browser.newContext());
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(5000);

const controls = await page.evaluate(() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const describe = (el) => {
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      text: norm(el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 40),
      id: el.id || "",
      cls: norm(el.className || "").slice(0, 50),
      visible,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    };
  };
  const all = [...document.querySelectorAll("button, a, input[type=submit], input[type=button], [role=button]")]
    .map(describe)
    .filter((c) => c.text || c.type);
  const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    required: el.required === true || el.getAttribute("aria-required") === "true",
    label: norm(
      (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || "",
    ).slice(0, 60),
  }));
  return { url: location.href, title: document.title, controls: all.slice(0, 30), fields: fields.slice(0, 30) };
});

console.log(JSON.stringify(controls, null, 1));
await page.close().catch(() => {});
process.exit(0);
