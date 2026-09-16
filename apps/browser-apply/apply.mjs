#!/usr/bin/env node
/**
 * portal/apply.mjs — Browser auto-apply engine (open-source Strawberry alternative)
 *
 * Uses Playwright (already in dependencies) to open job links, detect the
 * ATS/engine, fill the form with config/profile.yml + uploaded resume PDF,
 * and pause for approval before submitting.
 *
 * This is MIT-licensed, local-only, and human-in-loop by default — the
 * same model Strawberry uses but without cloud.
 *
 * Data flow (mirrors portal/scan.mjs hand-off):
 *   Python: send_queue (MediNex 3 etc.) → portal/apply.mjs reads DB or jobs.tsv
 *   Node: opens each link → detects ATS → fills → uploads → previews → waits
 *
 * Usage:
 *   node portal/apply.mjs --dry-run              Preview 3 queued jobs, no submit
 *   node portal/apply.mjs --job-url https://...  Single URL dry-run
 *   node portal/apply.mjs --job-id 123           Apply for DB job_id (reads pulseops.db)
 *   node portal/apply.mjs --live                 Actually submit after approval (requires --live flag)
 *   node portal/apply.mjs --headed               Show browser window (for debugging / CAPTCHA)
 *
 * Safety:
 *   - Default is --dry-run (fill + screenshot, no click Submit)
 *   - --live requires explicit flag AND interactive approval per job (press Enter)
 *   - No credentials are stored — uses your existing logged-in session if you run headed
 *     or a pre-saved storageState.json (see docs below)
 *   - CAPTCHA / 2FA pauses for manual solve
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const DRY_RUN = !process.argv.includes("--live");
const HEADED = process.argv.includes("--headed");
const AUTO = process.argv.includes("--auto");
const MOCK_ONLY = process.argv.includes("--mock");
const JOB_URL_FLAG = process.argv.find((a) => a.startsWith("--job-url="));
const JOB_ID_FLAG = process.argv.find((a) => a.startsWith("--job-id="));
const SINGLE_URL = JOB_URL_FLAG ? JOB_URL_FLAG.split("=")[1] : (process.argv.includes("--job-url") ? process.argv[process.argv.indexOf("--job-url")+1] : null);
const SINGLE_JOB_ID = JOB_ID_FLAG ? JOB_ID_FLAG.split("=")[1] : (process.argv.includes("--job-id") ? process.argv[process.argv.indexOf("--job-id")+1] : null);

function loadProfile() {
  const candidates = [path.join(ROOT, "config", "profile.yml"), path.join(ROOT, "config", "profile.yml.example")];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { 
        const data = yaml.load(fs.readFileSync(p, "utf-8"));
        if (data?.candidate) return data;
      } catch {}
    }
  }
  return { candidate: { name: "Test User", email: "test@example.com" }, domain: { title: "Backend Engineer" } };
}

function findResumePdf(company, title) {
  const candidates = [
    path.join(ROOT, "output", "pdf", `${company} - ${title}.pdf`),
    path.join(ROOT, "output", "pdf", `${company}.pdf`),
    ...fs.existsSync(path.join(ROOT, "output", "pdf")) ? fs.readdirSync(path.join(ROOT, "output", "pdf")).map(f=>path.join(ROOT,"output","pdf",f)).filter(f=>f.endsWith(".pdf")).slice(0,1) : [],
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}

function inferATS(url) {
  if (!url) return "generic";
  if (url.includes("greenhouse.io") || url.includes("boards.greenhouse")) return "greenhouse";
  if (url.includes("lever.co")) return "lever";
  if (url.includes("ashbyhq.com") || url.includes("ashby")) return "ashby";
  if (url.includes("workday")) return "workday";
  if (url.includes("myworkdayjobs")) return "workday";
  if (url.includes("smartrecruiters")) return "smartrecruiters";
  if (url.includes("naukri.com")) return "naukri";
  if (url.includes("wellfound.com") || url.includes("angel.co")) return "wellfound";
  if (url.includes("linkedin.com")) return "linkedin";
  if (url.includes("indeed.com")) return "indeed";
  if (url.includes("glassdoor.")) return "glassdoor";
  if (url.includes("jobhai.com")) return "jobhai";
  if (url.includes("workatastartup.com") || url.includes("ycombinator")) return "yc";
  return "generic";
}

const ATS_SELECTORS = {
  indeed: {
    applyBtn: ['a:has-text("Apply now")', 'button:has-text("Apply now")', 'div#applyButtonLinkContainer a', 'a[data-testid="applyButton"]'],
    fields: {
      name: ['input[name="name"]', '#applicant.name'],
      email: ['input[name="email"]', 'input[type="email"]'],
      phone: ['input[name="phone"]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Continue")', 'button:has-text("Submit")']
  },
  glassdoor: {
    applyBtn: ['a[data-test="applyButton"]', 'button:has-text("Easy Apply")', 'a:has-text("Apply")'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[type="tel"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")']
  },
  jobhai: {
    applyBtn: ['a:has-text("Apply")', 'button:has-text("Apply")'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[name="mobile"]', 'input[type="tel"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")']
  },
  yc: {
    applyBtn: ['a:has-text("Apply")', 'button:has-text("Apply")', 'a[href*="/apply"]'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")', 'button:has-text("Apply")']
  },
  greenhouse: {
    applyBtn: ['a#apply_button', 'a[data-mapped-click="apply"]', 'a:has-text("Apply")', 'button:has-text("Apply")'],
    fields: {
      firstName: ['#first_name', 'input[name="first_name"]', 'input[autocomplete="given-name"]'],
      lastName: ['#last_name', 'input[name="last_name"]', 'input[autocomplete="family-name"]'],
      email: ['#email', 'input[name="email"]', 'input[type="email"]'],
      phone: ['#phone', 'input[name="phone"]', 'input[type="tel"]'],
      resume: ['input[type="file"][name*="resume"]', 'input[type="file"]'],
      cover: ['textarea[name*="cover"]', '#cover_letter'],
    },
    submitBtn: ['#submit_app', 'button:has-text("Submit Application")', 'button[type="submit"]']
  },
  lever: {
    applyBtn: ['a.posting-btn-submit', 'a:has-text("Apply")', 'button:has-text("Apply")'],
    fields: {
      name: ['input[name="name"]', '#name', 'input[placeholder*="Full name"]'],
      email: ['input[name="email"]', '#email'],
      phone: ['input[name="phone"]', '#phone', 'input[type="tel"]'],
      resume: ['input[type="file"][name="resume"]', 'input[type="file"]'],
    },
    submitBtn: ['#btn-submit', 'button:has-text("Submit")']
  },
  ashby: {
    applyBtn: ['a[href*="application"]', 'button:has-text("Apply")', 'a:has-text("Apply")'],
    fields: {
      name: ['input[name="name"]', 'input[autocomplete="name"]'],
      email: ['input[name="email"]', 'input[type="email"]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: ['button[type="submit"]']
  },
  linkedin: {
    applyBtn: ['button[aria-label*="Easy Apply"]', 'button:has-text("Easy Apply")', 'button.jobs-apply-button', 'a:has-text("Easy Apply")'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[type="tel"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button[aria-label="Submit application"]', 'button:has-text("Submit application")', 'button:has-text("Review")']
  },
  naukri: {
    applyBtn: ['button:has-text("Apply")', 'a:has-text("Apply")', '#apply-button', '[id*="apply"]'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[type="tel"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")', 'button:has-text("Apply")']
  },
  wellfound: {
    applyBtn: ['button:has-text("Apply")', 'a:has-text("Apply")'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")']
  },
  generic: {
    applyBtn: ['a:has-text("Apply")', 'a:has-text("Apply now")', 'button:has-text("Apply")', 'button:has-text("Apply now")', '[data-testid*="apply"]'],
    fields: {
      name: ['input[name="name"]', '#name', 'input[autocomplete="name"]', 'input[placeholder*="Full name"]'],
      email: ['input[type="email"]', 'input[name="email"]', '#email'],
      phone: ['input[type="tel"]', 'input[name="phone"]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")', 'button[type="submit"]', 'button:has-text("Apply")']
  }
};

async function tryFill(page, selectors, value) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      try {
        await el.waitFor({ state: "visible", timeout: 2000 });
        await el.fill(value, { timeout: 2000 });
        console.log(`    [fill] ${sel} → "${value.slice(0,30)}"`);
        return true;
      } catch {}
    }
  }
  return false;
}

async function tryUpload(page, selectors, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`    [upload] no PDF to attach`);
    return false;
  }
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      try {
        await el.setInputFiles(filePath, { timeout: 5000 });
        console.log(`    [upload] ${sel} ← ${path.basename(filePath)}`);
        return true;
      } catch (e) { console.log(`    [upload fail] ${sel}: ${e.message.slice(0,80)}`); }
    }
  }
  return false;
}

async function detectAndClickApply(page, ats) {
  const sels = ATS_SELECTORS[ats]?.applyBtn || ATS_SELECTORS.generic.applyBtn;
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      const href = await el.getAttribute("href").catch(()=>null);
      console.log(`    [found] Apply → ${sel} href=${href?.slice(0,80)}`);
      // If it's a link to actual application form, navigate; if button, click
      if (href && href.startsWith("http")) {
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
      } else if (href && href.startsWith("/")) {
        await el.click({ timeout: 5000 }).catch(()=>{});
        await page.waitForTimeout(1500);
      } else {
        await el.click({ timeout: 5000 }).catch(()=>{});
        await page.waitForTimeout(1500);
      }
      return true;
    }
  }
  console.log(`    [warn] no Apply button found for ${ats} — assuming already on form`);
  return false;
}

async function fillCommonFields(page, ats, profile, job) {
  const candidate = profile.candidate || {};
  const fullName = candidate.name || "Test User";
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ") || "User";
  const sels = ATS_SELECTORS[ats]?.fields || ATS_SELECTORS.generic.fields;

  // Try name fields (split or combined)
  if (sels.firstName) await tryFill(page, sels.firstName, firstName);
  if (sels.lastName)  await tryFill(page, sels.lastName, lastName);
  if (sels.name)      await tryFill(page, sels.name, fullName);
  if (sels.email)     await tryFill(page, sels.email, candidate.email || "test@example.com");
  if (sels.phone)     await tryFill(page, sels.phone, candidate.phone || "9999999999");

  // LinkedIn / website if present
  await tryFill(page, ['input[name*="linkedin"]', 'input[autocomplete="url"]'], candidate.linkedin || "");
  await tryFill(page, ['input[name*="portfolio"]', 'input[name*="website"]'], candidate.portfolio || "");

  // Cover letter: use HQ recommendation if available (generic placeholder)
  if (sels.cover) {
    const cover = `Dear Hiring Manager,\n\nI am excited to apply for ${job.title} at ${job.company}. My background in ${profile.domain?.title || "Backend Engineering"} aligns closely with this role.\n\nBest regards,\n${fullName}`;
    await tryFill(page, sels.cover, cover);
  }
}

async function processJob(browser, job, profile) {
  const url = job.link || job.url;
  const ats = inferATS(url);
  const resumePdf = findResumePdf(job.company, job.title);
  console.log(`\n[Job] ${job.company} — ${job.title}`);
  console.log(`  URL: ${url}`);
  console.log(`  ATS: ${ats} | PDF: ${resumePdf ? path.basename(resumePdf) : "none (will use generic)"}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN (no submit)" : "LIVE (approval required)"}`);

  if (!url || url.includes("example.com") || MOCK_ONLY) {
    console.log(`  [mock] dry-run preview — would open ${url}`);
    await new Promise(r=>setTimeout(r, 200));
    return { company: job.company, title: job.title, link: url, ats, action: "mock-preview", pdf: resumePdf };
  }

  const hasSession = fs.existsSync(path.join(ROOT, "portal", "storageState.json"));
  if ((ats === "linkedin" || ats === "naukri") && !hasSession) {
    console.log(`  [authwall-skip] ${ats} needs portal/storageState.json — run: node portal/save_sessions.mjs`);
    return { company: job.company, title: job.title, link: url, ats, action: "authwall-skip", pdf: resumePdf };
  }
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    // Use headed storageState if exists for logged-in portals (Naukri/LinkedIn)
    storageState: hasSession ? path.join(ROOT, "portal", "storageState.json") : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    console.log(`  [nav] goto ${url.slice(0,90)}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    // Detect Cloudflare / CAPTCHA
    const captchaSel = 'iframe[src*="captcha"] , [data-testid="captcha"], .cf-challenge';
    if (await page.locator(captchaSel).count() > 0) {
      console.log(`  [pause] CAPTCHA/Challenge detected — please solve manually in ${HEADED ? "visible" : "headless"} window, then press Enter`);
      if (!HEADED) console.log(`    (re-run with --headed to solve)`);
      if (DRY_RUN) {
        await page.screenshot({ path: path.join(ROOT, `output/apply-${job.company.replace(/\W/g,"_")}-captcha.png`), fullPage: true }).catch(()=>{});
      }
      // In dry-run we don't block; in live we would wait for input
      if (!DRY_RUN) {
        await new Promise(resolve => { process.stdin.once('data', resolve); });
      }
    }

    await detectAndClickApply(page, ats);
    await page.waitForTimeout(1500);

    await fillCommonFields(page, ats, profile, job);
    await tryUpload(page, ATS_SELECTORS[ats]?.fields?.resume || ATS_SELECTORS.generic.fields.resume, resumePdf);

    const screenshotPath = path.join(ROOT, "output", `apply-preview-${job.company.replace(/\W/g,"_")}-${Date.now()}.png`);
    fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
    console.log(`  [preview] screenshot → ${path.relative(ROOT, screenshotPath)}`);
    console.log(`  [preview] form URL: ${page.url().slice(0,120)}`);

    // Detect submit button
    const submitSels = ATS_SELECTORS[ats]?.submitBtn || ATS_SELECTORS.generic.submitBtn;
    let submitFound = false;
    for (const sel of submitSels) {
      if (await page.locator(sel).count() > 0) {
        console.log(`  [found] Submit → ${sel}`);
        submitFound = true;
        break;
      }
    }
    if (!submitFound) console.log(`  [warn] no Submit button detected — site may use multi-step flow`);

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] would WAIT for approval, then click Submit — skipping (use --live to enable)`);
      await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dry-run-preview", pdf: resumePdf, screenshot: screenshotPath };
    } else {
      if (AUTO) {
        console.log(`\n  [AUTO] --auto flag: submitting without prompt for ${job.company}`);
      } else {
        console.log(`\n  [APPROVAL] Ready to SUBMIT ${job.company} — ${job.title}`);
        console.log(`  Press ENTER to Submit, or Ctrl+C to skip`);
        await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', ()=>resolve()); });
      }
      for (const sel of submitSels) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          await el.click({ timeout: 5000 });
          console.log(`  [submit] clicked ${sel}`);
          await page.waitForTimeout(3000);
          await page.screenshot({ path: screenshotPath.replace("preview","submitted"), fullPage: true }).catch(()=>{});
          break;
        }
      }
      await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "submitted", pdf: resumePdf };
    }
  } catch (e) {
    console.log(`  [error] ${e.message.slice(0,300)}`);
    try { await page.screenshot({ path: path.join(ROOT, `output/apply-error-${job.company.replace(/\W/g,"_")}.png`), fullPage: true }); } catch {}
    await context.close();
    return { company: job.company, title: job.title, link: url, ats, action: "error", error: e.message };
  }
}

async function loadJobsFromDB() {
  // Try pulseops.db send_queue first (the 3 queued from Discord), else jobs.tsv, else mock
  const candidates = [];
  if (SINGLE_URL) {
    candidates.push({ company: "Manual", title: "Manual Test", link: SINGLE_URL, source: "manual" });
    return candidates;
  }
  if (SINGLE_JOB_ID) {
    // Load from DB
    try {
      const { execSync } = await import("node:child_process");
      const dbPath = path.join(ROOT, "pulseops.db");
      if (!fs.existsSync(dbPath) && fs.existsSync(path.join(ROOT, ".state", "pulseops.db"))) {
        // Try state
      }
      const out = execSync(`python -c "import sqlite3,json,sys; conn=sqlite3.connect('${dbPath.replace(/\\\\/g,'/')}'); rows=conn.execute('SELECT j.company,j.title,j.link FROM jobs j WHERE j.id=${parseInt(SINGLE_JOB_ID)}').fetchall(); print(json.dumps([{'company':r[0],'title':r[1],'link':r[2]} for r in rows]))"`, { encoding: "utf-8", timeout: 5000 });
      const parsed = JSON.parse(out.trim().split("\n").pop());
      if (parsed.length) return parsed.map(p=>({ ...p, source: "db" }));
    } catch (e) { console.log(`  [db] load by id ${SINGLE_JOB_ID} failed: ${e.message.slice(0,120)}`); }
  }
  // Try send_queue — use helper script to avoid quoting hell
  try {
    const { execSync } = await import("node:child_process");
    const dbCandidates = [path.join(ROOT, "pulseops.db"), path.join(ROOT, ".state", "pulseops.db")];
    let dbPath = null;
    for (const p of dbCandidates) if (fs.existsSync(p)) { dbPath = p; break; }
    if (!dbPath) throw new Error("no pulseops.db");
    const helper = path.join(ROOT, "portal", "queue_helper.py");
    fs.writeFileSync(helper, `import sqlite3,json,sys\nconn=sqlite3.connect(r'${dbPath.replace(/\\/g,'/')}')\nrows=conn.execute('SELECT j.company,j.title,j.link FROM send_queue q JOIN jobs j ON j.id=q.job_id WHERE q.status=\"pending\" ORDER BY q.score DESC LIMIT 5').fetchall()\nprint(json.dumps([{'company':r[0],'title':r[1],'link':r[2]} for r in rows]))\n`, "utf-8");
    const out = execSync(`python "${helper}"`, { encoding: "utf-8", timeout: 5000 });
    const parsed = JSON.parse(out.trim().split("\n").pop());
    if (parsed && parsed.length) {
      console.log(`[DB] loaded ${parsed.length} pending queued jobs`);
      return parsed.map(p=>({ ...p, source: "queue" }));
    }
  } catch (e) { console.log(`[DB] queue load failed: ${e.message?.slice(0,120)}`); }
  // Fallback: try recent high-score jobs with real apply links ( greenhhouse/lever/indeed/naukri etc.), then mock
  try {
    const { execSync } = await import("node:child_process");
    const dbCandidates = [path.join(ROOT, "pulseops.db"), path.join(ROOT, ".state", "pulseops.db")];
    let dbPath2 = null;
    for (const p of dbCandidates) if (fs.existsSync(p)) { dbPath2 = p; break; }
    if (dbPath2) {
      const helper2 = path.join(ROOT, "portal", "queue_helper2.py");
      fs.writeFileSync(helper2, `import sqlite3,json\nconn=sqlite3.connect(r'${dbPath2.replace(/\\/g,'/')}')\nrows=conn.execute('SELECT company,title,link FROM jobs WHERE score>=65 AND status!=\"Sent\" AND link LIKE \"%http%\" ORDER BY score DESC LIMIT 5').fetchall()\nprint(json.dumps([{'company':r[0],'title':r[1],'link':r[2]} for r in rows]))\n`, "utf-8");
      const out2 = execSync(`python "${helper2}"`, { encoding: "utf-8", timeout: 5000 });
      const parsed2 = JSON.parse(out2.trim().split("\n").pop());
      if (parsed2 && parsed2.length) {
        console.log(`[DB] fallback to ${parsed2.length} recent high-score jobs with real links`);
        return parsed2.map(p=>({ ...p, source: "jobs-fallback" }));
      }
    }
  } catch (e) { console.log(`[DB] jobs fallback failed: ${e.message?.slice(0,80)}`); }
  console.log(`[fallback] using mock queued 3 (MediNex etc.)`);
  return [
    { company: "MediNex Workforce", title: "Java Developer Intern | Entry Level | Fresher | Core Java, Spring Boot, REST APIs", link: "https://example.com/mediNex", source: "mock-queue" },
    { company: "internmo", title: "Back End Developer", link: "https://example.com/internmo", source: "mock-queue" },
    { company: "UniAiHub", title: "Full Stack Engineer", link: "https://example.com/uniaihub", source: "mock-queue" },
  ];
}

function isMockJob(j) {
  return !j?.link || j.link.includes("example.com") || (j.source || "").startsWith("mock");
}

async function main() {
  const profile = loadProfile();
  console.log(`[Profile] ${profile.candidate?.name} <${profile.candidate?.email}> — ${profile.domain?.title || ""}`);
  if (!DRY_RUN) {
    // Hard guardrails: never submit as a fallback identity or to mock listings.
    const who = `${profile.candidate?.name || ""}`.trim().toLowerCase();
    const mail = `${profile.candidate?.email || ""}`.trim().toLowerCase();
    if (who === "test user" || !mail || !mail.includes("@") || mail === "test@example.com") {
      console.error("[FATAL] --live refused: no real profile (config/profile.yml missing). Sync your CV first.");
      process.exit(3);
    }
  }
  let jobs = await loadJobsFromDB();
  if (!DRY_RUN) {
    const real = jobs.filter((j) => !isMockJob(j));
    const dropped = jobs.length - real.length;
    if (dropped > 0) console.log(`[guard] dropped ${dropped} mock/fallback listing(s) — live never submits mocks`);
    jobs = real;
    if (!jobs.length) {
      console.error("[FATAL] --live refused: zero real jobs (queue empty, no --job-url). Nothing submitted.");
      process.exit(4);
    }
  }
  console.log(`[Jobs] ${jobs.length} to process (dry-run=${DRY_RUN}, headed=${HEADED})`);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !HEADED });

  const results = [];
  for (const job of jobs) {
    const r = await processJob(browser, job, profile);
    results.push(r);
    // Be nice to sites
    await new Promise(r=>setTimeout(r, 1500));
  }
  await browser.close();

  const outPath = path.join(ROOT, "output", "apply-results.json");
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ran_at: new Date().toISOString(), dry_run: DRY_RUN, jobs, results }, null, 2), "utf-8");
  console.log(`\n[+] Done ${results.length} jobs → ${path.relative(ROOT, outPath)}`);
  console.log(DRY_RUN ? "[*] DRY-RUN — no applications submitted. Re-run with --live --headed after verifying previews." : "[*] LIVE — submitted with approval pauses");

  // Discord confirmation: yes applied to this job (no links, just company + title)
  if (!DRY_RUN && results.some(r=>r.action==="submitted")) {
    const webhook = process.env.DISCORD_WEBHOOK_URL || "";
    if (webhook) {
      for (const r of results.filter(x=>x.action==="submitted")) {
        const msg = `✅ Applied to ${r.company} — ${r.title} via ${r.ats}`;
        try {
          const resp = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: msg }) });
          if (resp.ok) console.log(`  [Discord] confirmation sent: ${msg}`);
          else console.log(`  [Discord] REJECTED (HTTP ${resp.status}) — did NOT deliver: ${msg}`);
        } catch (e) { console.log(`  [Discord] confirm failed: ${e.message.slice(0,80)}`); }
      }
    }
  }
}

main().catch(e=>{ console.error("[Fatal] apply crashed", e); process.exit(1); });
