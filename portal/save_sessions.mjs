#!/usr/bin/env node
/**
 * portal/save_sessions.mjs — One-click login saver for apply.mjs
 * Opens all job portals at once, you log in once, it auto-saves session.
 * No passwords stored, just cookies — like Strawberry's session.
 * Usage: node portal/save_sessions.mjs
 * After: portal/storageState.json appears → used by portal/apply.mjs --live
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORAGE = path.join(__dirname, "storageState.json");

const SITES = [
  "https://www.naukri.com",
  "https://in.indeed.com/jobs?q=backend+developer+intern&l=India",
  "https://www.glassdoor.co.in/Job/india-backend-developer-intern-jobs-SRCH_KO0,27.htm",
  "https://www.jobhai.com",
  "https://wellfound.com/india/role/r/backend-engineer",
];

console.log("Launching browser — 5 tabs will open (Naukri, Indeed, Glassdoor, JobHai, Wellfound)");
console.log("Log in to each site you want auto-apply on, solve CAPTCHA, then return here and press ENTER");
const browser = await chromium.launch({ headless: false, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });

for (const url of SITES) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(()=>{});
  console.log(`  opened ${url}`);
}

console.log("\n>>> Log in now in the opened windows (keep them open)");
console.log(">>> When done, press ENTER here to save session to portal/storageState.json");
await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', ()=>resolve()); });

await context.storageState({ path: STORAGE });
console.log(`\nSaved ${STORAGE} (${fs.statSync(STORAGE).size} bytes)`);
console.log("To use on GitHub Actions: [Convert]::ToBase64String([IO.File]::ReadAllBytes('portal/storageState.json')) | gh secret set NAUKRI_STORAGE --repo DeepxD-code/PluseOPS");
await browser.close();
