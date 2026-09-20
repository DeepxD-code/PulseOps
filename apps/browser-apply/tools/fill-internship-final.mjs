// One-shot: open modal, fill text, set May 2026 -> Jul 2026, save. Facts only.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
const page = await ctx.newPage();
await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(5000);

async function clickStartsWith(text) {
  for (let i = 0; i < 5; i++) {
    const ok = await page.evaluate((t) => {
      const els = Array.from(document.querySelectorAll("a, button, div"));
      const c = els.filter((e) => (e.innerText || "").trim().startsWith(t) && e.offsetParent !== null);
      c.sort((a, b) => a.innerText.length - b.innerText.length);
      if (!c.length) return false;
      c[0].scrollIntoView({ block: "center" });
      c[0].click();
      return true;
    }, text).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function modalOpen() {
  return await page.evaluate(() => !!document.querySelector("div[role='dialog']")).catch(() => false);
}

console.log("pending:", await clickStartsWith("Add 4 missing details"));
for (let i = 0; i < 5 && !(await modalOpen()); i++) {
  await clickStartsWith("Add Internship");
  await page.waitForTimeout(2500);
}
console.log("modal:", await modalOpen());

// Text fields
await page.evaluate(() => {
  const set = (sub, v) => {
    const el = Array.from(document.querySelectorAll("input, textarea")).find((e) => (e.placeholder || "").toLowerCase().includes(sub) && e.offsetParent !== null && !(e.value || ""));
    if (!el) return;
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  set("name of the company", "AKS Intelligent Systems LLP");
  set("name of the project", "Backend Development & Deployment");
  set("responsibilities", "Software Trainee Intern (May-Jul 2026). Built and deployed backend services, API integrations, deployment pipelines and applied AI/LLM workflows in a production engineering team.");
}).catch(() => {});
await page.waitForTimeout(1000);

// Durations: the 4 dropdown triggers in order
const picks = ["May", "2026", "Jul", "2026"];
for (let k = 0; k < 4; k++) {
  const opened = await page.evaluate(() => {
    const dlg = document.querySelector("div[role='dialog']") || document;
    const boxes = Array.from(dlg.querySelectorAll("div, span, button")).filter((d) => {
      const t = (d.innerText || "").trim();
      return (t === "Month" || t === "Year") && d.offsetParent !== null;
    });
    // shallowest = the trigger itself, not parents
    boxes.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
    if (!boxes.length) return "none";
    boxes[0].scrollIntoView({ block: "center" });
    boxes[0].click();
    return "opened";
  }).catch((e) => `err ${e.message.slice(0, 50)}`);
  await page.waitForTimeout(1500);
  const picked = await page.evaluate((opt) => {
    const items = Array.from(document.querySelectorAll("li, div[role='option'], span")).filter((e) => {
      const t = (e.innerText || "").trim();
      return t.toLowerCase() === opt.toLowerCase() && e.offsetParent !== null && e.children.length === 0;
    });
    if (!items.length) return "option-missing";
    items[0].click();
    return "picked:" + opt;
  }, picks[k]).catch((e) => `err ${e.message.slice(0, 50)}`);
  console.log(`dur ${k} (${picks[k]}): opened=${opened} picked=${picked}`);
  await page.waitForTimeout(800);
}

await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/intern-prefinal.png" });
// Save
for (let i = 0; i < 3; i++) {
  const done = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("div[role='dialog'] button, button")).find((b) => (b.innerText || "").trim() === "Save" && !b.disabled && b.offsetParent !== null);
    if (!btn) return false;
    btn.click();
    return true;
  }).catch(() => false);
  if (done) {
    console.log("save clicked");
    break;
  }
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(6000);
await page.screenshot({ path: "E:/Potential-gold/PluseOPS/output/intern-saved2.png" });
const pct = await page.evaluate(() => {
  const m = (document.body?.innerText || "").match(/(\d+)%/);
  return m ? m[0] : "?";
});
console.log("profile:", pct);
await browser.close();
