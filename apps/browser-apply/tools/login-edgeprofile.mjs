// One-time login into the automation's own Edge profile. Stays valid for weeks.
import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext("E:/Potential-gold/PluseOPS/.edge-profile", {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const p1 = await ctx.newPage();
await p1.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
const p2 = await ctx.newPage();
await p2.goto("https://www.naukri.com/nlogin/login", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
console.log("Log into LinkedIn (email) + Naukri in the opened windows, then press ENTER here.");
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once("data", () => resolve());
});
await ctx.close();
console.log("saved");
