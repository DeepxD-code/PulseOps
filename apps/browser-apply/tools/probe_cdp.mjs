/**
 * Can the applier drive Obscura?
 *
 * Obscura is a headless browser with its own TLS stack and a stealth mode. The
 * sites the applier could not reach - Himalayas and Glassdoor India - answered
 * the Playwright-driven Edge with a Cloudflare managed challenge that never
 * cleared; a clean headless Chromium and a Rust stealth browser both stayed on
 * "Just a moment...", which is why those rows were parked.
 *
 * Obscura serves CDP, so this asks one question: does it get past the wall?
 */
import { chromium } from "playwright";

const CDP = process.env.PULSEOPS_CDP_URL || "http://127.0.0.1:9333";
const targets = process.argv.slice(2);
const urls = targets.length ? targets : [
  "https://himalayas.app/jobs",
  "https://www.glassdoor.co.in/Job/index.htm",
  "https://www.linkedin.com/jobs/view/4489114587/",
];

const browser = await chromium.connectOverCDP(CDP, { timeout: 30000 });
console.log(`[cdp] connected to ${CDP}`);
const context = browser.contexts()[0] || (await browser.newContext());

for (const url of urls) {
  const page = await context.newPage();
  const started = Date.now();
  let status = "?";
  let title = "";
  let text = "";
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = res ? String(res.status()) : "no-response";
  } catch (err) {
    status = `goto-failed: ${String(err).slice(0, 80)}`;
  }
  await page.waitForTimeout(4000);
  title = await page.title().catch(() => "");
  text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 260))
    .catch(() => "");
  const walled = /just a moment|enable javascript and cookies|attention required|verify you are human|checking your browser/i
    .test(`${title} ${text}`);
  console.log(`\n${url}`);
  console.log(`  status=${status}  ${Math.round((Date.now() - started) / 1000)}s  walled=${walled}`);
  console.log(`  title: ${title.slice(0, 90)}`);
  console.log(`  text:  ${text.slice(0, 200)}`);
  await page.close().catch(() => {});
}

await browser.close().catch(() => {});
