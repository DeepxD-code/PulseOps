import { chromium } from "playwright";

const otp = process.argv[2] || "";
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const page = await ctx.newPage();
await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(5000);
if (!otp) {
  const clicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("a, button, span"));
    // Prefer the Verify next to the phone number
    const phone = els.find((e) => /6289050278/.test(e.textContent || ""));
    let scope = document;
    if (phone) {
      let n = phone;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (n && /verify/i.test(n.innerText || "")) {
          scope = n;
          break;
        }
      }
    }
    const v = Array.from(scope.querySelectorAll("a, button, span")).find(
      (e) => (e.textContent || "").trim() === "Verify" && e.offsetParent !== null
    );
    if (!v) return "not-found";
    v.click();
    return "clicked";
  });
  console.log("verify-click:", clicked);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/verify-otp.png" });
  console.log(clicked === "clicked" ? "OTP sent — paste it here, then I run: node verify-mobile.mjs <OTP>" : "no verify link");
} else {
  const filled = await page.evaluate((code) => {
    const box = Array.from(document.querySelectorAll("input")).find((i) =>
      /otp|verify|code/i.test(`${i.placeholder || ""} ${i.name || ""}`)
    );
    if (!box) return "no-box";
    box.focus();
    document.execCommand("insertText", false, code);
    return "filled";
  }, otp);
  console.log("otp-fill:", filled);
  await page.waitForTimeout(1500);
  const submitted = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, a")).find((e) =>
      /^(verify|submit|confirm)$/i.test((e.textContent || "").trim())
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  console.log("submitted:", submitted);
  await page.waitForTimeout(5000);
  const ok = await page.evaluate(() => /verified|verification successful|verified successfully/i.test(document.body?.innerText || ""));
  console.log("verified:", ok);
  await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/verify-done.png" });
}
await browser.close();
