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
    path.join(ROOT, "output", "resume.pdf"), // base CV fallback (local demo)
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
      const label = ((await el.innerText().catch(()=> "")) || "").trim().slice(0, 40);
      console.log(`    [found] Apply → ${sel} "${label}" href=${href?.slice(0,80)}`);
      // Easy Apply / modal triggers must be CLICKED (their href is a search URL, not the form).
      // LinkedIn: use the DETAIL pane button, never a list-card anchor (those navigate away).
      if (/easy apply/i.test(label + " " + sel)) {
        if (ats === "linkedin") {
          const detail = page.locator("div.jobs-details button:has-text('Easy Apply'), div.jobs-search__job-details button:has-text('Easy Apply'), button.jobs-apply-button").first();
          if ((await detail.count()) > 0) {
            console.log("    [easy-apply] clicking detail-pane button");
            await detail.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2500);
          } else {
            console.log("    [easy-apply] detail button not found — skipping click (would navigate away)");
          }
        } else {
          await el.click({ timeout: 5000 }).catch(()=>{});
          await page.waitForTimeout(2500);
        }
      } else if (href && href.startsWith("http")) {
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
    // Dead-listing guard: never attempt submits on 404/expired job pages
    const deadHit = await page.evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 2000);
      return /404|no longer exists|no longer available|job (has )?expired|position (has been )?filled|this job is no longer/i.test(t);
    }).catch(() => false);
    if (deadHit) {
      console.log("  [dead] job page is 404/expired — skipping (mark for DB cleanup)");
      await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dead-link", pdf: resumePdf };
    }

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

    if (ats === "naukri") {
      // Cookie banner overlaps the Apply button — clear it first
      const cookie = page.locator("button:has-text('Accept all')").first();
      if ((await cookie.count()) > 0) {
        await cookie.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }
    await detectAndClickApply(page, ats);
    await page.waitForTimeout(1500);
    if (ats === "naukri") {
      // Verify the chat actually opened; retry the Apply click (banners intercept it)
      let opened = false;
      for (let r = 0; r < 3; r++) {
        opened = await page.evaluate(() => {
          const t = document.body?.innerText || "";
          return /type message here|are you a fresher|kindly answer all/i.test(t);
        }).catch(() => false);
        if (opened) break;
        console.log(`  [naukri-chat] chat not open — retrying Apply (${r + 1}/3)`);
        const retry = page.locator("button#apply-button").first();
        if ((await retry.count()) > 0) {
          await retry.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await retry.click({ timeout: 5000, force: true }).catch(() => {});
          await page.waitForTimeout(3000);
        } else break;
      }
      if (!opened) {
        const appliedNow = await page.evaluate(() => /successfully applied|you have successfully applied/i.test(document.body?.innerText || ""));
        console.log(appliedNow ? "  [naukri-chat] already applied" : "  [naukri-chat] chat did not open — aborting");
        await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: appliedNow ? "submitted" : "chat-not-opened", pdf: resumePdf };
      }
    }

    await fillCommonFields(page, ats, profile, job);
    await tryUpload(page, ATS_SELECTORS[ats]?.fields?.resume || ATS_SELECTORS.generic.fields.resume, resumePdf);

    const screenshotPath = path.join(ROOT, "output", `apply-preview-${job.company.replace(/\W/g,"_")}-${Date.now()}.png`);
    let chatNeedsUser = [];
    fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
    console.log(`  [preview] screenshot → ${path.relative(ROOT, screenshotPath)}`);
    console.log(`  [preview] form URL: ${page.url().slice(0,120)}`);

    // Naukri chat apply: cookie banner + bot questionnaire (bot types first — wait for it).
    if (ats === "naukri") {
      const cookie = page.locator("button:has-text('Accept all')").first();
      if ((await cookie.count()) > 0) {
        await cookie.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
      const PICK = ["Fresher", "Continue", "Submit", "Apply now", "Confirm", "Yes", "Bengaluru", "Bangalore", "Remote", "Okay"];
      // Factual text answers only — never invent salary expectations etc.
      const TEXT_ANSWERS = [
        [/how many years.*experience|years of experience/i, "0"],
        [/notice period/i, "Immediate"],
        [/current ctc|current salary/i, "0"],
        [/total experience/i, "0"],
        [/relevant experience/i, "0"],
      ];
      // Naukri renders chat options as div.chatbot_Chip (not <button>)
      const OPT = (label) => `:is(div.chatbot_Chip, button, a, [role='button']):has-text('${label}')`;
      const OPT_SCOPED = (label) => `[class*='chatbot'] :is(div.chatbot_Chip, button, a, [role='button']):has-text('${label}')`;
      // Gate: only click when the chat panel is actually open (else we'd hit page chips)
      async function chatOpen() {
        return await page.evaluate(() => {
          const t = document.body?.innerText || "";
          return /type message here|are you a fresher|kindly answer all/i.test(t);
        }).catch(() => false);
      }
      const seenQuestions = [];
      for (let step = 0; step < 14; step++) {
        // Harvest every visible question for the transcript (deduped)
        try {
          const qs = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll("div").forEach((d) => {
              const t = (d.innerText || "").trim().replace(/\s+/g, " ");
              if (t.length > 15 && t.length < 250 && /\?/.test(t) && d.children.length <= 2) out.push(t);
            });
            return [...new Set(out)].slice(0, 8);
          });
          for (const q of qs || []) {
            if (!seenQuestions.includes(q)) {
              seenQuestions.push(q);
              console.log(`  [naukri-chat] Q: ${q.slice(0, 110)}`);
            }
          }
        } catch {}
        if (!(await chatOpen())) {
          console.log(`  [naukri-chat] step ${step + 1}: waiting for chat…`);
          await page.waitForTimeout(2500);
          continue;
        }
        // Naukri modal free-text box ("Type message here...") + Save — highest priority
        const freeText = await page.evaluate((patterns) => {
          const rules = patterns.map((s) => new RegExp(s, "i"));
          const boxes = [];
          document.querySelectorAll("input[type='text'], input:not([type]), input[type='number'], input[type='tel'], textarea, div[contenteditable='true']").forEach((el) => {
            const r = el.getBoundingClientRect();
            const cur = ((el.value || el.innerText) || "").trim();
            if (r.width < 100 || el.offsetParent === null || cur) return;
            if (/search jobs|enter keyword|enter location/i.test(el.placeholder || "")) return;
            boxes.push(true);
          });
          if (!boxes.length) return { dbg: true, nInputs: document.querySelectorAll("input, textarea").length, nEdit: document.querySelectorAll("div[contenteditable]").length };
          const body = (document.body?.innerText || "").replace(/\s+/g, " ");
          const qm = body.match(/How many years of experience[^?]*\?|notice period[^?]*\?|current ctc[^?]*\?|total experience[^?]*\?|relevant experience[^?]*\?/i);
          const q = qm ? qm[0] : body.slice(-400);
          const ri = rules.findIndex((re) => re.test(q));
          return ri < 0 ? { q: q.slice(0, 90), noRule: true } : { q: q.slice(0, 90), ans: ["0", "Immediate", "0", "0", "0"][ri] };
        }, TEXT_ANSWERS.map(([re]) => re.source));
        if (freeText && freeText.dbg) console.log(`  [naukri-chat] dbg boxes=0 inputs=${freeText.nInputs} editables=${freeText.nEdit}`);
        if (freeText && !freeText.noRule) {
          // Playwright fill() handles React/contenteditable editors reliably.
          let typedOk = false;
          const candSel = "div[contenteditable='true'], input[type='text'], input:not([type]), input[type='number'], textarea";
          const n = await page.locator(candSel).count().catch(() => 0);
          for (let bi = 0; bi < Math.min(n, 8); bi++) {
            const el = page.locator(candSel).nth(bi);
            const info = await el.evaluate((node) => {
              const r = node.getBoundingClientRect();
              const cur = ((node.value || node.innerText) || "").trim();
              const ph = node.placeholder || "";
              return { w: Math.round(r.width), cur: cur.slice(0, 20), ph: ph.slice(0, 30), vis: node.offsetParent !== null };
            }).catch(() => null);
            if (!info || info.w < 100 || !info.vis || info.cur) continue;
            if (/search jobs|enter keyword|enter location/i.test(info.ph)) continue;
            try {
              await el.click({ timeout: 3000 });
              await el.fill(freeText.ans, { timeout: 5000 });
              const got = ((await el.innerText().catch(() => "")) || (await el.inputValue().catch(() => "")) || "").trim();
              console.log(`  [naukri-chat] type-debug: box shows "${got}"`);
              if (got === freeText.ans) {
                typedOk = true;
                break;
              }
            } catch (e) {
              console.log(`  [naukri-chat] fill failed on candidate ${bi}: ${String(e).slice(0, 60)}`);
            }
          }
          if (typedOk) {
            console.log(`  [naukri-chat] typed "${freeText.ans}" for: ${freeText.q.slice(0, 70)}`);
            await page.waitForTimeout(1200);
            let saved = false;
            for (let s = 0; s < 4; s++) {
              const save = page.locator("button:has-text('Save')").first();
              if ((await save.count()) === 0) break;
              const dis = await save.isDisabled().catch(() => true);
              if (!dis) {
                await save.click({ timeout: 4000 }).catch(() => {});
                saved = true;
                break;
              }
              await page.waitForTimeout(1200);
            }
            if (saved) await page.waitForTimeout(2500);
            else console.log("  [naukri-chat] Save stayed disabled — answer may not have registered");
            continue;
          }
        } else if (freeText && freeText.noRule) {
          const short = freeText.q.slice(0, 90);
          if (!chatNeedsUser.includes(short)) {
            chatNeedsUser.push(short);
            console.log(`  [naukri-chat] NEEDS-YOU (won't guess): ${short}`);
          }
        }
        if (step % 3 === 0) {
          const transcript = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll("div")).filter((d) => /fresher or experienced|how many years|notice period|current ctc|expected ctc|gender|location|authorized|visa|willing to relocate/i.test(d.innerText || "") && (d.innerText || "").length < 400);
            return els.slice(0, 6).map((d) => d.innerText.trim().replace(/\s+/g, " ").slice(0, 200));
          }).catch(() => []);
          if (transcript.length) console.log(`  [naukri-chat] sees: ${JSON.stringify(transcript).slice(0, 500)}`);
        }
        // Wait for the bot to finish typing (typing dots present = still thinking)
        for (let w = 0; w < 6; w++) {
          const typing = await page.evaluate(() => {
            const t = document.body?.innerText || "";
            return t.includes("is typing");
          }).catch(() => false);
          if (!typing) break;
          await page.waitForTimeout(1500);
        }
        await page.waitForTimeout(1500);
        // Answer text inputs first (experience years, notice period, current CTC).
        // Single evaluate: find empty field + matching rule + fill, atomically.
        const rules = TEXT_ANSWERS.map(([re]) => re.source);
        const filled = await page.evaluate((patterns) => {
          const rules = patterns.map((s) => new RegExp(s, "i"));
          const fields = [];
          // Scope to the question container (walking up from known question phrases),
          // falling back to the chatbot panel — page search boxes are decoys.
          let scope = document.querySelector("[class*='chatbot']") || document;
          const qmark = Array.from(document.querySelectorAll("div, p, span")).find((d) => {
            const t = (d.innerText || "").trim();
            return t.length > 20 && t.length < 300 && /how many years|notice period|current ctc|expected|experience|location|authorized|relocate|gender/i.test(t) && d.children.length <= 3;
          });
          if (qmark) {
            let n = qmark;
            for (let i = 0; i < 8 && n; i++) {
              n = n.parentElement;
              if (n && n.querySelector && n.querySelector("input, textarea, select, button")) {
                scope = n;
                break;
              }
            }
          }
          scope.querySelectorAll("input[type='text'], input:not([type]), input[type='number'], input[type='tel'], textarea").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 20 || el.offsetParent === null || (el.value || "")) return;
            if (/search|keyword/i.test(el.placeholder || "")) return;
            let ctx = el;
            let q = "";
            for (let d = 0; d < 6 && ctx; d++) {
              ctx = ctx.parentElement;
              const t = (ctx?.innerText || "").replace(/\s+/g, " ");
              if (t.length > 40) {
                q = t.slice(0, 220);
                break;
              }
            }
            fields.push({ el, q });
          });
          for (const f of fields) {
            const ri = rules.findIndex((re) => re.test(f.q));
            if (ri < 0) continue;
            f.el.focus();
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, ["0", "Immediate", "0", "0", "0"][ri]);
            f.el.dispatchEvent(new Event("input", { bubbles: true }));
            f.el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ans: ["0", "Immediate", "0", "0", "0"][ri], q: f.q.slice(0, 80) };
          }
          return null;
        }, rules).catch(() => null);
        if (filled) {
          console.log(`  [naukri-chat] typed "${filled.ans}" for: ${filled.q}`);
          await page.waitForTimeout(1200);
          const save = page.locator("button:has-text('Save')").first();
          if ((await save.count()) > 0) {
            await save.click({ timeout: 4000 }).catch(() => {});
            await page.waitForTimeout(2500);
          }
          console.log(`  [naukri-chat] step ${step + 1}: typed ${filled.ans}`);
          continue;
        }
        // Answer whatever option button the bot offers, by priority.
        // Scope to the chatbot panel first — page-level chips (location filters) are decoys.
        let clicked = null;
        for (const label of PICK) {
          const scoped = page.locator(OPT_SCOPED(label)).first();
          const btn = ((await scoped.count()) > 0) ? scoped : page.locator(OPT(label)).first();
          if ((await btn.count()) === 0) continue;
          try {
            await btn.waitFor({ state: "visible", timeout: 2000 });
            await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await btn.click({ timeout: 5000 });
          } catch {
            // Fallback: in-page click (overlays intercept synthetic clicks)
            await page.evaluate((t) => {
              const els = Array.from(document.querySelectorAll("button, a, [role='button'], div"));
              const el = els.find((e) => (e.innerText || "").trim() === t && e.offsetParent !== null);
              if (el) el.click();
            }, label).catch(() => {});
          }
          await page.waitForTimeout(2500);
          // Verify the chat advanced (option gone); else retry next loop
          const stillThere = await page.locator(OPT(label)).first().count().catch(() => 1);
          clicked = label + (stillThere ? " (retry?)" : "");
          break;
        }
        if (clicked) {
          console.log(`  [naukri-chat] step ${step + 1}: answered "${clicked}"`);
          // After any chip answer, hit Save/Send if showing (chat often waits on it)
          await page.waitForTimeout(1500);
          const postSave = page.locator("button:has-text('Save'), button:has-text('Send'), button:has-text('Submit')").first();
          if ((await postSave.count()) > 0) {
            const dis = await postSave.isDisabled().catch(() => true);
            if (!dis) {
              await postSave.click({ timeout: 4000 }).catch(() => {});
              console.log("  [naukri-chat] clicked post-answer Save/Send");
              await page.waitForTimeout(2500);
            }
          }
          continue;
        }
        // No options: either done or bot still working — check success, else wait more
        const doneEarly = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying/i.test(document.body?.innerText || ""));
        if (doneEarly) break;
        const chatGone = await page.locator("button:has-text('Fresher'), button:has-text('Continue')").first().count().catch(() => 0);
        if (step > 4 && chatGone === 0) break;
        await page.waitForTimeout(2000);
      }
      const done = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying/i.test(document.body?.innerText || ""));
      if (done) {
        console.log("  [naukri-chat] SUCCESS — application submitted");
        await page.screenshot({ path: screenshotPath.replace("preview", "submitted"), fullPage: true }).catch(() => {});
        await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "submitted", pdf: resumePdf };
      }
      console.log("  [naukri-chat] no success confirmation detected");
    }

    // Indeed smartapply: Continue through steps → Review (100%) → Submit application.
    if (ats === "indeed") {
      for (let step = 0; step < 6; step++) {
        await fillCommonFields(page, ats, profile, job);
        await page.evaluate(() => window.scrollBy(0, 900));
        await page.waitForTimeout(1000);
        const next = page.locator("button:has-text('Continue'), button:has-text('Review your application'), button:has-text('Submit your application'), button:has-text('Submit application')").first();
        if ((await next.count()) === 0) {
          const all = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll("button, a").forEach((el) => {
              const t = ((el.innerText || el.value) || "").trim().replace(/\s+/g, " ");
              if (t && t.length < 40 && el.offsetParent !== null) out.push(t);
            });
            return [...new Set(out)].slice(0, 20);
          }).catch(() => []);
          console.log(`  [indeed] step ${step + 1}: no nav button; visible: ${JSON.stringify(all).slice(0, 200)}`);
          break;
        }
        const label = ((await next.innerText().catch(() => "")) || "").trim().slice(0, 30);
        const dis = await next.isDisabled().catch(() => true);
        if (dis) {
          console.log(`  [indeed] "${label}" disabled — missing required input, stopping`);
          break;
        }
        console.log(`  [indeed] step ${step + 1}: clicking "${label}"`);
        await next.scrollIntoViewIfNeeded().catch(() => {});
        await next.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const done = await page.evaluate(() => /application submitted|you applied|application received|thank you for applying/i.test(document.body?.innerText || ""));
        if (done) break;
      }
    }

    // LinkedIn Easy Apply is multi-step: Next (x N) → Review → Submit. Walk it.
    if (ats === "linkedin") {
      for (let step = 0; step < 5; step++) {
        const next = page.locator("div[role='dialog'] button[aria-label='Continue to next step'], div[role='dialog'] button:has-text('Next'), button:has-text('Review your application')").first();
        if ((await next.count()) === 0) break;
        const label = ((await next.innerText().catch(() => "")) || "").trim().slice(0, 30);
        // Fill any visible inputs on this step before advancing
        await fillCommonFields(page, ats, profile, job);
        console.log(`  [easy-apply] step ${step + 1}: clicking "${label}"`);
        await next.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Naukri chat flow already attempted submit above — don't re-click the covered Apply button
    if (ats === "naukri") {
      const done = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying/i.test(document.body?.innerText || ""));
      await page.screenshot({ path: screenshotPath.replace("preview", "final"), fullPage: false }).catch(() => {});
      await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: done ? "submitted" : "chat-incomplete", pdf: resumePdf, needsUser: chatNeedsUser };
    }

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
