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
  if (!companyHref) return { error: "company-not-found", people: [] };
  const slug = companyHref.split("/company/")[1].split("/")[0];
  // 2. People tab
  await page.goto(`https://www.linkedin.com/company/${slug}/people/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const people = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      const href = a.getAttribute("href").split("?")[0];
      const text = (a.textContent || "").trim().replace(/\s+/g, " ");
      if (!href || !text || text.length < 3 || text.length > 80) continue;
      if (out.some((p) => p.url === href)) continue;
      // headline: nearest subtitle element
      let head = "";
      const card = a.closest("div");
      const sub = card?.parentElement?.querySelector("div[class*='subtitle'], div[class*='headline'], p");
      if (sub) head = (sub.textContent || "").trim().slice(0, 120);
      out.push({ name: text, url: href.startsWith("http") ? href : `https://www.linkedin.com${href}`, headline: head });
      if (out.length >= 12) break;
    }
    return out;
  });
  // 3. Prefer hiring-adjacent titles, else first two
  const scored = people.map((p) => ({
    ...p,
    hire: /recruit|talent|hiring|hr |human resources|founder|ceo|cto|people|hiring manager/i.test(`${p.name} ${p.headline}`) ? 0 : 1,
  })).sort((a, b) => a.hire - b.hire);
  return { slug, people: scored.slice(0, 2) };
}

async function sendDM(page, person, text) {
  await page.goto(person.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  const msgBtn = page.locator('button:has-text("Message"), a:has-text("Message")').first();
  if ((await msgBtn.count()) === 0) return { sent: false, reason: "no-message-button (not a connection / InMail only)" };
  await msgBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const box = page.locator('div[role="dialog"] div[contenteditable="true"], div[role="dialog"] textarea, div.msg-form__contenteditable').first();
  if ((await box.count()) === 0) return { sent: false, reason: "message-box-not-found" };
  await box.click({ timeout: 5000 }).catch(() => {});
  await box.fill(text.slice(0, 700), { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(800);
  if (DRY_RUN) return { sent: false, reason: "dry-run" };
  const send = page.locator('div[role="dialog"] button:has-text("Send"), button.msg-form__send-button').first();
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
      console.log(`  [dm] sent=${dm.sent} ${dm.reason || ""}`);
      lines.push(`• **${person.name}** (${person.headline || "member"})\n  <${person.url}>\n  Draft: ${draft.slice(0, 200)}${dm.sent ? "\n  ✅ **Message sent via LinkedIn**" : `\n  ⏳ Not sent (${dm.reason}) — draft above, please send by hand`}`);
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
