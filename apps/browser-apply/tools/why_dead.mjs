// Which dead-listing alternative fires on a posting that is still live?
//
// #1430 Antilabs was recorded "job page is 404/expired" one navigation after
// load, yet the same URL renders a live posting ("Backend Developer Intern",
// "1 day ago", the day it was scraped). The guard tests a big alternation
// against the first 2000 characters of the page, so the answer is one sentence
// somewhere near the top. This prints the fragment and its neighbourhood.
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("usage: why_dead.mjs <url>");
  process.exit(1);
}

const PATTERN = /404|page not found|unable to load the page|may not be valid|posting has been removed|job (?:posting )?(?:has been|was) removed|no longer exists|no longer available|no longer accepting applications|no longer open|job (?:you are trying to view )?(?:has |is |was )?expired|position (has been )?filled|this job is (?:no longer|closed)|job is closed|posting (?:has )?ended/gi;

const browser = await chromium.connectOverCDP(process.env.PULSEOPS_CDP_URL || "http://127.0.0.1:9333", { timeout: 30000 });
const context = browser.contexts()[0] || (await browser.newContext());
const page = await context.newPage();
const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
await page.waitForTimeout(5000);
const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 2000)).catch(() => "");
console.log(`status=${res ? res.status() : "?"}  title=${await page.title().catch(() => "")}`);
const hits = [...text.matchAll(PATTERN)];
if (!hits.length) console.log("no dead-listing alternative matched");
for (const hit of hits.slice(0, 6)) {
  const from = Math.max(0, (hit.index || 0) - 90);
  const to = Math.min(text.length, (hit.index || 0) + hit[0].length + 90);
  console.log(`\nmatch "${hit[0]}" at ${hit.index}`);
  console.log(`  ...${text.slice(from, to).replace(/\s+/g, " ")}...`);
}
await page.close().catch(() => {});
process.exit(0);
