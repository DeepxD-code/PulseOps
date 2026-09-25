#!/usr/bin/env node
/**
 * apps/weekly-scan/scan.mjs — Weekly Playwright portal scanner (PulseOps Phase 11)
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
 *   node apps/weekly-scan/scan.mjs            Live scan (needs network + chromium)
 *   node apps/weekly-scan/scan.mjs --mock     Zero-network mock data (matches
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
const ROOT = path.resolve(__dirname, "../..");
const PORTALS_PATH = path.join(__dirname, "portals.yml");
const OUTPUT_PATH = path.join(ROOT, "temp_portal_jobs.json");

const MOCK = process.argv.includes("--mock");
const ALLOW_KNOWN_DEAD = process.argv.includes("--allow-known-dead");
const SIMULATED_SOURCE_PREFIX = "SIMULATED:";

// These portals have repeatedly failed unattended browser access.  They stay
// blocked even if an old config copy accidentally says enabled=true.  An
// operator can make a deliberate one-off override with --allow-known-dead.
const KNOWN_DEAD_ENGINES = new Set(["jobhai", "job-hai", "job_hai", "indeed"]);
const KNOWN_DEAD_NAMES = new Set(["job hai", "jobhai", "indeed", "indeed india"]);
const SKIP_PORTAL_VALUES = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--skip-portal="))
    .map((arg) => arg.slice("--skip-portal=".length).trim().toLowerCase())
    .filter(Boolean),
);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isEnabled(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  return !["false", "no", "0", "off", "disabled"].includes(String(value).trim().toLowerCase());
}

function isFlagTrue(value) {
  if (value === true) return true;
  return ["true", "yes", "1", "on", "required"].includes(String(value ?? "").trim().toLowerCase());
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return String(value || "").trim();
  }
}

function portalIdentity(portal) {
  const engine = String(portal.engine || "").trim().toLowerCase();
  const company = String(portal.company || "").trim().toLowerCase();
  return `${engine}|${company}|${canonicalUrl(portal.url)}`;
}

function normalizePortalEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const unique = new Map();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const portal = {
      ...raw,
      name: String(raw.name || raw.company || "Unnamed portal").trim(),
      engine: String(raw.engine || "").trim().toLowerCase(),
      url: String(raw.url || "").trim(),
      company: raw.company == null ? "" : String(raw.company).trim(),
      enabled: isEnabled(raw.enabled),
      requires_auth: isFlagTrue(raw.requires_auth),
    };
    const key = portalIdentity(portal);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, portal);
      continue;
    }
    // Duplicate config entries are merged conservatively.  If any copy is
    // disabled/auth-required, retain that safer state rather than accidentally
    // re-enabling a portal through a duplicate.
    unique.set(key, {
      ...previous,
      name: previous.name || portal.name,
      enabled: previous.enabled && portal.enabled,
      requires_auth: previous.requires_auth || portal.requires_auth,
    });
  }
  return [...unique.values()];
}

function portalMatchesSkip(portal) {
  const values = [portal.name, portal.engine, portal.company, portal.url]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return values.some((value) =>
    SKIP_PORTAL_VALUES.has(value) || SKIP_PORTAL_VALUES.has(canonicalUrl(value)),
  );
}

function isKnownDead(portal) {
  if (ALLOW_KNOWN_DEAD) return false;
  const engine = String(portal.engine || "").trim().toLowerCase();
  const name = String(portal.name || "").trim().toLowerCase();
  return KNOWN_DEAD_ENGINES.has(engine) || KNOWN_DEAD_NAMES.has(name);
}

function simulatedSource(source) {
  const value = String(source || "Portal").trim() || "Portal";
  return value.toUpperCase().startsWith(SIMULATED_SOURCE_PREFIX)
    ? value
    : `${SIMULATED_SOURCE_PREFIX}${value}`;
}

function absoluteHttpUrl(value, base) {
  try {
    const url = new URL(String(value || ""), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

const ENGINE_ALLOWED_HOSTS = Object.freeze({
  greenhouse: ["greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io"],
  lever: ["lever.co", "jobs.lever.co"],
  ashby: ["ashbyhq.com", "jobs.ashbyhq.com"],
  naukri: ["naukri.com"],
  instahyre: ["instahyre.com"],
  wellfound: ["wellfound.com", "angel.co"],
  indeed: ["indeed.com"],
  glassdoor: ["glassdoor.com", "glassdoor.co.in", "glassdoor.co.uk"],
  jobhai: ["jobhai.com"],
  yc: ["workatastartup.com", "ycombinator.com"],
  linkedin: ["linkedin.com"],
});

const ATS_ENGINES = new Set(["greenhouse", "lever", "ashby"]);
const ALL_ATS_HOSTS = new Set([
  ...ENGINE_ALLOWED_HOSTS.greenhouse,
  ...ENGINE_ALLOWED_HOSTS.lever,
  ...ENGINE_ALLOWED_HOSTS.ashby,
]);
const REDIRECT_QUERY_KEYS = new Set([
  "redirect", "redirect_url", "redirect_uri", "redirecturi", "return", "return_url",
  "returnurl", "next", "continue", "target", "dest", "destination", "goto", "url",
]);

function isKnownAtsHost(host) {
  const value = canonicalHost(host);
  return [...ALL_ATS_HOSTS].some((base) => value === base || value.endsWith(`.${base}`));
}

function canonicalHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(host, base) {
  const actual = canonicalHost(host);
  const suffix = canonicalHost(base);
  return !!actual && !!suffix && (actual === suffix || actual.endsWith(`.${suffix}`));
}

function isIpv4(value) {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isSuspiciousHost(host) {
  const value = canonicalHost(host);
  if (!value || value.length > 253 || value.includes("%") || value.includes("\\")) return true;
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".lan")) return true;
  if (value.endsWith(".invalid") || value.endsWith(".test") || value.endsWith(".example")) return true;
  // Private/link-local/cloud metadata addresses and all other IP literals are
  // not legitimate job destinations.  Rejecting the whole IP class also
  // avoids alternate numeric encodings reaching a browser.
  if (isIpv4(value) || value.includes(":") || /^[0-9.]+$/.test(value) || !/[a-z]/i.test(value)) return true;
  return false;
}

function parseHttpUrl(value) {
  const raw = String(value ?? "");
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    if (url.port && !((url.protocol === "https:" && url.port === "443") ||
        (url.protocol === "http:" && url.port === "80"))) return null;
    if (url.username || url.password || isSuspiciousHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function tenantKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/, 1)[0]
    .replace(/[^a-z0-9]+/g, "");
}

function pathSegments(url) {
  const rawPath = url.pathname || "/";
  // Encoded separators are a common way to hide a different tenant behind an
  // apparently valid ATS URL.  Reject them instead of normalising them.
  if (/%2f|%5c/i.test(rawPath)) return [];
  try {
    return decodeURIComponent(rawPath).split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function configuredTenant(portal) {
  const configured = String(portal?.company || "").trim();
  if (configured) return tenantKey(configured);
  try {
    return tenantKey(new URL(String(portal?.url || "")).pathname.split("/").filter(Boolean)[0] || "");
  } catch {
    return "";
  }
}

function queryHasUpstreamRedirect(url) {
  for (const [key, value] of url.searchParams.entries()) {
    if (!REDIRECT_QUERY_KEYS.has(key.toLowerCase())) continue;
    const candidate = String(value || "").trim();
    if (!candidate) continue;
    try {
      const target = new URL(candidate, url);
      if (!["http:", "https:"].includes(target.protocol)) return true;
      if (!hostMatches(target.hostname, url.hostname)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Validate a job URL against the portal that emitted it.
 *
 * The returned object is intentionally explicit so the caller can audit a
 * rejected row.  ATS URLs are checked twice: the host must be the host for the
 * configured engine, and the first path segment must be the configured tenant.
 * That prevents a valid-looking link for another company's board from being
 * persisted merely because the scraper found it on the configured page.
 */
function validateJobLink(value, portal = {}) {
  portal = portal || {};
  const rawLink = value && typeof value === "object" ? value.link : value;
  const url = parseHttpUrl(rawLink);
  if (!url) return { ok: false, reason: "not_an_absolute_public_http_url" };
  if (queryHasUpstreamRedirect(url)) return { ok: false, reason: "upstream_redirect_url" };

  const engine = String(portal.engine || "").trim().toLowerCase();
  const allowedHosts = ENGINE_ALLOWED_HOSTS[engine] || [];
  const host = canonicalHost(url.hostname);

  if (!allowedHosts.length && engine !== "generic") {
    return { ok: false, reason: "unknown_or_unallowlisted_engine" };
  }
  if (ATS_ENGINES.has(engine)) {
    if (url.protocol !== "https:") return { ok: false, reason: "ats_url_must_use_https" };
    // ATS allowlists are exact, rather than suffix-based.  A subdomain such as
    // attacker.boards.greenhouse.io must not inherit the official allowlist.
    if (!allowedHosts.includes(host)) {
      return { ok: false, reason: `host_not_allowed_for_${engine}` };
    }
    const expectedTenant = configuredTenant(portal);
    const [firstSegment] = pathSegments(url);
    if (!expectedTenant || !firstSegment || tenantKey(firstSegment) !== expectedTenant) {
      return { ok: false, reason: "cross_tenant_or_missing_ats_tenant" };
    }
  } else if (allowedHosts.length) {
    if (!allowedHosts.some((base) => hostMatches(host, base))) {
      return { ok: false, reason: `host_not_allowed_for_${engine}` };
    }
  } else if (isKnownAtsHost(host)) {
    // An unknown/generic portal must not silently turn an ATS URL into a
    // different engine's job.
    return { ok: false, reason: "ats_host_does_not_match_portal_engine" };
  }

  if (!ENGINE_ALLOWED_HOSTS[engine] && portal.url) {
    const origin = parseHttpUrl(portal.url);
    if (origin && canonicalHost(origin.hostname) !== host) {
      return { ok: false, reason: "url_origin_does_not_match_portal" };
    }
  }
  return { ok: true, url: url.href, reason: "" };
}

function isValidJobLink(value, portal = {}) {
  return validateJobLink(value, portal).ok;
}

// Descriptive alias for callers/tests that use URL rather than link wording.
const validateJobUrl = validateJobLink;

function validatePortalUrl(portal = {}) {
  portal = portal || {};
  const url = parseHttpUrl(portal.url);
  if (!url) return { ok: false, reason: "portal_url_not_absolute_public_http" };
  if (queryHasUpstreamRedirect(url)) return { ok: false, reason: "portal_url_has_upstream_redirect" };
  const engine = String(portal.engine || "").trim().toLowerCase();
  const allowedHosts = ENGINE_ALLOWED_HOSTS[engine] || [];
  const host = canonicalHost(url.hostname);
  if (!allowedHosts.length && engine !== "generic") {
    return { ok: false, reason: "unknown_or_unallowlisted_portal_engine" };
  }
  if (ATS_ENGINES.has(engine)) {
    if (url.protocol !== "https:") return { ok: false, reason: "ats_portal_must_use_https" };
    if (!allowedHosts.includes(host)) return { ok: false, reason: "ats_portal_host_not_allowed" };
    const tenant = configuredTenant(portal);
    const [firstSegment] = pathSegments(url);
    if (!tenant || !firstSegment || tenantKey(firstSegment) !== tenant) {
      return { ok: false, reason: "ats_portal_tenant_mismatch" };
    }
  } else if (allowedHosts.length && !allowedHosts.some((base) => hostMatches(host, base))) {
    return { ok: false, reason: "portal_host_not_allowed_for_engine" };
  }
  return { ok: true, reason: "" };
}

function jobKey(job) {
  const link = absoluteHttpUrl(job.link, "https://www.workatastartup.com/");
  if (link) {
    try {
      const url = new URL(link);
      const mockFragment = job.simulated ? url.hash : "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      return `link:${url.href}${mockFragment}`;
    } catch {
      return `link:${link}`;
    }
  }
  return `text:${String(job.title || "").trim().toLowerCase()}|${String(job.company || "").trim().toLowerCase()}`;
}

function attachSource(job, portal, simulated = MOCK) {
  const originalSource = String(job.source || portal.name || "Portal").trim() || "Portal";
  return {
    ...job,
    source: simulated ? simulatedSource(originalSource) : originalSource,
    source_name: portal.name,
    simulated: Boolean(simulated),
  };
}

function appendUniqueJobs(target, jobs, portal, rejected = []) {
  const seen = new Set(target.map((job) => jobKey(job)));
  let accepted = 0;
  for (const raw of jobs || []) {
    if (!raw || typeof raw !== "object") {
      rejected.push({ name: portal.name, url: "", reason: "job_not_an_object" });
      continue;
    }
    const validation = validateJobLink(raw.link, portal);
    if (!validation.ok) {
      rejected.push({
        name: portal.name,
        url: String(raw.link || ""),
        title: String(raw.title || ""),
        reason: validation.reason,
      });
      console.warn(`  [!] Rejected ${portal.name} job URL (${validation.reason})`);
      continue;
    }
    // Replace the raw value with the validated absolute URL.  This makes the
    // invariant explicit to every downstream persistence boundary.
    const job = attachSource({ ...raw, link: validation.url }, portal, MOCK);
    const key = jobKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(job);
    accepted += 1;
  }
  return accepted;
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
  const base = absoluteHttpUrl(portal.url, "https://example.invalid/");
  const mockLink = (suffix) => {
    if (portal.engine !== "yc") return `${base}${suffix}`;
    try {
      return new URL(`/jobs/${suffix}`, base).href;
    } catch {
      return base;
    }
  };
  const firstLink = portal.engine === "yc" ? mockLink("900000001") : base;
  const secondLink = portal.engine === "yc" ? mockLink("900000002") : `${base}#mock-2`;
  return [
    {
      title: `Backend Engineer Intern (${portal.engine})`,
      company: portal.company || portal.name,
      link: firstLink,
      description: `[Mock] Backend role sourced from ${portal.name} via the weekly portal scan. ` +
        "Java/Go/Python, REST APIs, PostgreSQL, Docker.",
      source: portal.name,
    },
    {
      title: `Software Engineer, New Grad (${portal.engine})`,
      company: portal.company || portal.name,
      link: secondLink,
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
      let link = "";
      if (linkEl) {
        try {
          const url = new URL(linkEl.getAttribute("href") || "", location.href);
          if (url.protocol === "http:" || url.protocol === "https:") link = url.href;
        } catch {}
      }
      return {
        title: (titleEl?.textContent || "").trim(),
        company,
        link,
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
        let link = "";
        if (titleEl) {
          try {
            const url = new URL(titleEl.getAttribute("href") || "", location.href);
            if (url.protocol === "http:" || url.protocol === "https:") link = url.href;
          } catch {}
        }
        return {
          title: (titleEl?.textContent || titleEl?.getAttribute("title") || "").trim(),
          company: (compEl?.textContent || "").trim() || "Unknown",
          link,
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

async function scrapeIndeed(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".job_seen_beacon, .tapItem, body", { timeout: 12000 }).catch(() => {});
  return page.$$eval(
    ".job_seen_beacon, .tapItem",
    (nodes, sourceName) =>
      nodes.map((el) => {
        const titleEl = el.querySelector("h2.jobTitle a, a.jcs-JobTitle, [data-jk] a");
        const compEl = el.querySelector('[data-testid="company-name"], .companyName');
        const locEl = el.querySelector('[data-testid="text-location"], .companyLocation');
        const href = titleEl?.getAttribute("href") || "";
        return {
          title: (titleEl?.textContent || "").trim(),
          company: (compEl?.textContent || "").trim() || "Unknown",
          link: href ? (href.startsWith("http") ? href : `https://in.indeed.com${href}`) : "",
          description: `Location: ${(locEl?.textContent || "").trim()}. Source: ${sourceName}.`,
        };
      }).filter((j) => j.title && j.link),
    portal.name
  );
}

async function scrapeGlassdoor(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('[data-test="jobListing"], .JobsList_jobListItem__JBBUV, body', { timeout: 12000 }).catch(() => {});
  return page.$$eval(
    '[data-test="jobListing"], .JobsList_jobListItem__JBBUV, li[data-test="jobListing"]',
    (nodes, sourceName) =>
      nodes.map((el) => {
        const a = el.querySelector('a[data-test="job-link"], a.JobCard_jobTitle__GLyJ1');
        const comp = el.querySelector('[data-test="employerName"], .EmployerProfile_compactEmployerName__LE242');
        return {
          title: (a?.textContent || "").trim(),
          company: (comp?.textContent || "").trim() || "Unknown",
          link: a ? (a.getAttribute("href")?.startsWith("http") ? a.getAttribute("href") : `https://www.glassdoor.co.in${a.getAttribute("href") || ""}`) : "",
          description: `Source: ${sourceName}.`,
        };
      }).filter((j) => j.title && j.link),
    portal.name
  );
}

async function scrapeJobHai(page, portal) {
  try {
    await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    if (e.message.includes("ERR_HTTP2")) {
      console.log(`  [JobHai] HTTP2 error, retrying http://`);
      await page.goto(portal.url.replace("https://", "http://"), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(()=>{});
    } else throw e;
  }
  await page.waitForSelector('.job-card, [class*="job"] , body', { timeout: 10000 }).catch(() => {});
  return page.$$eval(
    'a[href*="/job/"], a[href*="/jobs/"]',
    (nodes, sourceName) =>
      nodes.slice(0, 40).map((a) => ({
        title: (a.textContent || "").trim(),
        company: "Unknown",
        link: a.href,
        description: `Source: ${sourceName}.`,
      })).filter((j) => j.title && j.title.length > 4 && j.title.length < 120),
    portal.name
  );
}

async function scrapeYC(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('a[href*="/jobs/"] , body', { timeout: 12000 }).catch(() => {});
  return page.$$eval(
    'a[href*="/jobs/"], a[href^="jobs/"]',
    (nodes, sourceName) =>
      nodes.map((a) => {
        let link = "";
        try {
          const url = new URL(a.getAttribute("href") || "", location.origin);
          // Work at a Startup category/company pages are not application
          // listings.  Only numeric /jobs/<id> URLs are safe to emit.
          if (/^https?:\/\/(?:www\.)?workatastartup\.com\/jobs\/\d+(?:[/?#]|$)/i.test(url.href)) {
            link = url.href;
          }
        } catch {}
        return {
          title: (a.textContent || "").trim() || "Startup Role",
          company: "YC Startup",
          link,
          description: `Source: ${sourceName} (YC).`,
        };
      }).filter((j) => j.link && j.title && j.title.length > 4).slice(0, 80),
    portal.name
  );
}

const ENGINES = {
  greenhouse: scrapeGreenhouse,
  lever: scrapeLever,
  ashby: scrapeAshby,
  naukri: scrapeNaukri,
  wellfound: scrapeWellfound,
  indeed: scrapeIndeed,
  glassdoor: scrapeGlassdoor,
  jobhai: scrapeJobHai,
  yc: scrapeYC,
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const config = loadPortals() || {};
  const allPortals = normalizePortalEntries([
    ...(Array.isArray(config.search_portals) ? config.search_portals : []),
    ...(Array.isArray(config.ats_portals) ? config.ats_portals : []),
  ]);
  const settings = config.settings || {};
  const delayMs = (settings.delay_between_portals_seconds ?? 2) * 1000;
  const maxJobs = settings.max_jobs_per_portal ?? 40;

  const results = {
    jobs: [],
    skipped: [],
    failed: [],
    scanned_at: new Date().toISOString(),
    mock: MOCK,
    simulated: MOCK,
    source_prefix: SIMULATED_SOURCE_PREFIX,
  };

  if (MOCK) {
    console.log("[*] MOCK mode — zero network calls, zero browser launch.");
    for (const portal of allPortals) {
      if (!portal.enabled) continue;
      const portalCheck = validatePortalUrl(portal);
      if (!portalCheck.ok) {
        console.error(`  [!] Rejected portal ${portal.name}: ${portalCheck.reason}`);
        results.failed.push({ name: portal.name, url: portal.url, error: portalCheck.reason });
        continue;
      }
      if (isKnownDead(portal) || portalMatchesSkip(portal)) {
        results.skipped.push({ name: portal.name, url: portal.url, reason: "known_dead" });
        continue;
      }
      if (portal.requires_auth) {
        results.skipped.push({ name: portal.name, url: portal.url, reason: "requires_auth" });
        continue;
      }
      const jobs = mockJobsFor(portal);
      const accepted = appendUniqueJobs(results.jobs, jobs, portal, results.skipped);
      console.log(`  [Mock] ${portal.name}: ${accepted} job(s)`);
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
    console.log(`[+] Wrote ${results.jobs.length} mock jobs (${SIMULATED_SOURCE_PREFIX}*) → ${OUTPUT_PATH}`);
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

    const portalCheck = validatePortalUrl(portal);
    if (!portalCheck.ok) {
      console.error(`  [!] Rejected portal ${portal.name}: ${portalCheck.reason}`);
      results.failed.push({ name: portal.name, url: portal.url, error: portalCheck.reason });
      continue;
    }

    // Liveness/known-dead checks happen before selecting an engine or opening
    // a page.  Disabled JobHai/Indeed entries therefore cannot accidentally
    // become live work because of a stale duplicate config entry.
    if (isKnownDead(portal) || portalMatchesSkip(portal)) {
      console.log(`  [Skip] ${portal.name}: known/declared dead — no browser request`);
      results.skipped.push({ name: portal.name, url: portal.url, reason: "known_dead" });
      continue;
    }

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
      jobs = Array.isArray(jobs) ? jobs.slice(0, maxJobs) : [];
      const accepted = appendUniqueJobs(results.jobs, jobs, portal, results.skipped);
      console.log(`  [+] ${portal.name}: ${accepted} job(s)`);
    } catch (e) {
      console.error(`  [X] ${portal.name} failed: ${e.message}`);
      results.failed.push({ name: portal.name, url: portal.url, error: e.message });
    }

    await sleep(delayMs);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(
    `[+] Scan complete: ${results.jobs.length} job(s), ${results.skipped.length} skipped, ` +
    `${results.failed.length} failed → ${OUTPUT_PATH}`
  );
}

export { main, validateJobLink, validateJobUrl, isValidJobLink, validatePortalUrl, appendUniqueJobs };

// Keep the module importable for unit tests.  Only the CLI entry point starts
// Playwright or touches the configured portals.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("[Fatal] portal scan crashed:", e);
    // Always write *something* so main_weekly.py doesn't choke on a missing file —
    // same "never silent, never crash the caller" principle as linkedin_bridge.js.
    try {
      fs.writeFileSync(
        OUTPUT_PATH,
        JSON.stringify({
          jobs: [],
          skipped: [],
          failed: [{ name: "ALL", error: e.message }],
          scanned_at: new Date().toISOString(),
          mock: MOCK,
          simulated: MOCK,
          source_prefix: SIMULATED_SOURCE_PREFIX,
        }, null, 2)
      );
    } catch {}
    process.exit(1);
  });
}
