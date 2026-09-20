import { chromium } from "playwright";

const PDF = "C:/Users/asus/Downloads/my_cv_v23.pdf";
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const page = await ctx.newPage();
await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/profile-before.png" });
// Open resume section
const upd = page.locator("button:has-text('Update resume'), a:has-text('Update resume'), button:has-text('Upload')").first();
console.log("update-btn:", await upd.count());
if ((await upd.count()) > 0) {
  await upd.click({ timeout: 8000 }).catch((e) => console.log("click:", e.message.slice(0, 80)));
  await page.waitForTimeout(2500);
}
const file = page.locator("input[type='file']").first();
console.log("file-input:", await file.count());
if ((await file.count()) > 0) {
  await file.setInputFiles(PDF, { timeout: 15000 });
  console.log("uploaded, waiting...");
  await page.waitForTimeout(8000);
}
await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/profile-after.png" });
const ok = await page.evaluate(() => /my_cv_v23|resume.*uploaded|updated successfully|100%/i.test(document.body?.innerText || ""));
console.log("resume-present:", ok);
await browser.close();
