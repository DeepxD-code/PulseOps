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
  // Intentionally empty. A company board is not on a fixed list of hosts - the
  // employer is chosen per portal entry and the check that matters is that a
  // listing shares that employer's registrable domain (see validateJobLink).
  company: [],
  wellfound: ["wellfound.com", "angel.co"],
  indeed: ["indeed.com"],
  glassdoor: ["glassdoor.com", "glassdoor.co.in", "glassdoor.co.uk"],
  jobhai: ["jobhai.com"],
  hirist: ["hirist.com", "www.hirist.com", "hirist.tech"],
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
// Suffixes where the registrable domain is the last three labels rather than
// the last two. Without these, careers.example.co.in and careers.example.com
// would look like different employers, and a seeded co.in board would silently
// drop every co.in listing.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "ac.in", "gov.in", "edu.in",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "gov.za",
  "com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.tr", "com.cn", "com.tw",
  "co.jp", "ne.jp", "or.jp", "co.kr", "co.il", "com.my", "com.ph", "com.vn", "com.pk",
  "com.eg", "com.sa", "com.ua", "com.pl", "co.id", "co.th",
]);

/**
 * The registrable domain ("example.co.in", "example.com") of a hostname.
 *
 * The company engine seeds from one careers URL and may only emit links on the
 * same employer's domain, which is a registrable-domain test rather than the
 * exact-host allowlist the ATS engines use. A fixed allowlist is impossible
 * here because the whole point is employers whose career pages are not on a
 * known ATS.
 */
function registrableDomain(host) {
  const labels = canonicalHost(host).split(".").filter(Boolean);
  if (labels.length < 2) return canonicalHost(host);
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function sameEmployerDomain(a, b) {
  const left = parseHttpUrl(a);
  const right = parseHttpUrl(b);
  if (!left || !right) return false;
  return registrableDomain(left.hostname) === registrableDomain(right.hostname);
}

function validateJobLink(value, portal = {}) {
  portal = portal || {};
  const rawLink = value && typeof value === "object" ? value.link : value;
  const url = parseHttpUrl(rawLink);
  if (!url) return { ok: false, reason: "not_an_absolute_public_http_url" };
  if (queryHasUpstreamRedirect(url)) return { ok: false, reason: "upstream_redirect_url" };

  const engine = String(portal.engine || "").trim().toLowerCase();
  const allowedHosts = ENGINE_ALLOWED_HOSTS[engine] || [];
  const host = canonicalHost(url.hostname);

  if (!allowedHosts.length && engine !== "generic" && engine !== "company") {
    return { ok: false, reason: "unknown_or_unallowlisted_engine" };
  }
  if (engine === "company") {
    // Arbitrary employer domains, so the check that matters is that a listing
    // belongs to the employer that was seeded - not that it is on some list.
    // A crawler that followed a link off the seeded domain would be reading
    // somebody else's board and filing it as this employer's role.
    if (url.protocol !== "https:") return { ok: false, reason: "company_url_must_use_https" };
    if (!portal.url || !sameEmployerDomain(url, portal.url)) {
      return { ok: false, reason: "off_employer_domain" };
    }
    return { ok: true, url: url.href, reason: "" };
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

// Engines whose listings are only visible to a logged-in session, mapped to the
// saved state. Absent file means the portal cannot be scanned, and that is
// reported rather than silently producing zero jobs.
const PORTAL_SESSION_FILES = {
  naukri: path.join(ROOT, "portal", "naukri-storageState.json"),
};

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
  // NOT `networkidle`. Wellfound keeps long-lived analytics connections open
  // (rddrstck.wellfound.com / Segment), so the network never goes idle and
  // `networkidle` reliably hit its timeout - which surfaced as
  // "failed: Wellfound India" in the scan summary, i.e. the portal was
  // reported broken when the listing markup was fine.
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Listings are client-rendered. Wait for a real listing link, not a fixed sleep.
  await page.waitForSelector(
    "a[href*='/jobs/']:not([href*='/jobs/applications']):not([href*='/jobs/messages'])",
    { timeout: 25000 },
  ).catch(() => {});
  await page.waitForTimeout(2500);
  // Scroll a little so the first pages of the feed render.
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(1200);
  }

  return page.$$eval(
    "a[href*='/jobs/']",
    (nodes, sourceName) => {
      // The nav carries /jobs/applications, /jobs/messages, /jobs/starved,
      // /jobs/hidden and the bare /jobs index. Matching them turned the nav bar
      // into five fake jobs titled "Applied", "Messages", "Browse all".
      const NAV = /\/jobs\/(applications|messages|starred|hidden|home)?$/;
      // A real listing is /jobs/<numeric id>-<slug>.
      const LISTING = /^\/jobs\/(\d+)-([a-z0-9][a-z0-9-]*)$/i;
      const out = [];
      const seen = new Set();
      for (const a of nodes) {
        const href = a.getAttribute("href") || "";
        const m = LISTING.exec(href);
        if (NAV.test(href) || !m) continue;
        const url = new URL(href, location.origin);
        url.search = "";
        if (seen.has(url.href)) continue;

        // The title comes from the slug, not the card text. The rendered card
        // concatenates its own chrome with the role - "Forward Deployed Engineer
        // recently activePosted 7 days agoicn_repost" - and stripping that with
        // regexes left fragments like "Senior Java Backend EngineerIn officeChennai
        // L - 35L". The slug is the same title, clean and deterministic:
        //   /jobs/4777702-senior-java-backend-engineer
        const title = m[2]
          .replace(/-+/g, " ")
          .replace(/\b\w/g, (ch) => ch.toUpperCase())
          .trim();
        if (title.length < 5) continue;

        // The card text still earns its keep as the description: it is where the
        // salary band lives, and a stated salary under the floor is a skip
        // reason rather than something to re-derive from the slug.
        const card = (a.textContent || "").replace(/\s+/g, " ").trim();
        const salary = card.match(/[₹$€£]\s?[\d,.]+\s*(?:[kK]|[Ll])?\s*(?:[-–—]\s?[₹$€£]?\s?[\d,.]+\s*(?:[kK]|[Ll])?)?/);
        const workMode = /\b(remote only|remote|in office|hybrid|onsite)\b/i.exec(card);

        seen.add(url.href);
        out.push({
          title: title.slice(0, 118),
          company: "Unknown",
          link: url.href,
          description: [
            salary ? `Salary shown: ${salary[0]}` : "Salary: not stated",
            workMode ? `Work mode: ${workMode[1]}` : "",
            `Source: ${sourceName}.`,
            card ? `Card text: ${card.slice(0, 200)}` : "",
          ].filter(Boolean).join(" "),
        });
      }
      return out;
    },
    portal.name,
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

async function scrapeInstahyre(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Listing URLs are /job-<id>-<slug> at the site root, not under /job/.
  await page.waitForSelector("a[href*='/job-']", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 2; i += 1) {
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(1400);
  }

  return page.$$eval(
    "a[href*='/job-']",
    (nodes, sourceName) => {
      const out = [];
      const seen = new Set();
      for (const a of nodes) {
        const raw = a.getAttribute("href") || "";
        if (!raw) continue;
        const url = new URL(raw, location.origin);
        // Instahyre emits ABSOLUTE hrefs
        // ("https://www.instahyre.com/job-444500-..."), so the shape has to be
        // tested against the parsed path, not the raw attribute. Anchoring the
        // pattern on the raw href matched nothing and the portal returned 0.
        const m = /^\/job-(\d+)-/.exec(url.pathname);
        if (!m) continue;
        url.search = "";
        if (seen.has(url.href)) continue;

        // The card reads "Bolt - IT Engineer Job available in Work From Home".
        // Split on the first separator for company and title; the rest is
        // location/salary boilerplate, kept as context rather than discarded.
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        const cut = text.split(/\s+[-–]\s+/);
        const company = (cut[0] || "").trim();
        const title = (cut[1] || "").replace(/\s*(?:Job available in|Apply now).*$/i, "").trim();
        if (title.length < 4) continue;

        seen.add(url.href);
        out.push({
          title: title.slice(0, 118),
          company: company || "Unknown",
          link: url.href,
          description: `Listing ${m[1]}. ${text.slice(0, 240)}. Source: ${sourceName}.`,
        });
      }
      return out.slice(0, 40);
    },
    portal.name,
  );
}

async function scrapeHirist(page, portal) {
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Listings are client-rendered; wait for a real one before scrolling.
  await page.waitForSelector("a[href*='/j/']", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1400);
  }

  return page.$$eval(
    "a[href*='/j/']",
    (nodes, sourceName) => {
      const out = [];
      const seen = new Set();
      for (const a of nodes) {
        const raw = a.getAttribute("href") || "";
        // /j/<company>-<title>-<numeric id>?ref=...&jobPos=N
        if (!/\/j\/.+-\d+/.test(raw)) continue;
        const url = new URL(raw, location.origin);
        url.search = "";
        if (seen.has(url.href)) continue;

        // The card reads "Vedantu Innovations - Product Engineer - Java2 - 5 yrs
        // BangaloreJavaSpring..." - company first, then the role, then
        // experience/location/skills glued on. Split on the first separators
        // rather than trusting the slug, whose company segment has no reliable
        // boundary ("vedantu-innovations-product-engineer-java").
        const raw_text = (a.textContent || "").replace(/\s+/g, " ").trim();
        const parts = raw_text.split(/\s+[-–]\s+/);
        const company = (parts[0] || "").trim();
        const title = (parts[1] || "").trim();
        if (title.length < 4) continue;

        seen.add(url.href);
        out.push({
          title: title.slice(0, 118),
          company: company || "Unknown",
          link: url.href,
          description: `Location/experience/skills: ${raw_text.slice(company.length + title.length + 4, 260).trim()}. Source: ${sourceName}.`,
        });
      }
      return out.slice(0, 40);
    },
    portal.name,
  );
}

async function scrapeJobHai(page, portal) {
  // No http:// downgrade. The old ERR_HTTP2 fallback silently retried over an
  // insecure scheme on a 30s timeout and could not have worked anyway: the
  // transport failure is the server refusing a connection that carries another
  // portal's history, which is handled once per portal by a fresh context plus
  // one retry in the caller.
  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('a[href*="-job-in-"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // Job Hai listing URLs are a single slug, not a path segment:
  //   /it-software-data-analyst-software-developer-application-developer-job-in-nexus-engiconsults-private-limited-sector-6-noida-0-to-2-years-1790838504-8...
  // so `a[href*="/job/"]` - the selector this used - cannot match any listing
  // on the site, and the portal reported success while extracting nothing.
  return page.$$eval(
    "a[href*='-job-in-']",
    (nodes, sourceName) => {
      const out = [];
      const seen = new Set();
      for (const a of nodes) {
        const raw = a.getAttribute("href") || "";
        const slug = raw.replace(/^\/+/, "").replace(/\.html?$/i, "");
        // Require the real listing shape so nav and category links stay out.
        if (!raw || slug.indexOf("-job-in-") <= 0) continue;
        const url = new URL(raw, location.origin);
        if (seen.has(url.href)) continue;
        // The anchor's own text is the clean role name ("IT Professional").
        // Deriving it from the slug instead produced "data analyst it
        // professional" - the slug leads with a department - and taking the
        // company from the slug's first token after the marker produced "A"
        // and "The" from "a-s-pharma-private-limited". The page already knows
        // both; the company is left to the evaluator rather than guessed.
        const title = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (title.length < 4 || title.length > 140) continue;
        seen.add(url.href);
        out.push({
          title,
          company: "Unknown",
          link: url.href,
          description: `Source: ${sourceName}.`,
        });
      }
      return out.slice(0, 40);
    },
    portal.name,
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

/**
 * Read robots.txt and report whether a path is crawlable.
 *
 * The company engine is the only one that visits pages nobody nominated by name,
 * so it is the only one where "am I allowed to read this?" has to be answered
 * from the site's own rules rather than from a known API. A missing or
 * unreachable robots.txt is treated as permitted, which is the documented
 * default; a fetch that fails for any other reason also falls open rather than
 * silently dropping a whole employer's board.
 */
async function robotsAllows(context, origin, pathname) {
  const rules = [];
  let applicable = false;
  try {
    const res = await context.request.get(`${origin}/robots.txt`, { timeout: 12000 });
    if (!res.ok()) return { allowed: true, checked: false, note: `robots_http_${res.status()}` };
    const body = await res.text();
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = String(rawKey || "").trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") applicable = true;
      else if (applicable && (key === "disallow" || key === "allow")) {
        rules.push({ allow: key === "allow", path: value });
      }
    }
  } catch (err) {
    return { allowed: true, checked: false, note: "robots_unreachable" };
  }
  if (!rules.length) return { allowed: true, checked: true, note: "no_rules" };

  // Longest matching pattern wins, per the robots.txt convention.
  let best = null;
  for (const rule of rules) {
    if (!rule.path) continue;
    if (pathname.startsWith(rule.path) || pathname === rule.path) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }
  return { allowed: !best || best.allow, checked: true, note: best ? `matched_${best.allow ? "allow" : "disallow"}` : "no_match" };
}

/**
 * Crawl one employer's own career pages.
 *
 * Scoped as tightly as the task allows, because unlike every other engine this
 * one has no API and no known URL shape:
 *
 *   - one hop from the seeded page only, so it reads a board and its listings
 *     and nothing beyond them
 *   - the employer's own registrable domain only; a link off it is not followed
 *   - robots.txt decides, per path
 *   - links must look like a job listing by path or by link text, so a nav bar
 *     of 40 links does not become 40 requests
 *   - hard page cap, and a pause between requests
 */
async function collectCompanyLinks(page, pageUrl, domain, roleWord, seenHref, jobish) {
  const out = [];
  const base = `${parseHttpUrl(pageUrl).protocol}//${parseHttpUrl(pageUrl).host}`;
  let links = [];
  try {
    links = await page.$$eval("a[href]", (nodes, origin) => {
      const acc = [];
      for (const a of nodes) {
        const href = a.getAttribute("href") || "";
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length < 6 || text.length > 160) continue;
        if (/^(apply|apply now|view all|see all|search|filter|sort|next|back|home|more|all jobs|back to)/i.test(text)) continue;
        let abs = "";
        try { abs = new URL(href, origin).href; } catch { continue; }
        if (!/^https?:/i.test(abs)) continue;
        acc.push({ href: abs, text });
      }
      return acc;
    }, base);
  } catch {
    return out;
  }
  for (const link of links) {
    let url = null;
    try { url = new URL(link.href); } catch { continue; }
    if (url.protocol !== "https:") continue;
    if (registrableDomain(url.hostname) !== domain) continue;
    url.hash = "";
    url.search = "";
    const href = url.href;
    if (href === pageUrl || seenHref.has(href)) continue;
    if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|csv|jpg|jpeg|png|gif|svg|webp|mp4|ico)(?:[/?#]|$)/i.test(url.pathname)) continue;
    if (!jobish.test(url.pathname) && !roleWord.test(link.text)) continue;
    seenHref.add(href);
    out.push({ href, text: link.text });
  }
  return out;
}

async function scrapeCompany(page, portal) {
  const seed = parseHttpUrl(portal.url);
  if (!seed) return [];
  const origin = `${seed.protocol}//${seed.host}`;
  const domain = registrableDomain(seed.hostname);
  const context = page.context();

  await page.goto(portal.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1200);
  // Listings are often client-rendered; give the page a moment to fill in.
  for (let i = 0; i < 2; i += 1) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1200);
  }

  const links = await page.$$eval("a[href]", (nodes, base) => {
    const out = [];
    for (const a of nodes) {
      const href = a.getAttribute("href") || "";
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < 6 || text.length > 160) continue;
      if (/^(apply|apply now|view all|see all|search|filter|sort|next|back|home|more|all jobs|back to)/i.test(text)) continue;
      let abs = "";
      try { abs = new URL(href, base).href; } catch { continue; }
      if (!/^https?:/i.test(abs)) continue;
      out.push({ href: abs, text });
    }
    return out;
  }, `${origin}/`);
  const seenHref = new Set();

  // Word-boundary, not slash-boundary. Adobe's category pages are /us/en/c/engineering-and-product-jobs
  // and Freshworks' are /company/careers/open-positions - the noun is glued to the slug with a hyphen,
  // so requiring a leading slash matched none of them and the crawler reported 0 candidates from 135 links.
  const jobish = /(?:^|[/_-])(?:job|jobs|career|careers|position|positions|vacanc(?:y|ies)|opening|openings|role|roles)(?:[/_-]|$)|[?&](?:jobid|jid)=|\.(?:aspx?|jsp)\b/i;
  // A role word in the link text. This is only a cheap PRE-filter: it decides
  // what is worth requesting, never what is a job. Trusting it as the final
  // answer produced a Zoho product page - nav text reading "For Developers"
  // matched, and the destination was "Mobile Device Management (MDM), made easy".
  // What a page IS has to be decided on the page, not on the label that led to it.
  const roleWord = /\b(?:engineer|developer|scientist|manager|analyst|architect|intern|designer|specialist|consultant|programmer|researcher|backend|frontend|full[-\s]?stack|devops|ml\s*\/?\s*ai)\b/i;

  const candidates = [];
  for (const link of links) {
    let url = null;
    try { url = new URL(link.href); } catch { continue; }
    if (url.protocol !== "https:") continue;
    if (registrableDomain(url.hostname) !== domain) continue;
    // The seed is the board, not a role on it. Re-listing it produces a job
    // whose title is the careers page's own headline.
    url.hash = "";
    url.search = "";
    const href = url.href;
    if (seenHref.has(href)) continue;
    if (href === canonicalUrl(portal.url) || href === `${origin}${seed.pathname}`) continue;
    // A document, not a page. Product and PDF links live on the same nav bar.
    if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|csv|jpg|jpeg|png|gif|svg|webp|mp4|ico)(?:[/?#]|$)/i.test(url.pathname)) continue;
    if (!jobish.test(url.pathname) && !roleWord.test(link.text)) continue;
    seenHref.add(href);
    candidates.push({ href, text: link.text });
  }
  console.log(`  [company] ${domain}: ${candidates.length} candidate link(s) from ${links.length} link(s) on the board`);

  const maxPages = Math.min(Number(portal.max_pages) || 20, 60);
  const maxDepth = Math.min(Number(portal.max_depth) || 2, 3);
  const pause = Math.max(Number(portal.delay_ms) || 1200, 600);
  const sourceName = portal.name || domain;
  const jobs = [];
  const emitted = new Set();
  let robotsBlocked = 0;
  let visited = 0;

  // A careers page usually links to a category page, which links to the roles.
  // Reading only the seed found nothing on a site laid out that way - Hasura
  // yielded 62 links and 0 candidates, because the roles sit two levels down.
  // So a page that turns out to be an index is harvested rather than emitted,
  // up to a depth, still on the employer's own domain and still under robots.
  const queue = candidates.slice(0, maxPages).map((c) => ({ ...c, depth: 1 }));

  while (queue.length && visited < maxPages) {
    const candidate = queue.shift();
    if (visited >= maxPages) break;
    let url = null;
    try { url = new URL(candidate.href); } catch { continue; }
    const verdict = await robotsAllows(context, origin, url.pathname);
    if (!verdict.allowed) { robotsBlocked += 1; continue; }
    if (visited) await sleep(pause);
    visited += 1;
    try {
      await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(700);
      const job = await page.evaluate(() => {
        const pick = (sel, attr) => {
          const el = document.querySelector(sel);
          if (!el) return "";
          return String((attr ? el.getAttribute(attr) : el.textContent) || "").replace(/\s+/g, " ").trim();
        };
        const body = (document.body && document.body.innerText) || "";
        const flat = body.replace(/\s+/g, " ").trim();
        // Signals that a page is one specific vacancy rather than marketing
        // copy or a category index. Checked here, on the page, because the
        // link that led here says nothing reliable about what is here.
        const applyish = Array.from(document.querySelectorAll("a[href], button"))
          .map((n) => String(n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
          .filter((t) => /^(apply|apply now|apply for this|submit application|apply for this job|view job|see job)/.test(t));
        const requisition = /\b(?:req(?:uisition)?|job\s*(?:id|no|number|ref)|reference)\s*(?:id|no\.?|number|#)?\s*[:#-]?\s*[a-z0-9-]{3,}/i;
        return {
          title: pick("h1") || pick('meta[property="og:title"]', "content") || "",
          description: pick('meta[name="description"]', "content") || body.slice(0, 1200),
          bodyLength: flat.length,
          hasApply: applyish.length > 0,
          hasReqId: requisition.test(flat.slice(0, 1500)),
          // A category page lists several roles; a vacancy describes one.
          headingCount: document.querySelectorAll("h1, h2").length,
          ogType: pick('meta[property="og:type"]', "content"),
        };
      });
      // A page with almost no text is a shell that never rendered, not a role.
      if (!job.title || job.title.length < 5 || job.bodyLength < 200) continue;
      // The destination has to look like a vacancy. Without this the crawler
      // happily returned a product page whose nav happened to say "Developers".
      // Classify by what the page LINKS TO, not by reading its slug.
      //
      // A category page points at several roles; a vacancy points at almost
      // nothing beyond its apply button. Counting same-domain role links
      // separates the two without guessing whether "engineering-and-product-jobs"
      // names a team or a vacancy - which is the guess that filed Freshworks'
      // careers landing page as a role titled "We're here to uncomplicate work".
      const roleLinks = await page.evaluate((base) => {
        let n = 0;
        for (const a of document.querySelectorAll("a[href]")) {
          let abs = "";
          try { abs = new URL(a.getAttribute("href") || "", base).href; } catch { continue; }
          if (abs === base) continue;
          if (/\/(?:job|jobs|career|careers|position|positions|vacanc(?:y|ies)|opening|openings|role|roles)(?:[/_-]|[/?#]|$)/i.test(abs)) n += 1;
        }
        return n;
      }, `${origin}/`);

      if (roleLinks >= 3) {
        // An index of roles, whatever its slug says. The roles are one level in.
        if (candidate.depth < maxDepth) {
          const nested = await collectCompanyLinks(page, candidate.href, domain, roleWord, seenHref, jobish);
          for (const n of nested) queue.push({ ...n, depth: candidate.depth + 1 });
        }
        continue;
      }
      // A single vacancy describes one role and carries an apply affordance.
      const hasApplyAffordance = job.hasApply || job.hasReqId || jobish.test(url.pathname);
      // AND its title names the role. This is the check that matters, because
      // every category page also carries an "Apply" link and a job-shaped URL:
      //   "Design"                            /us/en/c/design-jobs
      //   "Engineering and Product"           /us/en/c/engineering-and-product-jobs
      //   "We're here to uncomplicate work"   /company/careers/
      //   "Adobe Newsroom"                    news.adobe.com/home/default.aspx
      // None of those name a vacancy. A real posting's title does - "Software
      // Engineer, Platform" - and that is the cheapest honest test available
      // without a per-employer template.
      const titleNamesTheRole = roleWord.test(job.title);
      if (!(hasApplyAffordance && (titleNamesTheRole || job.hasReqId))) continue;
      // A page carrying many headings is marketing, not a vacancy.
      if (job.headingCount > 25) continue;
      // A board's own title, not a vacancy's. "We're here to uncomplicate work"
      // is the careers page's headline, and it is never the role.
      if (/^(?:we(?:'re| are)\s|join us|our (?:team|mission|story)|careers?|open (?:positions|roles)|life at)\b/i.test(job.title)) continue;
      if (emitted.has(candidate.href)) continue;
      emitted.add(candidate.href);
      jobs.push({
        title: job.title.slice(0, 160),
        company: candidate.company || "",
        link: candidate.href,
        description: `Source: ${sourceName} (company site). ${String(job.description || "").slice(0, 400)}`,
      });
    } catch (err) {
      // One unreachable listing must not end the employer's whole board.
      continue;
    }
  }

  if (robotsBlocked) {
    console.log(`  [robots] ${robotsBlocked} page(s) skipped on ${domain} - disallowed by robots.txt`);
  }
  console.log(`  [company] ${domain}: ${jobs.length} listing(s) from ${visited} page(s) read, ${candidates.length} candidate link(s)`);
  return jobs;
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
  hirist: scrapeHirist,
  instahyre: scrapeInstahyre,
  yc: scrapeYC,
  company: scrapeCompany,
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
    // Some portals only list their openings to a logged-in session. Naukri sends
    // an OTP to the candidate's phone and has no password login, so the session
    // is captured once by portal/save_naukri_session.mjs and replayed here.
    // Scraping it logged out yields nothing, which is why it read as
    // auth-skipped rather than as a configuration problem.
    const sessionFile = PORTAL_SESSION_FILES[portal.engine];
    const useSession = sessionFile && fs.existsSync(sessionFile);
    // EVERY portal now gets its own context, not just the authenticated ones.
    // Sharing one long-lived page was the reason Job Hai "gave trouble":
    // measured 2026-10-01, a fresh browser loaded it 4 times out of 4, while
    // the same URL on a page reused across the portal loop succeeded 1 time in
    // 8 - almost every failure was
    //   page.goto: net::ERR_HTTP2_PROTOCOL_ERROR
    // which is how the server refuses a connection carrying another portal's
    // history, not a protocol flag problem. --disable-http2 and --disable-quic
    // were both tested and changed nothing.
    let portalContext = await browser.newContext({
      userAgent: pickUserAgent(),
      viewport: { width: 1366, height: 900 },
      ...(useSession ? { storageState: sessionFile } : {}),
    });
    let portalPage = await portalContext.newPage();
    portalPage.setDefaultTimeout(settings.page_timeout_ms ?? 30000);
    if (sessionFile && !useSession) {
      console.log(`  [!] ${portal.name}: no saved session at ${path.basename(sessionFile)} — run portal/save_naukri_session.mjs`);
      results.skipped.push({ name: portal.name, url: portal.url, reason: "no_saved_session" });
      await portalContext.close().catch(() => {});
      await sleep(delayMs);
      continue;
    }
    try {
      let jobs;
      // One retry on a transport failure. These boards drop connections often
      // enough that a single attempt turns a working portal into a "failed"
      // line in the summary.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          if (portal.engine === "ashby") {
            jobs = await engineFn(portalPage, portal, portalContext.request);
          } else {
            jobs = await engineFn(portalPage, portal);
          }
          break;
        } catch (e) {
          const transient = /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|Protocol error/i.test(String(e?.message || ""));
          if (!transient || attempt === 2) throw e;
          console.log(`  [retry] ${portal.name}: ${/ERR_[A-Z_]+/.exec(String(e.message))?.[1] || "transport error"} — new page, one more try`);
          await portalPage.close().catch(() => {});
          portalPage = await portalContext.newPage();
          portalPage.setDefaultTimeout(settings.page_timeout_ms ?? 30000);
          await sleep(1200);
        }
      }
      jobs = Array.isArray(jobs) ? jobs.slice(0, maxJobs) : [];
      const accepted = appendUniqueJobs(results.jobs, jobs, portal, results.skipped);
      console.log(`  [+] ${portal.name}: ${accepted} job(s)${useSession ? " (authenticated)" : ""}`);
    } catch (e) {
      console.error(`  [X] ${portal.name} failed: ${e.message}`);
      results.failed.push({ name: portal.name, url: portal.url, error: e.message });
    } finally {
      await portalContext.close().catch(() => {});
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

export {
  main,
  validateJobLink,
  validateJobUrl,
  isValidJobLink,
  validatePortalUrl,
  appendUniqueJobs,
  registrableDomain,
  sameEmployerDomain,
  scrapeCompany,
};

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
