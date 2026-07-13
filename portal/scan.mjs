#!/usr/bin/env node
/**
 * portal/scan.mjs — Weekly Playwright portal scanner (PulseOps Phase 11)
 *
 * Reads portal/portals.yml, scrapes every enabled portal that doesn't
 * require auth, and writes the combined results to temp_portal_jobs.json
 * in the repo root — the same hand-off pattern linkedin_bridge.js uses
 * for the daily pipeline (a Node sidecar writes JSON, Python reads it).
 *
 * Auth-required portals are never attempted — they're collected into the
 * `skipped` list with their direct URL so main_weekly.py can fire a
 * Telegram alert with the link instead (per the gap-analysis decision:
 * "Auth-required portals: skipped with Telegram alert + direct link").
 *
 * Usage:
 *   node portal/scan.mjs            Live scan (needs network + chromium)
 *   node portal/scan.mjs --mock     Zero-network mock data (matches
 *                                   PulseOps's --simulate philosophy —
 *                                   used by `main_weekly.py --simulate`
 *                                   and by CI / sandboxed dev environments)
 *
 * Selector maintenance note: Greenhouse/Lever have very stable, long-lived
 * DOM structures and Ashby exposes a public JSON API, so those three are
 * the most reliable engines here. Naukri and Wellfound are React/JS-heavy
 * consumer sites that change markup more often — their selectors are
 * best-effort with fallback chains; if a scan returns 0 jobs for one of
 * them, check the selectors against the live page before assuming the
 * portal itself is empty.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORTALS_PATH = path.join(__dirname, "portals.yml");
const OUTPUT_PATH = path.join(ROOT, "temp_portal_jobs.json");

const MOCK = process.argv.includes("--mock");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function loadPortals() {
  const raw = fs.readFileSync(PORTALS_PATH, "utf-8");
  return yaml.load(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mock mode (zero network, mirrors --simulate philosophy) ───────────────

function mockJobsFor(portal) {
  return [
    {
      title: `Backend Engineer Intern (${portal.engine})`,
      company: portal.company || portal.name,
      link: portal.url,
      description: `[Mock] Backend role sourced from ${portal.name} via the weekly portal scan. ` +
        "Java/Go/Python, REST APIs, PostgreSQL, Docker.",
      source: portal.name,
    },
    {
      title: `Software Engineer, New Grad (${portal.engine})`,
      company: portal.company || portal.name,
      link: portal.url + "#mock-2",
      description: `[Mock] Systems/infra role sourced from ${portal.name}. Distributed systems, Kafka, Kubernetes.`,
      source: portal.name,
    },
  ];
}

// ── Engine-specific extractors (live mode) ─────────────────────────────────

async function scrapeGreenhouse(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".opening, .job-post, body", { timeout: 10000 }).catch(() => {});
  return page.$$eval(".opening, .job-post", (nodes, company) =>
    nodes.map((el) => {
      const a = el.querySelector("a");
      const loc = el.querySelector(".location, .job-post__location");
      return {
        title: (a?.textContent || "").trim(),
        company,
        link: a ? new URL(a.getAttribute("href"), location.origin).href : "",
        description: `Location: ${(loc?.textContent || "").trim()}`,
      };
    }).filter((j) => j.title && j.link)
  , portal.company || portal.name);
}

async function scrapeLever(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".posting, body", { timeout: 10000 }).catch(() => {});
  return page.$$eval(".posting", (nodes, company) =>
    nodes.map((el) => {
      const titleEl = el.querySelector(".posting-title h5, h5");
      const linkEl = el.querySelector("a.posting-title, a[href]");
      const catEls = el.querySelectorAll(".posting-categories span, .sort-by-team, .sort-by-location");
      const cats = Array.from(catEls).map((c) => c.textContent.trim()).join(" · ");
      return {
        title: (titleEl?.textContent || "").trim(),
        company,
        link: linkEl ? linkEl.getAttribute("href") : "",
        description: cats,
      };
    }).filter((j) => j.title && j.link)
  , portal.company || portal.name);
}

async function scrapeAshby(page, portal, request) {
  // Ashby exposes a public JSON API for job boards — far more reliable
  // than scraping the client-rendered SPA.
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${portal.company}?includeCompensation=false`;
  try {
    const resp = await request.get(apiUrl, { timeout: 15000 });
    if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
    const data = await resp.json();
    const jobs = data.jobs || [];
    return jobs.map((j) => ({
      title: j.title || "Untitled",
      company: portal.company || portal.name,
      link: j.jobUrl || j.applyUrl || portal.url,
      description: `Location: ${j.location || "?"}. ${(j.descriptionPlain || "").slice(0, 300)}`,
    }));
  } catch (e) {
    console.error(`  [Ashby] JSON API failed for ${portal.name}, falling back to DOM: ${e.message}`);
    await page.goto(portal.url, { waitUntil: "networkidle", timeout: 30000 });
    return page.$$eval("a[href*='/jobs/']", (nodes, company) =>
      nodes.map((a) => ({
        title: (a.textContent || "").trim(),
        company,
        link: a.href,
        description: "",
      })).filter((j) => j.title && j.title.length > 3)
    , portal.company || portal.name);
  }
}

async function scrapeNaukri(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page
    .waitForSelector(".jobTuple, article.jobTuple, .srp-jobtuple-wrapper, body", { timeout: 12000 })
    .catch(() => {});
  return page.$$eval(
    ".jobTuple, article.jobTuple, .srp-jobtuple-wrapper",
    (nodes, sourceName) =>
      nodes.map((el) => {
        const titleEl = el.querySelector("a.title, .title a, a[title]");
        const compEl = el.querySelector(".comp-name, .companyInfo .comp-name, a.comp-name");
        const locEl = el.querySelector(".locWdth, .loc span, .location");
        return {
          title: (titleEl?.textContent || titleEl?.getAttribute("title") || "").trim(),
          company: (compEl?.textContent || "").trim() || "Unknown",
          link: titleEl ? titleEl.getAttribute("href") : "",
          description: `Location: ${(locEl?.textContent || "").trim()}. Source: ${sourceName}.`,
        };
      }).filter((j) => j.title && j.link),
    portal.name
  );
}

async function scrapeWellfound(page, portal) {
  await page.goto(portal.url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500); // SPA hydration
  return page.$$eval(
    "a[href*='/jobs/'], a[href*='/role/']",
    (nodes, sourceName) =>
      nodes
        .map((a) => ({
          title: (a.textContent || "").trim(),
          company: "Unknown",
          link: a.href,
          description: `Source: ${sourceName}.`,
        }))
        .filter((j) => j.title && j.title.length > 4 && j.title.length < 120),
    portal.name
  );
}

const ENGINES = {
  greenhouse: scrapeGreenhouse,
  lever: scrapeLever,
  ashby: scrapeAshby,
  naukri: scrapeNaukri,
  wellfound: scrapeWellfound,
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const config = loadPortals();
  const allPortals = [
    ...(config.search_portals || []),
    ...(config.ats_portals || []),
  ];
  const settings = config.settings || {};
  const delayMs = (settings.delay_between_portals_seconds ?? 2) * 1000;
  const maxJobs = settings.max_jobs_per_portal ?? 40;

  const results = { jobs: [], skipped: [], failed: [], scanned_at: new Date().toISOString(), mock: MOCK };

  if (MOCK) {
    console.log("[*] MOCK mode — zero network calls, zero browser launch.");
    for (const portal of allPortals) {
      if (!portal.enabled) continue;
      if (portal.requires_auth) {
        results.skipped.push({ name: portal.name, url: portal.url, reason: "requires_auth" });
        continue;
      }
      const jobs = mockJobsFor(portal).map((j) => ({ ...j, source: portal.name }));
      results.jobs.push(...jobs);
      console.log(`  [Mock] ${portal.name}: ${jobs.length} job(s)`);
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
    console.log(`[+] Wrote ${results.jobs.length} mock jobs → ${OUTPUT_PATH}`);
    return;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: settings.headless !== false });
  const context = await browser.newContext({
    userAgent: pickUserAgent(),
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(settings.page_timeout_ms ?? 30000);

  for (const portal of allPortals) {
    if (!portal.enabled) continue;

    if (portal.requires_auth) {
      console.log(`  [Skip] ${portal.name}: requires_auth — flagging with direct link`);
      results.skipped.push({ name: portal.name, url: portal.url, reason: "requires_auth" });
      continue;
    }

    const engineFn = ENGINES[portal.engine];
    if (!engineFn) {
      console.error(`  [Warn] ${portal.name}: unknown engine '${portal.engine}'`);
      results.failed.push({ name: portal.name, url: portal.url, error: `unknown engine ${portal.engine}` });
      continue;
    }

    console.log(`[*] Scanning ${portal.name} (${portal.engine})…`);
    try {
      let jobs;
      if (portal.engine === "ashby") {
        jobs = await engineFn(page, portal, context.request);
      } else {
        jobs = await engineFn(page, portal);
      }
      jobs = jobs.slice(0, maxJobs).map((j) => ({ ...j, source: portal.name }));
      results.jobs.push(...jobs);
      console.log(`  [+] ${portal.name}: ${jobs.length} job(s)`);
    } catch (e) {
      console.error(`  [X] ${portal.name} failed: ${e.message}`);
      results.failed.push({ name: portal.name, url: portal.url, error: e.message });
    }

    await sleep(delayMs);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(
    `[+] Scan complete: ${results.jobs.length} job(s), ${results.skipped.length} skipped (auth), ` +
    `${results.failed.length} failed → ${OUTPUT_PATH}`
  );
}

main().catch((e) => {
  console.error("[Fatal] portal scan crashed:", e);
  // Always write *something* so main_weekly.py doesn't choke on a missing file —
  // same "never silent, never crash the caller" principle as linkedin_bridge.js.
  try {
    fs.writeFileSync(
      OUTPUT_PATH,
      JSON.stringify({ jobs: [], skipped: [], failed: [{ name: "ALL", error: e.message }], scanned_at: new Date().toISOString(), mock: MOCK }, null, 2)
    );
  } catch {}
  process.exit(1);
});
