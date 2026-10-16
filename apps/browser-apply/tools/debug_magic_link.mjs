import { chromium } from "playwright";
import path from "node:path";

const link = process.argv[2];
if (!link) { console.error("usage: node debug_magic_link.mjs <url>"); process.exit(1); }
const PROFILE = path.join(path.resolve("."), ".edge-profile");
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const q = ctx.pages()[0] || (await ctx.newPage());
const chain = [];
q.on("response", (r) => {
  if (r.status() >= 300 && r.status() < 400) chain.push(`${r.status()} ${r.url().slice(0, 100)}`);
});
q.on("requestfailed", (r) => chain.push(`FAIL ${r.url().slice(0, 100)} :: ${(r.failure() || {}).errorText}`));
await q.goto(link, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => console.log("  goto err:", String(e).slice(0, 120)));
await q.waitForTimeout(10000);
console.log("  final url:", q.url().slice(0, 120));
console.log("  redirects/issues:");
for (const c of chain.slice(0, 15)) console.log("   ", c);
const cookies = await ctx.cookies("https://www.coursera.org").catch(() => []);
console.log(`  coursera.org cookies: ${cookies.length} :: ${cookies.map((c) => c.name).slice(0, 20).join(",")}`);
await ctx.close();
