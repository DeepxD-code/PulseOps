// Read a connected repository's detail page: what the pipeline did, what state
// it is in, and what a first-time user is told to do next.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const state = path.join(ROOT, "portal", "autter-storageState.json");
const ORG = "deep-boathouse-40";
const target = process.argv[2] || `${ORG}/repositories/Sangam`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
await page.goto(`https://app.autter.dev/${target}`, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const t = (document.body?.innerText || "").replace(/[ \t]+/g, " ");
  const buttons = [...document.querySelectorAll("button, a[role=button]")]
    .map((b) => (b.innerText || "").trim()).filter(Boolean);
  return {
    title: document.title,
    text: t.replace(/\n{2,}/g, "\n").trim().slice(0, 2600),
    buttons: [...new Set(buttons)].slice(0, 30),
  };
});

console.log(`=== ${target} ===`);
console.log(`title: ${info.title}\n`);
console.log(info.text);
console.log("\n--- BUTTONS / ACTIONS ---");
console.log(info.buttons.join(" | "));
await page.screenshot({ path: path.join(ROOT, "output", "autter-sangam.png"), fullPage: false }).catch(() => {});
console.log("\nscreenshot -> output/autter-sangam.png");
await browser.close();
