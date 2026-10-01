import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const p = await ctx.newPage();
await p.goto("https://www.workatastartup.com/conversations", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(6000);
const s = await p.evaluate(() => {
  const t = (document.body?.innerText || "").replace(/\s+/g, " ");
  const links = Array.from(document.querySelectorAll("a")).map((a) => `${(a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60)} -> ${(a.href || "").slice(0, 90)}`).filter((x) => /conversations\//.test(x)).slice(0, 15);
  return { threads: links, total: t.length };
});
console.log(JSON.stringify(s, null, 1).slice(0, 1500));
await browser.close();
