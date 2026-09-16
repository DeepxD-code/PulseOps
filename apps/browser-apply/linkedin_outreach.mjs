#!/usr/bin/env node
/**
 * apps/browser-apply/linkedin_outreach.mjs — LinkedIn recruiter finder + auto-DM
 *
 * For companies where G10 found no verified email:
 *   1. Search LinkedIn for the company → open /people/
 *   2. Pick top 1-2 members (prefer HR/recruiter/talent/founder titles)
 *   3. Draft a personalized DM from config/profile.yml
 *   4. With --live: open their profile, click Message, send it
 *   5. Always: post a Discord message tagging the user with person + draft/status
 *
 * Usage:
 *   node apps/browser-apply/linkedin_outreach.mjs --dry-run --company "Acme"
 *   node apps/browser-apply/linkedin_outreach.mjs --dry-run --all            # all queued jobs
 *   node apps/browser-apply/linkedin_outreach.mjs --live --headed --all      # actually send DMs
 *
 * Requires: portal/storageState.json with a logged-in LinkedIn session
 *   (run: node apps/browser-apply/save_sessions.mjs, log in with EMAIL, not Google)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const DRY_RUN = !process.argv.includes("--live");
const HEADED = process.argv.includes("--headed") || DRY_RUN;
const ALL = process.argv.includes("--all");
const COMPANY_FLAG = (() => {
  const i = process.argv.findIndex((a) => a === "--company");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const SESSION = path.join(ROOT, "portal", "storageState.json");
const MENTION = process.env.DISCORD_USER_ID ? `<@${process.env.DISCORD_USER_ID}>` : "@here";

function loadProfile() {
  for (const p of [path.join(ROOT, "config", "profile.yml"), path.join(ROOT, "config", "profile.yml.example")]) {
    if (fs.existsSync(p)) {
      try {
        const d = yaml.load(fs.readFileSync(p, "utf-8"));
        if (d?.candidate) return d;
      } catch {}
    }
  }
  return { candidate: { name: "Avradeep Majumder" }, domain: { title: "Backend Engineer" } };
}

function draftDM(profile, person, job) {
  const me = profile.candidate?.name?.split(" ")[0] || "Hi";
  const first = (person.name || "there").split(" ")[0];
  return (
    `Hi ${first}, I'm ${profile.candidate?.name || me} — a final-year B.Tech CSE (AI/ML) student ` +
    `building production AI/backend systems (fraud-intelligence platform, blockchain logistics, GNN threat detection). ` +
    `I saw ${job.company} is hiring for ${job.title} and would love to be considered. ` +
    `Happy to share my resume. Thanks!`
  );
}

async function findPeople(page, company) {
  // 1. Company search
  await page.goto(`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(company)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const companyHref = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/company/"]');
    return a ? a.getAttribute("href") : null;
  });
  if (!companyHref) {
    console.log(`  [debug] search URL now: ${page.url().slice(0, 100)}`);
    return { error: "company-not-found", people: [] };
  }
  console.log(`  [debug] company page: ${companyHref}`);
  const slug = companyHref.split("/company/")[1].split("/")[0];
  // 2. People tab — scroll to load the employee list, ignore "follows" cards
  await page.goto(`https://www.linkedin.com/company/${slug}/people/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1200);
  }
  const people = await page.evaluate(() => {
    const out = [];
    const scope = document.querySelector("main") || document;
    for (const a of scope.querySelectorAll('a[href*="/in/"]')) {
      const href = a.getAttribute("href").split("?")[0];
      const text = (a.textContent || "").trim().replace(/\s+/g, " ");
      if (!href || !text || text.length < 3 || text.length > 80) continue;
      if (/follow/i.test(text)) continue;
      if (out.some((p) => p.url === href)) continue;
      let head = "";
      const card = a.closest("li, div");
      const sub = card?.parentElement?.querySelector("div[class*='subtitle'], div[class*='headline'], p.t-14");
      if (sub && sub !== a) head = (sub.textContent || "").trim().slice(0, 120);
      out.push({ name: text, url: href.startsWith("http") ? href : `https://www.linkedin.com${href}`, headline: head });
      if (out.length >= 12) break;
    }
    return out;
  });
  console.log(`  [debug] raw people cards: ${people.length}`);
  // 3. Prefer hiring-adjacent titles, else first two
  const scored = people.map((p) => ({
    ...p,
    hire: /recruit|talent|hiring|hr |human resources|founder|ceo|cto|people|hiring manager/i.test(`${p.name} ${p.headline}`) ? 0 : 1,
  })).sort((a, b) => a.hire - b.hire);
  return { slug, people: scored.slice(0, 2) };
}

async function sendDM(page, person, text) {
  await page.goto(person.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  const firstName = (person.name || "").split(" ")[0];
  // Click a header-scoped button by exact label. The header is the SECTION
  // containing the "Contact info" link (right-rail cards never have it).
  // Returns true if clicked, false if not found. Never touches right rail.
  async function clickHeaderButton(label) {
    return await page.evaluate((labelText) => {
      const ci = Array.from(document.querySelectorAll("a")).find(
        (a) => (a.textContent || "").trim() === "Contact info"
      );
      if (!ci) return false;
      let sec = ci;
      for (let i = 0; i < 10 && sec; i++) {
        sec = sec.parentElement;
        if (sec && sec.tagName === "SECTION") break;
      }
      if (!sec || sec.tagName !== "SECTION") return false;
      const btn = Array.from(sec.querySelectorAll("a, button")).find(
        (el) => (el.innerText || "").trim() === labelText
      );
      if (!btn) return false;
      btn.scrollIntoView({ block: "center" });
      btn.click();
      return true;
    }, label);
  }
  const msgClicked = await clickHeaderButton("Message");
  if (!msgClicked) return { sent: false, reason: "no-message-button (not a connection / InMail only)" };
  await page.waitForTimeout(2000);
  console.log(`  [debug] after Message click: ${page.url().slice(0, 110)}`);
  // Wait for the messaging overlay (right-side pane), not a modal dialog
  const boxSel = [
    "aside div.msg-form__contenteditable[contenteditable='true']",
    "div.msg-overlay div[contenteditable='true']",
    "div[role='dialog'] div[contenteditable='true']",
    "div[role='dialog'] textarea",
    "div.msg-form__contenteditable",
  ].join(", ");
  let box = null;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    const cand = page.locator(boxSel).first();
    if ((await cand.count()) > 0) {
      box = cand;
      break;
    }
  }
  // Dismiss Premium upsell if Message click opened that instead of a composer
  const premium = page.locator("div[role='dialog']:has-text('Start 1 month free trial'), div[role='dialog']:has-text('Invest in your career')").first();
  if ((await premium.count()) > 0) {
    console.log("  [dm] Premium paywall — direct Message needs Premium; closing modal");
    await page.locator("div[role='dialog'] button[aria-label='Dismiss']").first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  if (!box) {
    // 3rd-degree profiles: Message won't open — fall back to Connect with a note (300 chars)
    console.log("  [dm] no message overlay — trying Connect with note");
    let connected = await clickHeaderButton("Connect");
    if (!connected) {
      // Connect often hides under the "..." overflow menu (header "More actions")
      const moreClicked = await clickHeaderButton("More");
      if (moreClicked) {
        await page.waitForTimeout(1200);
        const inMenu = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll("div[role='dialog'] button, div.artdeco-dropdown button, div[role='menu'] div[role='menuitem']"));
          const c = items.find((el) => (el.innerText || "").trim() === "Connect");
          if (!c) return false;
          c.click();
          return true;
        });
        connected = inMenu;
      }
    }
    if (!connected) {
      // Creator mode: no Connect at all — Follow is free and keeps us on their radar
      if (await clickHeaderButton("Follow")) {
        await page.waitForTimeout(1000);
        return { sent: false, reason: "premium-required-no-connect (followed instead)", followed: true };
      }
      return { sent: false, reason: "premium-required-no-connect" };
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(ROOT, "output", `connect-modal-${Date.now()}.png`), fullPage: false }).catch(() => {});
    const addNote = page.locator('button[aria-label="Add a note"], button:has-text("Add a note")').first();
    if ((await addNote.count()) === 0) {
      // No note option — plain connect invite
      const sendInv = page.locator('button[aria-label="Send without a note"], button:has-text("Send without a note"), button[aria-label="Send now"], button:has-text("Send now"), button[aria-label="Send invitation"]').first();
      if ((await sendInv.count()) > 0 && !DRY_RUN) {
        // Safety: modal must name THIS person, never a right-rail stranger
        const modalText = await page.locator("div[role='dialog']").first().innerText().catch(() => "");
        if (!modalText.toLowerCase().includes(firstName.toLowerCase())) {
          console.log(`  [dm] modal is not for ${firstName} — aborting click`);
          return { sent: false, reason: "modal-person-mismatch" };
        }
        await sendInv.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return { sent: true, via: "connect-invite-no-note" };
      }
      return { sent: false, reason: "connect-no-note-option" };
    }
    await addNote.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const noteBox = page.locator('textarea[name="message"], div[role="dialog"] textarea').first();
    if ((await noteBox.count()) === 0) return { sent: false, reason: "note-box-not-found" };
    await noteBox.fill(text.slice(0, 290), { timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(500);
    if (DRY_RUN) return { sent: false, reason: "dry-run" };
    const sendBtn = page.locator('button[aria-label="Send invitation"], button:has-text("Send invitation")').first();
    if ((await sendBtn.count()) === 0) return { sent: false, reason: "invite-send-not-found" };
    const modalText2 = await page.locator("div[role='dialog']").first().innerText().catch(() => "");
    if (!modalText2.toLowerCase().includes(firstName.toLowerCase())) {
      console.log(`  [dm] modal is not for ${firstName} — aborting click`);
      return { sent: false, reason: "modal-person-mismatch" };
    }
    await sendBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    return { sent: true, via: "connect-with-note" };
  }
  await box.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.type(text.slice(0, 700), { delay: 10 }).catch(() => null);
  await page.waitForTimeout(800);
  if (DRY_RUN) return { sent: false, reason: "dry-run" };
  const send = page.locator(
    "aside button.msg-form__send-button:not([disabled]), div[role='dialog'] button:has-text('Send'), button.msg-form__send-button"
  ).first();
  if ((await send.count()) === 0) return { sent: false, reason: "send-button-not-found" };
  const disabled = await send.isDisabled().catch(() => false);
  if (disabled) return { sent: false, reason: "send-disabled" };
  await send.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  return { sent: true };
}

async function notifyDiscord(lines) {
  const webhook = process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) {
    console.log("[Discord] no webhook — printing instead");
    return;
  }
  const content = `${MENTION}\n` + lines.join("\n").slice(0, 1900);
  try {
    await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    console.log("[Discord] tagged notification sent");
  } catch (e) {
    console.log(`[Discord] failed: ${e.message?.slice(0, 80)}`);
  }
}

async function loadJobs() {
  if (COMPANY_FLAG) return [{ company: COMPANY_FLAG, title: "Backend role", link: "" }];
  // Batch: recent high-score unsent jobs from pulseops.db
  try {
    const { execSync } = await import("node:child_process");
    const dbCandidates = [path.join(ROOT, "pulseops.db")];
    let dbPath = null;
    for (const p of dbCandidates) if (fs.existsSync(p)) { dbPath = p; break; }
    if (dbPath) {
      const helper = path.join(ROOT, "apps", "browser-apply", "queueCompanies.py");
      fs.writeFileSync(helper, `import sqlite3,json\nconn=sqlite3.connect(r'${dbPath.replace(/\\/g, "/")}')\nrows=conn.execute('SELECT company,title,link FROM jobs WHERE score>=65 AND status!="Sent" ORDER BY score DESC LIMIT 5').fetchall()\nprint(json.dumps([{"company":r[0],"title":r[1],"link":r[2]} for r in rows]))\n`, "utf-8");
      const out = execSync(`python "${helper}"`, { encoding: "utf-8", timeout: 15000 });
      const parsed = JSON.parse(out.trim().split("\n").pop());
      if (parsed?.length) {
        console.log(`[DB] ${parsed.length} companies to research`);
        return parsed;
      }
    }
  } catch (e) {
    console.log(`[DB] load failed: ${e.message?.slice(0, 80)}`);
  }
  return [];
}

async function main() {
  const profile = loadProfile();
  if (!fs.existsSync(SESSION)) {
    console.error(`[ERR] No session at portal/storageState.json — run: node apps/browser-apply/save_sessions.mjs`);
    process.exit(1);
  }
  const jobs = await loadJobs();
  if (!jobs.length) {
    console.log("[Jobs] none — pass --company NAME or ensure pulseops.db has score>=65 jobs");
    return;
  }
  console.log(`[Jobs] ${jobs.length} (dry-run=${DRY_RUN})`);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: SESSION });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Session check
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  if (page.url().includes("login") || page.url().includes("authwall")) {
    console.error("[ERR] LinkedIn session expired — re-run save_sessions.mjs and log in again");
    await browser.close();
    process.exit(2);
  }
  console.log("[OK] LinkedIn session live");

  const results = [];
  for (const job of jobs) {
    console.log(`\n[Company] ${job.company}`);
    let found;
    try {
      found = await findPeople(page, job.company);
    } catch (e) {
      console.log(`  [error] ${e.message.slice(0, 120)}`);
      results.push({ job, error: e.message.slice(0, 120) });
      continue;
    }
    if (found.error || !found.people.length) {
      console.log(`  [warn] ${found.error || "no people found"}`);
      results.push({ job, error: found.error || "no-people" });
      continue;
    }
    const lines = [`🔎 **LinkedIn outreach — ${job.company} (${job.title})**`];
    for (const person of found.people) {
      const draft = draftDM(profile, person, job);
      console.log(`  [person] ${person.name} — ${person.headline || "?"} — ${person.url}`);
      let dm = { sent: false, reason: "dry-run" };
      if (!DRY_RUN) {
        try {
          dm = await sendDM(page, person, draft);
        } catch (e) {
          dm = { sent: false, reason: e.message.slice(0, 80) };
        }
      }
      console.log(`  [dm] sent=${dm.sent} ${dm.via || dm.reason || ""}`);
      lines.push(`• **${person.name}** (${person.headline || "member"})\n  <${person.url}>\n  Draft: ${draft.slice(0, 200)}${dm.sent ? `\n  ✅ **Sent via LinkedIn (${dm.via || "dm"})**` : `\n  ⏳ Not sent (${dm.reason}) — draft above, please send by hand`}`);
      results.push({ job, person, dm: dm.sent, reason: dm.reason });
    }
    await notifyDiscord(lines);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await browser.close();
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "output", "linkedin-outreach.json"), JSON.stringify({ ran_at: new Date().toISOString(), dry_run: DRY_RUN, results }, null, 2));
  console.log(`\n[+] Done → output/linkedin-outreach.json`);
}

main().catch((e) => {
  console.error("[Fatal]", e);
  process.exit(1);
});
