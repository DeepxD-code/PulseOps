// Log in to Naukri with a phone OTP and save the session for the scan.
//
// Naukri has no password login: it sends a one-time code to the phone number
// and the code has to be typed by a person. This script requests the code, then
// holds the window open while the operator types it. It cannot read the phone.
//
// Usage: node portal/save_naukri_session.mjs [phone] [waitSeconds]
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phone = process.argv[2] || "6289050278";
const waitSeconds = Number.parseInt(process.argv[3] || "300", 10);
const outFile = path.join(ROOT, "portal", "naukri-storageState.json");
const profileDir = path.join(ROOT, ".edge-profile-naukri");

console.log(`Naukri OTP login for ${phone}`);
console.log("The code arrives by SMS to that number. I cannot read your phone —");
console.log("type the code into the browser window when it appears.\n");

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "msedge", headless: false, viewport: { width: 1366, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(25000);

await page.goto("https://www.naukri.com/nlogin/login", { waitUntil: "domcontentloaded" })
  .catch((e) => console.log("goto:", String(e).slice(0, 100)));
await page.waitForTimeout(5000);

// The phone field and the OTP trigger. Naukri uses several ids over time, so
// match on any of them and report what is actually on screen if none appear.
const filled = await page.evaluate((digits) => {
  const inputs = [...document.querySelectorAll("input")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const phone = inputs.find((el) =>
    /mobile|phone|username|loginId/i.test(`${el.id} ${el.name} ${el.getAttribute("placeholder") || ""}`));
  if (!phone) return { ok: false, seen: inputs.map((el) => `${el.id || el.name || "?"}:${el.type}`) };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(phone, digits);
  phone.dispatchEvent(new Event("input", { bubbles: true }));
  phone.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}, phone);

if (!filled.ok) {
  console.log("Could not find the phone field. Inputs seen:", filled.seen.join(", "));
  await page.screenshot({ path: path.join(ROOT, "output", "naukri-login.png"), fullPage: true }).catch(() => {});
  await context.close();
  process.exit(1);
}
console.log("phone number entered");
await page.waitForTimeout(800);

const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button, a, input[type=submit], div")]
    .find((el) => /send otp|get otp|continue|login/i.test(`${el.innerText || ""} ${el.value || ""}`));
  if (!btn) return false;
  btn.click();
  return true;
});
console.log(clicked ? "requested the OTP" : "no OTP button found — press Continue in the window");
await page.screenshot({ path: path.join(ROOT, "output", "naukri-otp-requested.png"), fullPage: true }).catch(() => {});

const deadline = Date.now() + waitSeconds * 1000;
let saved = false;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");
    const loggedIn = /logout|my profile|my jobs|candidate dashboard|recommended jobs/i.test(t)
      || Boolean(document.querySelector("a[href*='logout'], [class*='logout']"));
    return { loggedIn, url: location.href, snippet: t.slice(0, 160) };
  }).catch(() => ({ loggedIn: false, url: "", snippet: "" }));
  if (state.loggedIn) {
    await context.storageState({ path: outFile });
    console.log(`\nlogged in — session saved to ${outFile}`);
    saved = true;
    break;
  }
  await page.waitForTimeout(2000);
}

if (!saved) {
  console.log("\nNo sign of a logged-in session before the timeout. Nothing was saved.");
  console.log("If you are in, re-run this script — it picks the session up from the profile.");
  await page.screenshot({ path: path.join(ROOT, "output", "naukri-login-timeout.png"), fullPage: true }).catch(() => {});
}
if (!fs.existsSync(outFile)) {
  await context.close();
  process.exit(saved ? 0 : 1);
}
await context.close();
process.exit(saved ? 0 : 1);
