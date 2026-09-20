import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const page = await ctx.newPage();
await page.goto("https://www.naukri.com/mnjuser/appliedjobs", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.locator("button:has-text('Accept all')").first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.evaluate(() => window.scrollBy(0, 800));
await page.waitForTimeout(2000);
const jobs = await page.evaluate(() => {
  const t = document.body?.innerText || "";
  const m = t.match(/Python - Backend Developer Intern[\s\S]{0,120}/);
  return { hasWisdom: /Wisdom Square/i.test(t), snippet: (m ? m[0] : t.slice(0, 300)).slice(0, 300) };
});
console.log(JSON.stringify(jobs, null, 1));
await browser.close();
