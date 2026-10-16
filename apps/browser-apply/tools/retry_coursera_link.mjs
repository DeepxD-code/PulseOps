import { chromium } from "playwright";
import path from "node:path";

const link = process.argv[2];
if (!link) { console.error("usage: node retry_coursera_link.mjs <url>"); process.exit(1); }
const PROFILE = path.join(path.resolve("."), ".edge-profile");
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const q = ctx.pages()[0] || (await ctx.newPage());
await q.goto(link, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
await q.waitForTimeout(12000);
const d = await q.evaluate(() => {
  const x = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return { url: location.href,
    loggedIn: /my learning|accomplishments|log out|account settings/i.test(x),
    head: x.slice(0, 300) };
}).catch(() => null);
console.log(JSON.stringify(d, null, 1).slice(0, 900));
if (d && /coursera\.org\/(?!login|$)/.test(d.url)) {
  await q.goto("https://www.coursera.org/my-learning",
    { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await q.waitForTimeout(8000);
  const e = await q.evaluate(() => ({
    url: location.href,
    head: ((document.body?.innerText || "").replace(/\s+/g, " ").trim()).slice(0, 600),
  })).catch(() => null);
  console.log(JSON.stringify(e, null, 1).slice(0, 1000));
}
await ctx.close();
