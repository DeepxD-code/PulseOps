import { chromium } from "playwright";
import path from "node:path";

const PROFILE = path.join(path.resolve("."), ".edge-profile");
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const p = ctx.pages()[0] || (await ctx.newPage());
await p.goto("https://www.coursera.org/login?authMode=login",
  { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(5000);
const em = p.locator('input[type="email"]').first();
await em.click({ timeout: 8000 }).catch(() => {});
await em.fill("trex2004avradeep@gmail.com").catch(() => {});
const cont = p.locator('button:has-text("Continue")').first();
await cont.click({ timeout: 8000 }).catch(() => {});
await p.waitForTimeout(5000);
const d = await p.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  return {
    url: location.href,
    inputs: [...document.querySelectorAll("input")].filter(vis).map((i) => ({
      t: i.type, n: i.name || null, id: (i.id || "").slice(0, 30),
      ph: i.getAttribute("placeholder"), a: i.getAttribute("aria-label"),
    })),
    controls: [...document.querySelectorAll("button, a[href], [role=button]")]
      .filter(vis)
      .map((b) => `<${b.tagName}> "${((b.innerText || b.value || "") + "").replace(/\s+/g, " ").trim().slice(0, 44)}"`)
      .slice(0, 16),
    body: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
  };
}).catch(() => null);
console.log(JSON.stringify(d, null, 1).slice(0, 2200));
await ctx.close();
