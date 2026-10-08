/**
 * Read Instahyre's password-reset page so the form can actually be targeted.
 *
 * "no email field found on the reset page" - the guessed URL and the guessed
 * selector were both wrong, and neither was checked before the script tried to
 * fill them. This reads the page instead of assuming its shape.
 *
 * Reports, for the reset URL and the login page: every input with its type, name,
 * id, placeholder and aria-label; every visible control with its label; and any
 * link or button that looks like a reset entry point.
 *
 * Read-only. Types nothing, submits nothing.
 */

import { chromium } from "playwright";
import path from "node:path";

const PROFILE = path.resolve(".edge-profile");

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: true,
  viewport: { width: 1366, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

for (const url of [
  "https://www.instahyre.com/password/reset/",
  "https://www.instahyre.com/forgot-password/",
  "https://www.instahyre.com/login/",
]) {
  console.log(`\n=== ${url} ===`);
  let landed = url;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    landed = page.url();
  } catch (e) {
    console.log(`  navigation failed: ${String(e).slice(0, 90)}`);
    continue;
  }
  console.log(`  landed: ${landed.slice(0, 110)}  title: ${(await page.title()).slice(0, 50)}`);

  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const inputs = [...document.querySelectorAll("input")].map((i) => ({
      type: i.type, name: i.name || null, id: i.id || null,
      ph: i.getAttribute("placeholder"), aria: i.getAttribute("aria-label"),
      visible: vis(i),
    }));
    const controls = [...document.querySelectorAll("button, a[href], [role=button]")]
      .filter(vis)
      .map((b) => ({
        tag: b.tagName,
        text: ((b.innerText || b.value || "") + "").replace(/\s+/g, " ").trim().slice(0, 44),
        href: (b.getAttribute("href") || "").slice(0, 60),
      }))
      .filter((c) => c.text)
      .slice(0, 18);
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 320);
    return { inputs, controls, body };
  });

  console.log(`  inputs (${info.inputs.length}):`);
  for (const i of info.inputs) {
    console.log(`    type=${i.type} name=${JSON.stringify(i.name)} id=${JSON.stringify(i.id)} ph=${JSON.stringify(i.ph)} aria=${JSON.stringify(i.aria)} visible=${i.visible}`);
  }
  console.log(`  visible controls:`);
  for (const c of info.controls) console.log(`    <${c.tag}> ${JSON.stringify(c.text)} ${c.href ? "-> " + c.href : ""}`);
  console.log(`  body: ${info.body}`);
}

await ctx.close();
