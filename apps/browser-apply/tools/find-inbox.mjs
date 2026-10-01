import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const p = await ctx.newPage();
await p.goto("https://www.workatastartup.com/jobs/106944", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(5000);
const links = await p.evaluate(() => Array.from(document.querySelectorAll("a")).map((a) => `${(a.innerText || "").trim().slice(0, 20)} -> ${(a.href || "").slice(0, 100)}`).filter((s) => /inbox|message|profile|application/i.test(s)).slice(0, 12));
console.log(links.join("\n"));
await browser.close();
