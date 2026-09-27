#!/usr/bin/env node
/**
 * portal/apply.mjs — Browser auto-apply engine (open-source Strawberry alternative)
 *
 * Uses Playwright (already in dependencies) to open job links, detect the
 * ATS/engine, fill the form with config/profile.yml + uploaded resume PDF,
 * and leaves final submission to the operator unless --auto is explicit.
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
 *   node portal/apply.mjs --live                 Fill/preview; final submit requires --auto
 *   node portal/apply.mjs --live --auto          Allow final application actions
 *   node portal/apply.mjs --headed               Show browser window (for debugging / CAPTCHA)
 *
 * Safety:
 *   - Default is --dry-run (fill + screenshot, no click Submit)
 *   - --live without --auto fills and previews only; final Send/Submit is manual
 *   - --live --auto is required before any final application action is clicked
 *   - No credentials are stored — uses your existing logged-in session if you run headed
 *     or a pre-saved storageState.json (see docs below)
 *   - CAPTCHA is a hard stop until the challenge disappears
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { basicHtmlTextFromHtml, statedSalaryTooLow } from "./salary.mjs";
import { BASIC_HTML, detectBasicHtml } from "./page-probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * Read the rendered page as text, falling back to stylesheet-free HTML when the
 * DOM is empty. Only used once a browser already exists.
 */
async function readPageText(page) {
  if (!page || typeof page.evaluate !== "function") return "";
  const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ")).catch(() => "");
  if (text && text.trim().length > 80) return text;
  let html = "";
  try { html = await page.content(); } catch { html = ""; }
  const basic = basicHtmlTextFromHtml(html).replace(/\s+/g, " ");
  if (basic && basic.trim().length > 80) return basic;
  return text && text.trim() ? text : "";
}

/**
 * Classify a job page with a plain HTTP fetch, before any browser exists.
 * Basic server-rendered pages are read straight from that HTML; only styled or
 * script-driven pages are worth a full browser.
 */
async function probeJobPage(url) {
  let html = "";
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        // Identify honestly; some career pages reject a bare browser UA.
        "User-Agent": "Mozilla/5.0 (compatible; PulseOpsJobBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      return { mode: "unavailable", reason: `HTTP ${response.status}`, basic: false, text: "", html: "" };
    }
    html = await response.text();
  } catch (error) {
    return { mode: "unavailable", reason: String(error).slice(0, 80), basic: false, text: "", html: "" };
  }
  return { ...detectBasicHtml(html), html };
}

/**
 * Skip a posting that states a salary under the floor. A role with no stated
 * pay is never skipped for this reason. Uses the cheap probe when available so
 * an unstyled page never needs a browser at all.
 */
async function rejectLowStatedSalary(page, job, probe = null) {
  let text = probe && probe.basic ? probe.text : "";
  if (!text) {
    text = await readPageText(page);
  }
  if (!text) return null;
  const { skip, monthly } = statedSalaryTooLow(`${job.title || ""} ${text}`);
  if (!skip) return null;
  const shown = Math.round(monthly).toLocaleString("en-IN");
  console.log(`  [salary] stated Rs ${shown}/month is under the Rs 10,000 floor — not applying`);
  return { action: "salary-below-threshold", monthly };
}

const DRY_RUN = !process.argv.includes("--live");
const HEADED = process.argv.includes("--headed");
// Operator-supplied SMS verification. Never automated: the human types the code
// they received on their own phone.
const ENTER_OTP = process.argv.includes("--enter-otp");
// Headed runs can simply pause and let the operator finish in the browser.
const OTP_PAUSE = process.argv.includes("--otp-pause");
// Operator-authorised acceptance of a portal's terms/privacy checkbox. Never on
// by default: it is a legal agreement, so it is an explicit, logged act.
const ACCEPT_TERMS = process.argv.includes("--accept-terms");
const OTP_PAUSE_MS = (() => {
  const parsed = Number.parseInt(process.env.PULSEOPS_OTP_PAUSE_MS || "240000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240000;
})();
const AUTO = process.argv.includes("--auto");
const LOAD_EMAIL_QUEUE = process.argv.includes("--email-queue");
const INCLUDE_INDEED = process.argv.includes("--include-indeed");
const EDGE = process.argv.includes("--edge"); // real Edge persistent profile (beats Cloudflare)
let sharedCtx = null;
const MOCK_ONLY = process.argv.includes("--mock");
const JOB_URL_FLAG = process.argv.find((a) => a.startsWith("--job-url="));
const JOB_ID_FLAG = process.argv.find((a) => a.startsWith("--job-id="));
const SINGLE_URL = JOB_URL_FLAG
  ? JOB_URL_FLAG.slice("--job-url=".length)
  : (process.argv.includes("--job-url") ? process.argv[process.argv.indexOf("--job-url") + 1] : null);
const SINGLE_JOB_ID = JOB_ID_FLAG
  ? JOB_ID_FLAG.slice("--job-id=".length)
  : (process.argv.includes("--job-id") ? process.argv[process.argv.indexOf("--job-id") + 1] : null);
const FLAG_CONFLICT = !!SINGLE_URL && !!SINGLE_JOB_ID;

// These markers are intentionally durable DB values, not an in-memory flag. The
// daily/weekly writers should prefix both fields for --simulate runs (see the
// cross-file patch in the handoff). Legacy `Mock` rows are also recognised so
// old simulation data cannot be selected by a live browser run.
const SIMULATION_SOURCE_PREFIX = "sim:";
const SIMULATION_RUN_PREFIX = "sim-";
const SIMULATION_MARKER_RE = /^(?:mock|sim(?:ulated|ulation)?|fixture|sample|test|demo)(?:[:/_-]|$)/i;
const EXCLUDED_STATUSES = new Set([
  "applied", "sent", "followupsent", "expired", "skipped", "verified",
  "needsreview", "needsverification", "applying", "simulated", "sendpaused", "emailqueued",
  "blacklisted", "referral", "cooldown",
]);
const PENDING_REVIEW_STATUSES = new Set([
  "needs_review", "review_pending", "pending_review", "review_posted",
]);
const OUTREACH_BLOCKED_STATUSES = new Set([
  "sent", "simulated", "cooldown", "referral", "blacklisted", "bounced",
  "followup_sent", "followupsent", "needs_review", "needsreview",
  "review_pending", "reviewpending", "pending_review", "pendingreview", "review_posted", "reviewposted",
]);

// These are service hosts, not trust suffixes.  A tenant such as
// `acme.lever.co` is eligible only when it is the original hostname for the
// job; it must never inherit trust from every other *.lever.co host.
const ATS_ALLOWED_HOSTS = Object.freeze({
  greenhouse: ["greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io"],
  lever: ["lever.co", "jobs.lever.co"],
  ashby: ["ashbyhq.com", "jobs.ashbyhq.com"],
  workday: ["myworkdayjobs.com", "workday.com"],
  smartrecruiters: ["smartrecruiters.com", "jobs.smartrecruiters.com", "careers.smartrecruiters.com"],
  naukri: ["naukri.com", "www.naukri.com", "in.naukri.com"],
  wellfound: ["wellfound.com", "www.wellfound.com", "angel.co", "www.angel.co"],
  linkedin: ["linkedin.com", "www.linkedin.com"],
  indeed: ["indeed.com", "www.indeed.com"],
  glassdoor: ["glassdoor.com", "www.glassdoor.com", "glassdoor.co.in", "glassdoor.co.uk"],
  jobhai: ["jobhai.com", "www.jobhai.com"],
  yc: ["workatastartup.com", "www.workatastartup.com", "ycombinator.com", "www.ycombinator.com"],
  generic: [],
});
const ATS_SERVICE_HOSTS = ATS_ALLOWED_HOSTS;
// On these ATS the job page's "Apply" control only *opens* the application form
// (a modal or embedded panel). Treating it as the final submission fills the
// fields after the "submit" and never actually applies.
const APPLY_IS_ALWAYS_INTERMEDIATE = new Set(["greenhouse", "lever", "ashby"]);
const STRICT_ROLE_EXCLUDES = [
  "full stack", "full-stack", "fullstack", "frontend", "front-end",
  "laravel", "wordpress", "react", "angular", "vue", "mobile", "android",
  "ios", "embedded", "firmware", "hardware",
  // The Node/JS web stack is outside the candidate's language set even when
  // the title also says "backend".
  "node.js", "nodejs", "node js", "next.js", "nuxt", "express.js",
  "javascript", "java script", "typescript",
  // Data stores and frameworks the candidate does not work with.
  "mongo", "mongodb", "django",
  // Design roles are not software engineering roles.
  "ui/ux", "ui ux", "ux/ui", "ui designer", "ux designer", "product designer",
  "graphic design", "product design", "web design", "figma",
  "interaction design", "visual design", "brand design",
];
const STRICT_ROLE_ALLOWED = /\b(?:backend|back[\s-]end|ml|artificial[\s-]+intelligence|ai|ai[\s/-]*ml|genai|generative[\s-]+ai|llm\w*|nlp|computer[\s-]+vision|deep[\s-]+learning|java|python)\b|machine[\s-]+learning|reinforcement[\s-]+learning|\bc\b|c\+\+|c\s*\/\s*c\+\+/i;

function isStrictTargetRole(title) {
  const value = String(title || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return false;
  if (STRICT_ROLE_EXCLUDES.some((marker) => value.includes(marker))) return false;
  return STRICT_ROLE_ALLOWED.test(value);
}

// LinkedIn serves its first-party page bundle from an exact CDN hostname.
// Allow only passive asset resource types from these hosts; XHR/fetch/form
// requests remain blocked by the origin guard below.
const ATS_ASSET_HOSTS = Object.freeze({
  linkedin: ["static.licdn.com", "media.licdn.com"],
});
const ASSET_RESOURCE_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "other"]);
const ATS_TRUSTED_REQUEST_HOSTS = Object.freeze({
  linkedin: [
    { host: "platform.linkedin.com", pathPrefix: "/litms/", types: ["xhr", "fetch", "script"] },
    { host: "static.licdn.com", pathPrefix: "/aero-v1/sc/h/", types: ["xhr", "fetch", "script", "stylesheet", "image", "font", "media", "other"] },
    { host: "media.licdn.com", pathPrefix: "/dms/", types: ["xhr", "fetch", "image"] },
  ],
});
const CLAIM_RECOVERY_MS = (() => {
  const parsed = Number.parseInt(process.env.PULSEOPS_BROWSER_CLAIM_RECOVERY_MS || "3600000", 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : 3600000;
})();

const CAPTCHA_SELECTORS = [
  'iframe[src*="captcha"]',
  'iframe[src*="challenges.cloudflare"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="turnstile"]',
  '[data-testid="captcha"]',
  ".cf-challenge",
  ".cf-turnstile",
  "[class*='captcha' i]",
];
const CAPTCHA_WAIT_MS = (() => {
  const parsed = Number.parseInt(process.env.PULSEOPS_CAPTCHA_WAIT_MS || "180000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180000;
})();
const HUMAN_FINAL_STATUSES = new Set(["yc", "wellfound", "naukri", "indeed", "linkedin"]);

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    // Browser-apply handles resumes and other PII.  A URL is not an
    // eligible navigation target unless its transport is HTTPS; accepting
    // HTTP here would let the rest of the flow accidentally open or submit
    // over plaintext (including the same-origin case).
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function canonicalHost(host) {
  // Do not strip `www.` here.  It is a distinct hostname for trust purposes;
  // callers that need a display/domain alias can normalize it explicitly.
  return String(host || "").toLowerCase().replace(/\.$/, "");
}

function serviceHostsForAts(ats) {
  return ATS_SERVICE_HOSTS[ats] || ATS_SERVICE_HOSTS.generic || [];
}

function hasExactServiceHost(ats, hostname) {
  const host = canonicalHost(hostname);
  return serviceHostsForAts(ats).some((allowed) => host === canonicalHost(allowed));
}

function originOf(value) {
  const url = parseHttpUrl(value);
  return url ? url.origin : null;
}

function sameOrigin(left, right) {
  const a = originOf(left);
  const b = originOf(right);
  return !!a && !!b && a === b;
}

function createNavigationBoundary(initialUrl, ats = "generic") {
  const parsed = parseHttpUrl(initialUrl);
  return {
    ats: ats || "generic",
    initialOrigin: parsed?.origin || null,
    initialHost: parsed ? canonicalHost(parsed.hostname) : "",
    pinnedOrigin: null,
  };
}

function isNavigationBoundary(value) {
  return !!value && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, "initialOrigin")
    && Object.prototype.hasOwnProperty.call(value, "pinnedOrigin");
}

function navigationPinnedOrigin(boundary) {
  if (!isNavigationBoundary(boundary)) return null;
  return boundary.pinnedOrigin || boundary.initialOrigin;
}

function pinNavigationOrigin(boundary, value) {
  if (!isNavigationBoundary(boundary)) return false;
  const candidate = parseHttpUrl(value);
  if (!candidate || !isAllowedNavigationUrl(candidate, boundary.ats, boundary)) return false;
  boundary.pinnedOrigin = candidate.origin;
  return true;
}

function isAllowedNavigationUrl(value, ats = "generic", originUrl = null) {
  const url = parseHttpUrl(value);
  // Keep this check explicit even though parseHttpUrl is HTTPS-only.  It
  // protects callers that pass a URL-like object and documents that HTTP is
  // never a valid same-origin escape hatch for a PII-bearing flow.
  if (!url || url.protocol !== "https:") return false;
  const effectiveAts = isNavigationBoundary(originUrl) ? originUrl.ats : (ats || "generic");

  // Once a job has crossed to an approved service host/origin, pin all later
  // navigation to that exact origin.  A redirect chain cannot bounce through
  // another approved host and then back to an untrusted tenant.
  if (isNavigationBoundary(originUrl)) {
    // An invalid/insecure initial URL creates an invalid boundary.  Do not
    // treat it as an absent origin and accidentally authorize a fresh host.
    if (!originUrl.initialOrigin) return false;
    if (originUrl.pinnedOrigin) {
      return sameOrigin(url, originUrl.pinnedOrigin);
    }
    if (sameOrigin(url, originUrl.initialOrigin)) return true;
    // Service hosts are exact, explicitly listed hosts and are HTTPS-only.
    // They are not suffix matches and do not authorize sibling tenants. A
    // non-standard port is an origin boundary, not a host alias.
    const initial = parseHttpUrl(originUrl.initialOrigin);
    if (!initial || initial.port || initial.protocol !== "https:") return false;
    return url.protocol === "https:" && !url.port && hasExactServiceHost(effectiveAts, url.hostname);
  }

  // A supplied raw origin is part of the policy input, not an optional hint.
  // In particular, http://host must fail closed rather than falling through
  // to the no-origin ATS allowlist below.
  if (originUrl !== null && originUrl !== undefined) {
    const origin = parseHttpUrl(originUrl);
    if (!origin) return false;
    if (sameOrigin(url, origin)) return true;
    if (effectiveAts === "generic" || origin.port || origin.protocol !== "https:") return false;
    return url.protocol === "https:" && !url.port && hasExactServiceHost(effectiveAts, url.hostname);
  }

  // With no job origin (for example a pure URL-policy unit check), ATS
  // service hosts are still exact; generic has no implicit allowlist.
  return effectiveAts !== "generic"
    && url.protocol === "https:"
    && !url.port
    && hasExactServiceHost(effectiveAts, url.hostname);
}

function isCurrentPageTrusted(value, ats = "generic", originUrl = null) {
  if (!isAllowedNavigationUrl(value, ats, originUrl)) return false;
  if (!isNavigationBoundary(originUrl)) return true;
  return sameOrigin(value, navigationPinnedOrigin(originUrl));
}

function isSimulationJob(job) {
  const source = String(job?.source || "").trim();
  const runId = String(job?.run_id || job?.run_marker || job?.runMarker || job?.runId || "").trim();
  return SIMULATION_MARKER_RE.test(source) || SIMULATION_MARKER_RE.test(runId)
    || source.toLowerCase().startsWith(SIMULATION_SOURCE_PREFIX)
    || runId.toLowerCase().startsWith(SIMULATION_RUN_PREFIX);
}

function isTrustworthySource(source) {
  const value = String(source || "").trim();
  if (!value || isSimulationJob({ source: value })) return false;
  return !/^(?:mock|sim(?:ulation)?|fixture|sample|test|demo|manual|unknown|untrusted|queue|fallback|email|portal|scraper)(?:[:/_ -]|$)/i.test(value);
}

function isTerminalStatus(status) {
  const normalized = String(status || "").trim().toLowerCase().replace(/[ _-]/g, "");
  return EXCLUDED_STATUSES.has(normalized) || /pending.*(?:review|g10)|g10.*review|review.*pending/.test(normalized);
}

function finalSubmissionAllowed({ dryRun = DRY_RUN, auto = AUTO, sendPaused, dbAvailable, claimOwned } = {}) {
  if (dryRun || !auto) return false;
  const paused = sendPaused === null || sendPaused === true || ["1", "true", "yes", "on"].includes(String(sendPaused || "").toLowerCase());
  if (paused || dbAvailable === false || dbAvailable === null || claimOwned === false) return false;
  return true;
}

function finalActionLabel(label) {
  return /\b(?:submit|send|save|apply\s*(?:now|application)|confirm|finish|done|yes|okay)\b/i.test(String(label || ""));
}

function intermediateActionLabel(label) {
  return /^(?:continue|review(?:\s+your\s+application)?|next)(?:\s|$)/i.test(String(label || "").trim());
}

// Many job pages reuse `button[type="submit"]` for search, filters, paging, and
// cookie consent. Those submit the *page*, not an application, so a
// submission-intent label is required before any final click is allowed.
const NON_SUBMISSION_CONTROL_LABEL =
  /\b(?:search|find|filter|sort|refine|login|log\s?in|sign\s?in|sign\s?up|sign\s?out|register|subscribe|newsletter|save\s?search|save\s?job|show\s?more|load\s?more|next\s?page|prev|previous|go\s?back|back|close|cancel|dismiss|clear|reset|accept|agree|consent|allow|choose|upload|attach|add|remove|edit|delete|share|print|copy|bookmark|notify|set\s?alert|apply\s?filters|update)\b/i;

function isSubmissionControlLabel(label) {
  const text = String(label || "").trim();
  if (!text) return false;
  if (NON_SUBMISSION_CONTROL_LABEL.test(text)) return false;
  if (finalActionLabel(text)) return true;
  return /\bapply\b/i.test(text);
}

// jobs.ashbyhq.com/<company> is a company board, not an application listing.
// A real Ashby listing carries a job-scoped path segment.
function isAshbyJobListing(url) {
  try {
    const segments = new URL(String(url || "")).pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

// boards.greenhouse.io/<company> is a company board too; a real listing always
// carries a /jobs/<id> segment.
function isGreenhouseJobListing(url) {
  try {
    return /\/jobs\/\d+(?:[/?#]|$)/i.test(new URL(String(url || "")).pathname);
  } catch {
    return false;
  }
}

// jobs.lever.co/<company> is a Lever board; a real posting adds a role segment.
function isLeverJobListing(url) {
  try {
    const segments = new URL(String(url || "")).pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

// wellfound.com/<country>/role/<...> is a search page. A real posting lives
// under /jobs/<id>-<slug>.
function isWellfoundJobListing(url) {
  try {
    return /\/jobs\/\d+/i.test(new URL(String(url || "")).pathname);
  } catch {
    return false;
  }
}

// Naukri search/category pages (…-jobs-in-bangalore…?experience=0) list many
// roles. A real posting ends in a numeric job id, e.g. /job-backend-dev-1234567
// or /job-detail-1234567.
function isNaukriJobListing(url) {
  try {
    const segments = new URL(String(url || "")).pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";
    return /\d{4,}$/.test(last);
  } catch {
    return false;
  }
}

// A "#mock-N" style fragment marks a simulated row that must never be applied
// to. The whole fragment must be the marker so real anchors like
// "#testimonials" are not mistaken for one.
function hasSimulationFragment(url) {
  const raw = String(url || "");
  const index = raw.indexOf("#");
  if (index < 0) return false;
  const hash = raw.slice(index + 1).trim();
  return /^(?:mock|sim\w*|fake|fixture|demo|test)(?:[-_].*)?$/i.test(hash);
}

// Distinguish "closed", "already applied", and "apply on the company site" from
// a genuinely missing control, so the run records an accurate outcome instead
// of a blanket NeedsReview.
async function classifyMissingApplyState(page) {
  if (!page || typeof page.evaluate !== "function") return "no-apply-control";
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    if (/no longer accepting applications|this job is no longer|job (has )?expired|position (has been )?filled|no longer available/i.test(text)) {
      return "closed-listing";
    }
    if (/apply on (?:the )?(?:company|employer)|apply on company website|external apply|go to (?:the )?(?:company|employer)(?:'s)? website|responses managed off linkedin/i.test(text)) {
      return "external-apply";
    }
    if (/\byou applied\b|application submitted|applied successfully|already applied/i.test(text)) {
      return "already-applied";
    }
    return "no-apply-control";
  }).catch(() => "no-apply-control");
}

/**
 * Classify an Apply-looking control before touching it.  Plain `Apply` is
 * usually a modal/flow trigger, but on a one-step form it is the final action.
 * Callers must fail closed for `unknown`; raw clicks are reserved for
 * `intermediate` controls.
 */
function classifyApplyControl(input = {}) {
  const control = typeof input === "string" ? { label: input } : (input || {});
  const {
    label = "",
    href = null,
    selector = "",
    oneStep = false,
    hasFormFields = oneStep,
    hasVisibleForm = oneStep,
    isFinal = false,
    isSubmit = false,
  } = control;
  const text = `${label || selector || ""}`.trim();
  const explicitFinal = isFinal || finalActionLabel(text);
  const oneStepForm = !!(oneStep || hasFormFields || hasVisibleForm);
  const applyLike = /\bapply\b/i.test(text);
  const final = !!(explicitFinal || isSubmit || (applyLike && oneStepForm));
  if (final) return { classification: "final", final: true, intermediate: false, safeToClick: true };
  const hrefText = String(href || "").trim().toLowerCase();
  const opaqueHref = /^(?:javascript|data|blob):/.test(hrefText);
  if (applyLike && opaqueHref && !oneStepForm
      && !/easy\s*apply|open\s*application|start\s*application|modal/i.test(text)) {
    return { classification: "unknown", final: false, intermediate: false, safeToClick: false };
  }
  if (applyLike || /easy\s*apply|open\s*application|start\s*application/i.test(text)) {
    return { classification: "intermediate", final: false, intermediate: true, safeToClick: true };
  }
  if (intermediateActionLabel(text)) {
    return { classification: "intermediate", final: false, intermediate: true, safeToClick: true };
  }
  // An href is not evidence that the control is safe: an unknown control can
  // still have a JavaScript submit handler.
  return { classification: "unknown", final: false, intermediate: false, safeToClick: false };
}

function isFinalApplyControl(input = {}) {
  return classifyApplyControl(input).final;
}
const classifyApplyAction = classifyApplyControl;

async function pageHasOneStepApplicationForm(page) {
  if (!page || typeof page.evaluate !== "function") return false;
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const forms = [...document.querySelectorAll("form")].filter(visible);
    const form = forms.find((candidate) => candidate.querySelector(
      'button[type="submit"], input[type="submit"], button:not([type="button"])'
    )) || forms[0];
    const scope = form || document;
    const fields = [...scope.querySelectorAll("input, textarea, select")].filter(visible)
      .filter((el) => !/hidden|submit|button/i.test(`${el.type || ""} ${el.getAttribute("name") || ""}`));
    if (!fields.length) return false;
    const submit = form
      ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"])')
      : [...document.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type="button"])')].find(visible);
    const hasSubmit = !!submit;
    const applicationFields = fields.filter((el) => /name|email|phone|resume|cv|cover|file|tel/i.test(
      `${el.getAttribute("name") || ""} ${el.getAttribute("type") || ""} ${el.getAttribute("placeholder") || ""} ${el.id || ""}`,
    ));
    // Name+phone-only application forms are final too. Requiring a resume,
    // email, or textarea misclassified those controls as intermediate Apply.
    return hasSubmit && applicationFields.length >= 1;
  }).catch(() => false);
}

function resolveDbPath(env = process.env, root = ROOT) {
  const configured = String(env.PULSEOPS_DB || "").trim();
  if (configured) {
    const candidates = [
      path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured),
      path.isAbsolute(configured) ? configured : path.resolve(root, configured),
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
    // An explicit PULSEOPS_DB is authoritative even before the file exists;
    // never silently fall back to another database because of a typo/mount.
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || null;
  }
  return [
    path.join(root, "pulseops.db"),
    path.join(root, ".state", "pulseops.db"),
  ].find((candidate) => fs.existsSync(candidate)) || null;
}

function isExistingDbPath(dbPath) {
  if (!dbPath) return false;
  try { return fs.statSync(dbPath).isFile(); } catch { return false; }
}

function getAuthoritativeDbPath(env = process.env, root = ROOT) {
  const configured = String(env.PULSEOPS_DB || "").trim();
  const candidate = resolveDbPath(env, root);
  if (configured) return isExistingDbPath(candidate) ? candidate : null;
  return isExistingDbPath(candidate) ? candidate : null;
}

function runSqliteJson(dbPath, pythonCode, args = [], timeout = 5000) {
  if (!isExistingDbPath(dbPath)) return null;
  try {
    const out = execFileSync("python", ["-c", pythonCode, ...args], {
      encoding: "utf-8",
      timeout,
      windowsHide: true,
      shell: false,
    });
    const line = String(out || "").trim().split(/\r?\n/).pop();
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

// All SQLite helper code is fixed and receives values as argv, never as shell
// text. The helpers stay synchronous internally so the final-action guard can
// re-read the authoritative state immediately before a click.
async function readSendPause(dbPath = resolveDbPath(), { env = process.env } = {}) {
  const resolvedPath = dbPath || resolveDbPath(env);
  if (!isExistingDbPath(resolvedPath)) {
    return { available: false, paused: true, reason: "db-missing" };
  }
  const pythonCode = String.raw`
import json, os, sqlite3, sys
path = sys.argv[1]
result = {"available": False, "paused": True, "reason": "db-unavailable"}
try:
    if not os.path.isfile(path):
        raise RuntimeError("db-missing")
    conn = sqlite3.connect(path, timeout=2)
    conn.execute("PRAGMA busy_timeout=2000")
    tables = {str(r[0]) for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "settings" not in tables:
        result["reason"] = "settings-unavailable"
    else:
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(settings)")}
        if not {"key", "value"}.issubset(cols):
            result["reason"] = "settings-schema-unavailable"
        else:
            row = conn.execute("SELECT value FROM settings WHERE key=?", ("send_paused",)).fetchone()
            if row is None:
                # The store's documented default is active when the key has
                # never been written; an absent settings table/schema remains
                # unavailable and fails closed.
                result = {"available": True, "paused": False, "reason": "default-active"}
            else:
                raw = str(row[0] if row[0] is not None else "").strip().lower()
                if raw in {"1", "true", "yes", "on"}:
                    result = {"available": True, "paused": True, "reason": "paused"}
                elif raw in {"0", "false", "no", "off", ""}:
                    result = {"available": True, "paused": False, "reason": "active"}
                else:
                    result["reason"] = "send-paused-setting-invalid"
    conn.close()
except Exception:
    pass
print(json.dumps(result))
`;
  const result = runSqliteJson(resolvedPath, pythonCode, [resolvedPath], 3000);
  return result && typeof result.available === "boolean"
    ? result
    : { available: false, paused: true, reason: "pause-query-failed" };
}

async function readFinalActionState(dbPath = resolveDbPath(), jobId = null, ownerToken = null) {
  const pause = await readSendPause(dbPath);
  if (!pause.available) return { ...pause, claimOwned: false, reason: pause.reason };
  if (jobId === null || jobId === undefined || jobId === "") {
    return { ...pause, claimOwned: null, reason: pause.reason };
  }
  if (!isExistingDbPath(dbPath)) {
    return { available: false, paused: true, claimOwned: false, reason: "db-missing" };
  }
  const pythonCode = String.raw`
import json, os, sqlite3, sys
path, raw_id, owner = sys.argv[1], sys.argv[2], sys.argv[3]
result = {"available": False, "paused": True, "claimOwned": False, "reason": "claim-query-failed"}
try:
    job_id = int(raw_id)
    if not os.path.isfile(path):
        raise RuntimeError("db-missing")
    conn = sqlite3.connect(path, timeout=2)
    conn.execute("PRAGMA busy_timeout=2000")
    tables = {str(r[0]) for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "settings" not in tables or "jobs" not in tables:
        result["reason"] = "db-schema-unavailable"
    else:
        settings_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(settings)")}
        job_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(jobs)")}
        if not {"key", "value"}.issubset(settings_cols) or not {"id", "status", "processed_at"}.issubset(job_cols):
            result["reason"] = "db-schema-unavailable"
        else:
            setting = conn.execute("SELECT value FROM settings WHERE key=?", ("send_paused",)).fetchone()
            if setting is None:
                raw = "0"
            else:
                raw = str(setting[0] if setting[0] is not None else "").strip().lower()
            if raw not in {"0", "false", "no", "off", ""} and raw not in {"1", "true", "yes", "on"}:
                result["reason"] = "send-paused-setting-invalid"
            else:
                paused = raw in {"1", "true", "yes", "on"}
                row = conn.execute("SELECT status, processed_at FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row is None:
                    result["reason"] = "job-not-found"
                else:
                    status = str(row[0] or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")
                    marker = str(row[1] or "")
                    marker_owner = marker.rsplit("|", 1)[1] if "|" in marker else ""
                    outreach_blocked = False
                    if "outreach" in tables:
                        outreach_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(outreach)")}
                        predicates = []
                        if "status" in outreach_cols:
                            # Terminal states only: a pending G10 review gates the
                            # email channel, not a browser application.
                            predicates.append("LOWER(COALESCE(status,'')) IN ('sent','simulated','cooldown','referral','blacklisted','bounced','followup_sent','followupsent')")
                        if "channel" in outreach_cols:
                            predicates.append("LOWER(COALESCE(channel,''))='referral'")
                        if "notes" in outreach_cols:
                            predicates.append("LOWER(COALESCE(notes,'')) LIKE '%g4:%' OR LOWER(COALESCE(notes,'')) LIKE '%g5:%' OR LOWER(COALESCE(notes,'')) LIKE '%cooldown%'")
                        if predicates and "job_id" in outreach_cols:
                            # Strictly this listing; a company-wide scope let one
                            # outreach block every other role at that company.
                            scope = ["job_id=?"]
                            scope_params = [job_id]
                            outreach_blocked = conn.execute(
                                "SELECT 1 FROM outreach WHERE (" + " OR ".join(scope) + ") AND (" +
                                " OR ".join(predicates) + ") LIMIT 1",
                                scope_params,
                            ).fetchone() is not None
                    owned = status == "applying" and bool(owner) and marker_owner == owner and not outreach_blocked
                    result = {
                        "available": True,
                        "paused": paused,
                        "claimOwned": owned,
                        "reason": "paused" if paused else ("g10-review" if outreach_blocked else ("owned" if owned else "claim-lost")),
                    }
    conn.close()
except Exception:
    pass
print(json.dumps(result))
`;
  const result = runSqliteJson(dbPath, pythonCode, [dbPath, String(jobId), String(ownerToken || "")], 3000);
  return result && typeof result.available === "boolean"
    ? { ...result, claimOwned: result.claimOwned === true }
    : { available: false, paused: true, claimOwned: false, reason: "claim-query-failed" };
}

async function claimJobForApply(jobId, {
  dbPath = resolveDbPath(),
  ownerId = randomUUID(),
  recoveryMs = CLAIM_RECOVERY_MS,
  now = Date.now(),
  allowRecovery = false,
} = {}) {
  const id = Number(jobId);
  if (!/^\d+$/.test(String(jobId ?? "")) || !Number.isSafeInteger(id) || id <= 0) {
    return { claimed: false, available: false, reason: "invalid-id", owner: ownerId };
  }
  if (!isExistingDbPath(dbPath)) {
    return { claimed: false, available: false, reason: "db-missing", owner: ownerId };
  }
  const owner = String(ownerId || "").trim();
  if (!owner || owner.length > 160) {
    return { claimed: false, available: false, reason: "invalid-owner", owner: ownerId };
  }
  const pythonCode = String.raw`
import datetime, json, os, re, sqlite3, sys
path, raw_id, owner, raw_now, raw_recovery, raw_allow_recovery = sys.argv[1:7]
owner = str(owner)
result = {"claimed": False, "available": False, "reason": "claim-query-failed", "owner": owner}
conn = None
try:
    job_id = int(raw_id)
    now = float(raw_now) / 1000.0
    recovery = max(60.0, float(raw_recovery) / 1000.0)
    allow_recovery = str(raw_allow_recovery) == "1"
    if not os.path.isfile(path):
        raise RuntimeError("db-missing")
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("BEGIN IMMEDIATE")
    tables = {str(r[0]) for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    settings_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(settings)")} if "settings" in tables else set()
    job_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(jobs)")} if "jobs" in tables else set()
    if not {"key", "value"}.issubset(settings_cols) or not {"id", "status", "score", "link", "processed_at"}.issubset(job_cols):
        result["reason"] = "db-schema-unavailable"
    else:
        setting = conn.execute("SELECT value FROM settings WHERE key=?", ("send_paused",)).fetchone()
        if setting is None:
            raw_pause = "0"
        else:
            raw_pause = str(setting[0] if setting[0] is not None else "").strip().lower()
        if raw_pause in {"1", "true", "yes", "on"}:
            result["reason"] = "paused"
        elif raw_pause not in {"0", "false", "no", "off", ""}:
            result["reason"] = "send-paused-setting-invalid"
        else:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                result["reason"] = "job-not-found"
            else:
                status = str(row["status"] or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")
                protected = {"applied", "sent", "followupsent", "verified", "expired", "skipped", "needsreview", "needsverification", "simulated", "sendpaused", "emailqueued", "blacklisted", "referral", "cooldown", "replied", "phone_screen", "technical", "final", "offer", "accepted", "rejected"}
                marker = str(row["processed_at"] or "")
                recovering = status == "applying"
                stale_marker = None
                result["reason"] = "pending"
                link = str(row["link"] or "").strip().lower()
                if not link.startswith("https://"):
                    result["reason"] = "invalid-link"
                elif recovering:
                    marker_owner = marker.rsplit("|", 1)[1] if "|" in marker else ""
                    marker_time = marker.split("|", 2)[1] if marker.count("|") >= 2 else ""
                    if marker_owner == owner:
                        result = {"claimed": True, "available": True, "reason": "already-owned", "owner": owner, "recovered": False}
                    else:
                        try:
                            stamp = datetime.datetime.fromisoformat(marker_time.replace("Z", "+00:00")).timestamp()
                            age = now - stamp
                        except Exception:
                            try:
                                stamp = float(marker_time)
                                age = now - stamp
                            except Exception:
                                stamp = 0
                                age = 0
                        if not marker or age < recovery:
                            result["reason"] = "already-applying"
                        elif not allow_recovery:
                            result["reason"] = "stale-applying-review-required"
                        else:
                            stale_marker = marker
                if not result.get("claimed") and result["reason"] == "pending":
                    try:
                        score = float(row["score"])
                    except Exception:
                        score = -1
                    source = str(row["source"] or "") if "source" in job_cols else ""
                    run_id = str(row["run_id"] or "") if "run_id" in job_cols else ""
                    run_marker = str(row["run_marker"] or "") if "run_marker" in job_cols else ""
                    sim_re = re.compile(r"^(?:mock|sim(?:ulated|ulation)?|fixture|sample|test|demo)(?:[:/_-]|$)", re.I)
                    outreach_blocked = False
                    if "outreach" in tables:
                        oc = {str(r[1]) for r in conn.execute("PRAGMA table_info(outreach)")}
                        if "job_id" in oc:
                            predicates = []
                            if "status" in oc:
                                # Only states where this listing is genuinely
                                # finished block a browser claim. A pending G10
                                # review means "awaiting a human decision about
                                # emailing"; it is not evidence the application
                                # was already made, and it must not stop us from
                                # applying to an open role.
                                predicates.append("LOWER(COALESCE(status,'')) IN ('sent','simulated','cooldown','referral','blacklisted','bounced','followup_sent','followupsent')")
                            if "channel" in oc:
                                predicates.append("LOWER(COALESCE(channel,''))='referral'")
                            if "notes" in oc:
                                predicates.append("LOWER(COALESCE(notes,'')) LIKE '%g4:%' OR LOWER(COALESCE(notes,'')) LIKE '%g5:%' OR LOWER(COALESCE(notes,'')) LIKE '%cooldown%'")
                            if predicates:
                                # Scope strictly to this listing: a company-wide
                                # match let one outreach block every other role.
                                scope = ["job_id=?"]
                                scope_params = [job_id]
                                outreach_blocked = conn.execute("SELECT 1 FROM outreach WHERE (" + " OR ".join(scope) + ") AND (" + " OR ".join(predicates) + ") LIMIT 1", scope_params).fetchone() is not None
                    if status in protected:
                        result["reason"] = "protected-status"
                    elif "source" in job_cols and not str(row["source"] or "").strip():
                        result["reason"] = "source-untrusted"
                    elif status not in {"evaluated", "applying"}:
                        result["reason"] = "status-not-evaluable"
                    elif score < 75:
                        result["reason"] = "score-too-low"
                    elif sim_re.search(source) or sim_re.search(run_id) or sim_re.search(run_marker):
                        result["reason"] = "simulation-row"
                    elif outreach_blocked:
                        result["reason"] = "g10-review"
                    else:
                        stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                        new_marker = "browser-apply-claim|" + stamp + "|" + owner
                        if stale_marker is not None:
                            cur = conn.execute("UPDATE jobs SET status='Applying', processed_at=? WHERE id=? AND LOWER(COALESCE(status,''))='applying' AND processed_at=?", (new_marker, job_id, stale_marker))
                        else:
                            cur = conn.execute("UPDATE jobs SET status='Applying', processed_at=? WHERE id=? AND LOWER(COALESCE(status,''))='evaluated'", (new_marker, job_id))
                        result = {"claimed": cur.rowcount == 1, "available": True, "reason": "claimed" if cur.rowcount == 1 else "claim-race-lost", "owner": owner, "recovered": bool(stale_marker is not None and cur.rowcount == 1), "marker": new_marker}
    conn.commit()
except Exception:
    if conn is not None:
        try:
            conn.rollback()
        except Exception:
            pass
print(json.dumps(result))
`;
  const result = runSqliteJson(
    dbPath,
    pythonCode,
    [dbPath, String(id), owner, String(now), String(recoveryMs), allowRecovery ? "1" : "0"],
    7000,
  );
  return result || { claimed: false, available: false, reason: "claim-query-failed", owner };
}

const recoverJobClaim = (jobId, options = {}) =>
  claimJobForApply(jobId, { ...options, allowRecovery: true });

async function verifyJobClaim(jobId, ownerToken, dbPath = resolveDbPath()) {
  const state = await readFinalActionState(dbPath, jobId, ownerToken);
  return {
    owned: state.available && !state.paused && state.claimOwned === true,
    available: state.available,
    paused: state.paused,
    reason: state.reason,
  };
}

async function manualUrlDatabaseGuard({ dbPath = null, dryRun = DRY_RUN } = {}) {
  const authoritative = getAuthoritativeDbPath();
  // An explicitly supplied path is authoritative even when it is missing;
  // never fall back to the default DB and accidentally bypass the pause.
  const selected = dbPath ? dbPath : authoritative;
  if (!selected) {
    return { allowed: !!dryRun, available: false, paused: true, dbPath: null, reason: "db-missing" };
  }
  const state = await readSendPause(selected);
  return {
    allowed: state.available && !state.paused,
    available: state.available,
    paused: state.paused,
    dbPath: selected,
    reason: state.reason,
  };
}

const DB_PATH = resolveDbPath();

function loadBlacklistEntries() {
  const candidates = [path.join(ROOT, "config", "blacklist.txt")];
  const entries = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      for (const line of fs.readFileSync(candidate, "utf-8").split(/\r?\n/)) {
        const value = line.trim().toLowerCase();
        if (value && !value.startsWith("#")) entries.push(value);
      }
    } catch {}
  }
  return [...new Set(entries)];
}

function loadReferralContacts() {
  const candidate = path.join(ROOT, "config", "contacts.yml");
  try {
    if (!fs.existsSync(candidate)) return [];
    const parsed = yaml.load(fs.readFileSync(candidate, "utf-8")) || {};
    return Array.isArray(parsed.contacts) ? parsed.contacts : [];
  } catch {
    return [];
  }
}

function normaliseCompany(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function jobDomain(job) {
  const explicit = String(job?.inferred_domain || job?.domain || "").trim().toLowerCase();
  if (explicit) return explicit.replace(/^www\./, "");
  try { return canonicalHost(new URL(job?.link || job?.url || "").hostname); } catch { return ""; }
}

function isBlacklistedJob(job, blacklist = loadBlacklistEntries()) {
  const company = String(job?.company || "").toLowerCase();
  const domain = jobDomain(job);
  return blacklist.some((entry) => {
    const needle = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!needle) return false;
    return company.includes(needle) || domain.includes(needle)
      || (!!normaliseCompany(needle) && normaliseCompany(company).includes(normaliseCompany(needle)));
  });
}

function hasReferralContact(job) {
  const company = normaliseCompany(job?.company);
  const domain = jobDomain(job);
  return loadReferralContacts().some((contact) => {
    const contactCompany = normaliseCompany(contact?.company);
    const contactDomain = String(contact?.domain || "").toLowerCase().replace(/^www\./, "");
    return (!!company && !!contactCompany && company === contactCompany)
      || (!!domain && !!contactDomain && (domain === contactDomain || domain.endsWith(`.${contactDomain}`)));
  });
}

function isBlockedOutreachJob(job) {
  const pendingFlag = job?._pending_g10_review ?? job?.pending_g10_review;
  const pending = pendingFlag === true || pendingFlag === 1
    || ["1", "true", "yes"].includes(String(pendingFlag || "").toLowerCase())
    || PENDING_REVIEW_STATUSES.has(String(job?._review_status || "").toLowerCase());
  if (pending) return true;
  const rawStatuses = job?._outreach_statuses ?? job?.outreach_statuses ?? job?.outreach_status ?? [];
  const rawChannels = job?._outreach_channels ?? job?.outreach_channels ?? job?.outreach_channel ?? [];
  const statuses = Array.isArray(rawStatuses) ? rawStatuses : String(rawStatuses || "").split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  const channels = Array.isArray(rawChannels) ? rawChannels : [rawChannels].filter(Boolean);
  const rawNotes = job?._outreach_notes ?? job?.outreach_notes ?? job?.notes ?? "";
  const notes = Array.isArray(rawNotes) ? rawNotes.join(" ") : String(rawNotes || "");
  const rowNotes = [job?.reason, job?.notes, job?.blocked_reason, job?.text_summary]
    .filter(Boolean).join(" ");
  return statuses.some((status) => OUTREACH_BLOCKED_STATUSES.has(String(status).toLowerCase()))
    || channels.some((channel) => /referral/i.test(String(channel)))
    || /G4:|G5:|referral|cooldown|blacklist|pending G10|needs review/i.test(`${notes} ${rowNotes}`);
}

function isEligibleJob(job, { includeIndeed = INCLUDE_INDEED, explicit = false } = {}) {
  const status = String(job?.status || "").trim().toLowerCase();
  const link = job?.link || job?.url || "";
  if (!link || !isAllowedInitialJobUrl(link)) return false;
  if (!isStrictTargetRole(job?.title)) return false;
  if (status !== "evaluated") return false;
  if (!Number.isFinite(Number(job?.score)) || Number(job.score) < 75) return false;

  const pauseValue = job?._send_paused;
  if (job?._send_pause_available === false || job?._db_pause_available === false) return false;
  if (Object.prototype.hasOwnProperty.call(job || {}, "job_id")
      && !Object.prototype.hasOwnProperty.call(job || {}, "_send_paused")) return false;
  if (pauseValue === null || pauseValue === true || pauseValue === 1
      || ["1", "true", "yes", "on"].includes(String(pauseValue || "").toLowerCase())) return false;

  if (isTerminalStatus(status) || isSimulationJob(job) || !isTrustworthySource(job?.source)) return false;
  if (isBlockedOutreachJob(job) || isBlacklistedJob(job) || hasReferralContact(job)) return false;
  if (inferATS(link) === "indeed") {
    if (!includeIndeed) return false;
  }
  return true;
}

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

function findResumePdf(company, title, dbPdfPath = "") {
  const pdfDir = path.join(ROOT, "output", "pdf");
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const candidates = [];

  // The DB path is authoritative when present. Only use fuzzy filename matching
  // if that exact file is missing; never let directory order pick a different CV.
  if (dbPdfPath) {
    const exact = path.isAbsolute(String(dbPdfPath))
      ? String(dbPdfPath)
      : path.resolve(ROOT, String(dbPdfPath));
    candidates.push(exact);
  }

  // A manual URL has no meaningful company match, so do not attach an arbitrary
  // tailored PDF to it.
  if (String(company || "") === "Manual") {
    candidates.push(path.join(ROOT, "output", "resume.pdf"));
    for (const p of candidates) {
      try { if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
  }

  const safeFilePart = (value) => String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  candidates.push(
    path.join(pdfDir, `${safeFilePart(company)} - ${safeFilePart(title)}.pdf`),
    path.join(pdfDir, `${safeFilePart(company)}.pdf`),
  );
  const needle = norm(company).slice(0, 18);
  // Prefer the tailored per-job PDF (CV_<Company>_...), matched by company substring
  if (needle && fs.existsSync(pdfDir)) {
    const hit = fs.readdirSync(pdfDir).find(f => f.endsWith(".pdf") && norm(f).includes(needle));
    if (hit) candidates.push(path.join(pdfDir, hit));
  }
  candidates.push(path.join(ROOT, "output", "resume.pdf")); // base CV fallback
  for (const p of candidates) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function inferATS(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return "generic";
  const host = canonicalHost(parsed.hostname);
  // Suffix matching here is classification only.  It never grants trust to
  // a tenant: isAllowedNavigationUrl still requires the original hostname
  // or an exact service host.
  const looksLike = (ats) => serviceHostsForAts(ats).some((service) => {
    const base = canonicalHost(service);
    return host === base || host.endsWith(`.${base}`);
  });
  if (looksLike("greenhouse")) return "greenhouse";
  if (looksLike("lever")) return "lever";
  if (looksLike("ashby")) return "ashby";
  if (looksLike("workday")) return "workday";
  if (looksLike("smartrecruiters")) return "smartrecruiters";
  if (looksLike("naukri")) return "naukri";
  if (looksLike("wellfound")) return "wellfound";
  if (looksLike("linkedin")) return "linkedin";
  if (looksLike("indeed")) return "indeed";
  if (looksLike("glassdoor")) return "glassdoor";
  if (looksLike("jobhai")) return "jobhai";
  if (looksLike("yc")) return "yc";
  return "generic";
}

/**
 * Apply the complete initial-URL policy before a page or PII operation can
 * start.  The boundary is created from the URL itself so an HTTP URL cannot
 * become a trusted origin merely because its hostname is familiar.
 */
function isAllowedInitialJobUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const ats = inferATS(url);
  return isAllowedNavigationUrl(url, ats, createNavigationBoundary(url, ats));
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
    submitBtn: ['button:not([disabled]):has-text("Send")', 'button:has-text("Send")', 'button:has-text("Submit")', 'button:has-text("Apply")']
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
    // Most LinkedIn roles are off-site applies ("Responses managed off
    // LinkedIn") and expose a plain Apply control, not Easy Apply. Without
    // these the button is never even seen.
    applyBtn: [
      'button[aria-label*="Easy Apply"]',
      'button:has-text("Easy Apply")',
      'button.jobs-apply-button',
      'a[data-tracking-control-name*="public_jobs_apply"]',
      'button[data-tracking-control-name*="public_jobs_apply"]',
      'a.jobs-apply-button',
      'div.jobs-details a:has-text("Apply")',
      'div.jobs-details button:has-text("Apply")',
      '.jobs-view-container a:has-text("Apply")',
      'a:has-text("Apply now")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[type="tel"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button[aria-label="Submit application"]', 'button:has-text("Submit application")']
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
      firstName: ['input[name="firstName"]', 'input[name="first_name"]', 'input[name="firstname"]', 'input[autocomplete="given-name"]', 'input[id*="first-name" i]', 'input[placeholder*="irst name"]'],
      lastName: ['input[name="lastName"]', 'input[name="last_name"]', 'input[name="lastname"]', 'input[autocomplete="family-name"]', 'input[id*="last-name" i]', 'input[placeholder*="ast name"]'],
      email: ['input[type="email"]', 'input[name="email"]', '#email'],
      phone: ['input[type="tel"]', 'input[name="phone"]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")', 'button[type="submit"]', 'button:has-text("Apply")']
  }
};

async function tryFill(page, selectors, value) {
  // An empty value is a missing fact, not something to write into a form.
  if (!String(value ?? "").trim()) return false;
  for (const sel of selectors) {
    // Pages often ship a hidden mobile/desktop duplicate of the same form, so
    // resolve to the first visible match rather than the first in the DOM.
    const el = await pickVisible(page.locator(sel));
    if (await el.count() > 0) {
      try {
        await el.waitFor({ state: "visible", timeout: 2500 });
        await el.fill(value, { timeout: 2500 });
        console.log(`    [fill] ${sel} → "${value.slice(0,30)}"`);
        return true;
      } catch {}
    }
  }
  return false;
}

async function hasCrossOriginFormOrFrame(page, originUrl = null) {
  // On an operator-approved external apply page the real form often lives on a
  // known ATS host, so that pairing is allowed. Any other third-party target
  // still counts as cross-origin and blocks the fill/upload.
  const permittedHosts = [];
  if (ALLOW_EXTERNAL_APPLY && isNavigationBoundary(originUrl) && originUrl.externalApplyHost) {
    for (const hosts of Object.values(ATS_SERVICE_HOSTS)) {
      for (const host of hosts || []) permittedHosts.push(canonicalHost(host));
    }
  }
  if (!page || typeof page.evaluate !== "function") return false;
  return page.evaluate((allowed) => {
    const origin = window.location.origin;
    const cross = (value) => {
      const text = String(value || "").trim().toLowerCase();
      if (!text || text === "about:blank") return false;
      let resolved;
      try { resolved = new URL(text, window.location.href); }
      catch { return true; }
      if (resolved.origin === origin) return false;
      if (allowed.length && resolved.protocol === "https:" && allowed.includes(resolved.hostname.toLowerCase())) {
        return false;
      }
      return true;
    };
    const formTarget = [...document.querySelectorAll("form")].some((form) => cross(form.getAttribute("action") || form.action));
    const buttonTarget = [...document.querySelectorAll("button, input[type='submit']")].some((button) => cross(button.getAttribute("formaction")));
    // Only a cross-origin frame that actually holds the form fields is a
    // problem. Marketing, analytics, video and calendar embeds must not stop
    // a fill on the page's own form.
    const frameTarget = [...document.querySelectorAll("iframe")].some((frame) => {
      if (!cross(frame.getAttribute("src") || frame.src)) return false;
      try {
        const doc = frame.contentDocument;
        if (!doc) return false;
        return [...doc.querySelectorAll("input, textarea, select")]
          .some((el) => !/hidden/i.test(String(el.type || "")));
      } catch {
        // An opaque cross-origin document cannot be inspected; treat a frame
        // that declares a form as holding the fields.
        return !!frame.getAttribute("src");
      }
    });
    return formTarget || buttonTarget || frameTarget;
  }, permittedHosts).catch(() => true);
}

// True once an approved off-site hop has moved us off the originating ATS.
function onExternalAts(boundary) {
  return !!(isNavigationBoundary(boundary) && boundary.externalApplyHost);
}

// has-text matches hidden nodes too, so always resolve to the first *visible*
// match before reading a label or clicking.
async function pickVisible(locator) {
  const count = await locator.count().catch(() => 0);
  if (count <= 1) return locator.first();
  for (let i = 0; i < Math.min(count, 12); i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return locator.first();
}

// Consent banners sit over the form and swallow clicks. Dismissing the cookie
// notice is not a legal agreement, so it is safe to clear automatically.
async function dismissConsentBanners(page) {
  const patterns = [
    'button:has-text("I understand")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Got it")',
    'button:has-text("Allow all")',
    '[id*="onetrust"] button[id*="accept"]',
    '[class*="ketch"] button:has-text("I understand")',
  ];
  for (const pattern of patterns) {
    const el = await pickVisible(page.locator(pattern));
    if ((await el.count().catch(() => 0)) === 0) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 4000 }).catch(() => {});
    console.log("    [consent-banner] dismissed a cookie notice to reach the form");
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function tryUpload(page, selectors, filePath, ats = null, originUrl = null) {
  const currentUrl = typeof page?.url === "function" ? page.url() : "";
  const effectiveAts = ats || (isNavigationBoundary(originUrl) ? originUrl.ats : "generic");
  // A resume is PII.  Require the same HTTPS origin boundary in dry-run as
  // well as live mode; otherwise preview mode becomes a plaintext upload
  // bypass.
  if (!originUrl || !currentUrl || !isCurrentPageTrusted(currentUrl, effectiveAts, originUrl)) {
    console.log("    [upload] blocked: current page is not a trusted HTTPS origin");
    return false;
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`    [upload] no PDF to attach`);
    return false;
  }
  if (await hasCrossOriginFormOrFrame(page, originUrl)) {
    console.log("    [upload] blocked: cross-origin form/iframe target detected");
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

function requestIsMainFrame(request, page) {
  try {
    const frame = request.frame?.();
    if (!frame) return true;
    const main = page.mainFrame?.();
    return !main || frame === main || frame.parentFrame?.() === null;
  } catch {
    return true;
  }
}

function requestFrameOrigin(request, page) {
  try {
    const frame = request.frame?.();
    // Compare a child-frame request with its parent, not with the frame's
    // destination URL (which may already reflect an untrusted cross-origin
    // navigation).
    const parentUrl = frame?.parentFrame?.()?.url?.();
    return parseHttpUrl(parentUrl) || parseHttpUrl(page.url?.());
  } catch {
    return parseHttpUrl(page.url?.());
  }
}

function isAllowedAssetRequest(requestUrl, requestType, ats) {
  const url = parseHttpUrl(requestUrl);
  if (!url || url.protocol !== "https:" || !ASSET_RESOURCE_TYPES.has(String(requestType || "").toLowerCase())) {
    return false;
  }
  const hosts = ATS_ASSET_HOSTS[String(ats || "").toLowerCase()] || [];
  return hosts.some((host) => canonicalHost(url.hostname) === canonicalHost(host));
}

function isAllowedReadOnlyApiRequest(requestUrl, requestType, method, ats) {
  const url = parseHttpUrl(requestUrl);
  const requestTypeName = String(requestType || "").toLowerCase();
  if (!url || url.protocol !== "https:" || !["GET", "HEAD"].includes(String(method || "GET").toUpperCase())) {
    return false;
  }
  const entries = ATS_TRUSTED_REQUEST_HOSTS[String(ats || "").toLowerCase()] || [];
  return entries.some((entry) => (
    canonicalHost(url.hostname) === canonicalHost(entry.host)
    && url.pathname.startsWith(entry.pathPrefix)
    && entry.types.includes(requestTypeName)
  ));
}

async function installNavigationGuard(page, ats, originUrl) {
  if (!page) throw new Error("navigation guard unavailable");
  const boundary = isNavigationBoundary(originUrl)
    ? originUrl
    : createNavigationBoundary(typeof originUrl === "string" ? originUrl : page.url?.(), ats);
  const pageContext = typeof page.context === "function" ? page.context() : null;
  // Use a context-level guard for isolated job contexts (it also covers fetch
  // from service workers/child frames); shared Edge contexts use a page-level
  // guard so one job's boundary cannot poison another job's pages.
  const routeTarget = (!sharedCtx && typeof pageContext?.route === "function")
    ? pageContext
    : (typeof page.route === "function" ? page : (typeof pageContext?.route === "function" ? pageContext : null));
  if (!routeTarget) throw new Error("navigation guard unavailable");

  await routeTarget.route("**/*", async (route) => {
    let request;
    try {
      request = route.request();
      const requestUrl = request.url();
      const requestType = request.resourceType?.() || "";
      const requestMethod = String(request.method?.() || "GET").toUpperCase();
      const isMainNavigation = typeof request.isNavigationRequest === "function"
        ? request.isNavigationRequest()
        : (!requestType || requestType === "document");
      if (isMainNavigation && requestIsMainFrame(request, page)) {
        const method = requestMethod;
        const currentOrigin = navigationPinnedOrigin(boundary) || page.url?.();
        // Approved service hosts may be used for GET navigation/redirects,
        // but a cross-origin POST form is never a safe application target.
        if (method !== "GET" && !sameOrigin(requestUrl, currentOrigin)) {
          console.log(`    [form-target-block] ${method} ${requestUrl}`);
          await route.abort("blockedbyclient");
          return;
        }
        if (!isAllowedNavigationUrl(requestUrl, ats, boundary)) {
          console.log(`    [redirect-block] ${requestUrl}`);
          await route.abort("blockedbyclient");
          return;
        }
        // Leave the initial origin unpinned until page.goto finishes: a
        // server redirect from that origin to an approved service host must
        // still be allowed. Any service-host transition (or a later request)
        // is then pinned immediately.
        const wasPinned = !!boundary.pinnedOrigin;
        if (wasPinned || !sameOrigin(requestUrl, boundary.initialOrigin)) {
          pinNavigationOrigin(boundary, requestUrl);
        }
      } else {
        // While filling/uploading, permit only same-origin HTTP(S) resources.
        // This covers cross-origin iframes, form actions, fetch/XHR, and
        // script/image requests before PII can leave the page.
        const frameOrigin = requestFrameOrigin(request, page)
          || parseHttpUrl(navigationPinnedOrigin(boundary));
        const requestParsed = parseHttpUrl(requestUrl);
        const blankFrame = /^about:blank(?:[#?].*)?$/i.test(String(requestUrl || ""));
        const trustedAsset = isAllowedAssetRequest(requestUrl, requestType, ats);
        const trustedReadOnlyApi = isAllowedReadOnlyApiRequest(
          requestUrl, requestType, requestMethod, ats
        );
        if (!blankFrame && !trustedAsset && !trustedReadOnlyApi
            && (!requestParsed || !frameOrigin || !sameOrigin(requestParsed, frameOrigin))) {
          const kind = request.resourceType?.() || "subresource";
          console.log(`    [subresource-block] ${kind} ${requestUrl}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    } catch (error) {
      // Guard failures are fail-closed. Never turn an aborted request into a
      // permitted request in the catch path.
      console.log(`    [route-block] guard failed: ${String(error).slice(0, 100)}`);
      try { await route.abort("blockedbyclient"); } catch {}
    }
  });
  return boundary;
}

async function waitForApplicationSurface(page, timeoutMs = 30000) {
  if (!page || typeof page.evaluate !== "function") return true;
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let polls = 0;
  while (Date.now() < deadline) {
    // Readiness is the presence of real form controls. Loader copy such as
    // "Reading Your Resume" stays in the DOM after parsing finishes, so text
    // matching alone would block forever.
    const ready = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const entry = [...document.querySelectorAll("input, textarea, select")].filter(visible)
        .filter((el) => !/hidden|submit|button|file|checkbox|radio/i.test(`${el.type || ""}`));
      if (entry.length) return true;
      return [...document.querySelectorAll("button, a, [role='button']")].filter(visible).some((el) => {
        const label = ((el.innerText || el.value || "") || "").trim();
        return /\b(?:submit|apply|send application|continue|next)\b/i.test(label);
      });
    }).catch(() => false);
    if (ready) return true;
    if (polls % 15 === 0) console.log("    [wait] waiting for the application form to render…");
    polls += 1;
    await page.waitForTimeout(1000).catch(() => {});
  }
  console.log("    [wait] application form did not render in time; continuing conservatively");
  return false;
}

// Off-site applies land on the employer's own careers site, which is not a
// known ATS host. This is an explicit, operator-approved relaxation and stays
// off unless enabled. Only the first off-site hop is allowed and the boundary
// is re-pinned to it, so a redirect chain still cannot walk further.
const ALLOW_EXTERNAL_APPLY = /^(?:1|true|yes|on)$/i.test(
  String(process.env.PULSEOPS_ALLOW_EXTERNAL_APPLY || "").trim(),
);

// Hosts that must never become an application target regardless of policy.
const EXTERNAL_APPLY_HOST_DENYLIST = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|pastebin\.com|discord\.gg|wa\.me)\b/i;

function tryPinExternalApplyOrigin(boundary, landingUrl, ats, enabled = ALLOW_EXTERNAL_APPLY) {
  if (!enabled) return false;
  if (!isNavigationBoundary(boundary)) return false;
  const url = parseHttpUrl(landingUrl);
  if (!url || url.protocol !== "https:" || url.port) return false;
  const host = canonicalHost(url.hostname);
  if (!host || EXTERNAL_APPLY_HOST_DENYLIST.test(host)) return false;
  // Exactly one off-site hop is ever granted, and the pin never returns to the
  // ATS host, so a redirect chain still cannot walk further.
  if (boundary.externalApplyHost) return false;
  if (host === boundary.initialHost) return false;
  boundary.externalApplyHost = host;
  boundary.pinnedOrigin = url.origin;
  return true;
}

async function navigateAllowed(page, target, ats, originUrl) {
  const boundary = isNavigationBoundary(originUrl)
    ? originUrl
    : createNavigationBoundary(target, ats);
  if (!isAllowedNavigationUrl(target, ats, boundary)) {
    console.log(`    [redirect-block] refusing navigation to ${target}`);
    return false;
  }
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log(`    [redirect-block] navigation failed: ${String(e).slice(0, 100)}`);
    return false;
  }
  if (!isAllowedNavigationUrl(page.url(), ats, boundary)) {
    if (tryPinExternalApplyOrigin(boundary, page.url(), ats)) {
      console.log(`    [external-apply] approved off-site apply host → ${canonicalHost(parseHttpUrl(page.url()).hostname)}`);
      return true;
    }
    console.log(`    [redirect-block] landed on ${page.url()}`);
    return false;
  }
  pinNavigationOrigin(boundary, page.url());
  return true;
}

async function detectAndClickApply(page, ats, originUrl, finalGuard = {}) {
  const currentUrl = typeof page?.url === "function" ? page.url() : "";
  if (!originUrl || !currentUrl || !isCurrentPageTrusted(currentUrl, ats, originUrl)) {
    console.log("    [redirect-block] refusing to interact with a non-HTTPS or untrusted page");
    return { clicked: false, blocked: true, reason: "redirect" };
  }
  const sels = ATS_SELECTORS[ats]?.applyBtn || ATS_SELECTORS.generic.applyBtn;
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      const href = typeof el.getAttribute === "function" ? await el.getAttribute("href").catch(() => null) : null;
      const innerText = typeof el.innerText === "function" ? await el.innerText().catch(() => "") : "";
      const ariaLabel = typeof el.getAttribute === "function" ? await el.getAttribute("aria-label").catch(() => "") : "";
      const valueLabel = typeof el.getAttribute === "function" ? await el.getAttribute("value").catch(() => "") : "";
      const label = (innerText || ariaLabel || valueLabel || sel).trim().slice(0, 80);
      console.log(`    [found] Apply → ${sel} "${label}" href=${href?.slice(0,80)}`);
      let target = null;
      let httpTarget = null;
      if (href) {
        try {
          target = new URL(href, page.url()).toString();
          if (/^https?:/i.test(target)) httpTarget = target;
        } catch { target = null; }
        if (httpTarget && !isAllowedNavigationUrl(httpTarget, ats, originUrl)) {
          console.log(`    [redirect-block] apply link is outside the exact ATS boundary`);
          return { clicked: false, blocked: true, reason: "redirect" };
        }
      }

      const oneStep = await pageHasOneStepApplicationForm(page);
      const type = typeof el.getAttribute === "function" ? await el.getAttribute("type").catch(() => "") : "";
      const classification = classifyApplyControl({ label, href, selector: sel, oneStep, isSubmit: type === "submit" });
      console.log(`    [apply-class] ${classification.classification} (${label})`);
      if (classification.classification === "unknown") {
        return { clicked: false, blocked: true, reason: "unknown-control" };
      }

      if (classification.final) {
        // A final-looking control is never raw-clicked, even when it has an
        // href. The centralized guard rechecks pause/ownership immediately
        // before the click.
        const finalClick = await clickFinalControl(page, el, label, finalGuard);
        return {
          clicked: !!finalClick.clicked,
          blocked: false,
          finalAction: true,
          finalClick,
        };
      }

      // Only an explicitly intermediate Apply/modal trigger reaches this raw
      // click branch. An absolute link merely opens the form and is guarded
      // as navigation; it is not itself a final submission.
      if (httpTarget) {
        if (!(await navigateAllowed(page, httpTarget, ats, originUrl))) {
          return { clicked: false, blocked: true, reason: "redirect" };
        }
      } else {
        try {
          if (/easy apply/i.test(label + " " + sel) && ats === "linkedin") {
            const detail = page.locator("div.jobs-details button:has-text('Easy Apply'), div.jobs-search__job-details button:has-text('Easy Apply'), button.jobs-apply-button").first();
            if ((await detail.count()) > 0) {
              console.log("    [easy-apply] clicking detail-pane button");
              if (!(await clickTriggerControl(detail))) throw new Error("easy-apply detail trigger did not respond");
            } else {
              // Current LinkedIn markup may expose the Easy Apply control
              // outside the legacy detail-pane containers. The matched
              // control is already a button on the trusted job page, so use
              // it as the modal trigger rather than declaring a false dead end.
              console.log("    [easy-apply] clicking matched job-page control");
              if (!(await clickTriggerControl(el))) throw new Error("easy-apply trigger did not respond");
            }
          } else {
            if (!(await clickTriggerControl(el))) throw new Error("apply trigger did not respond");
          }
          await page.waitForTimeout(1500);
        } catch (error) {
          console.log(`    [apply-trigger-fail] ${String(error).slice(0, 100)}`);
          return { clicked: false, blocked: true, reason: "trigger-failed" };
        }
      }
      if (!isCurrentPageTrusted(page.url(), ats, originUrl)) {
        return { clicked: false, blocked: true, reason: "redirect" };
      }
      return { clicked: true, blocked: false, finalAction: false, classification };
    }
  }
  const missingState = await classifyMissingApplyState(page);
  if (missingState === "closed-listing") {
    console.log("    [apply-state] listing is closed — no apply path exists");
  } else if (missingState === "external-apply") {
    console.log("    [apply-state] application must be completed on the company site");
  } else if (missingState === "already-applied") {
    console.log("    [apply-state] page reports an existing application");
  } else {
    console.log(`    [warn] no Apply button found for ${ats} — assuming already on form`);
  }
  return { clicked: false, blocked: false, finalAction: false, missingState };
}

// Chip-style questions expose fixed option sets. Map the candidate's stated
// preference onto the nearest offered option instead of inventing an answer.
function matchChipOption(options, desired) {
  const wanted = String(desired || "").trim().toLowerCase();
  if (!wanted || !Array.isArray(options) || !options.length) return null;
  const days = Number.parseInt(wanted, 10);
  const toDays = (text) => {
    const t = String(text || "").trim().toLowerCase();
    if (/immediate/.test(t)) return 0;
    const d = t.match(/(\d+)\s*day/);
    if (d) return Number.parseInt(d[1], 10);
    const m = t.match(/(\d+)\s*month/);
    if (m) return Number.parseInt(m[1], 10) * 30;
    if (/\b1\s*month\b/.test(t)) return 30;
    return null;
  };
  if (Number.isFinite(days)) {
    let best = null;
    let bestDelta = Infinity;
    for (const option of options) {
      const value = toDays(option);
      if (value === null) continue;
      const delta = Math.abs(value - days);
      if (delta < bestDelta) { bestDelta = delta; best = option; }
    }
    if (best) return best;
  }
  const exact = options.find((o) => String(o).trim().toLowerCase() === wanted);
  return exact || null;
}

// Salary bands are ranges, so pick the offered band that actually contains the
// stated expectation rather than the nearest label.
function matchSalaryOption(options, desired) {
  const nums = String(desired || "").match(/\d+(?:\.\d+)?/g);
  if (!nums || !Array.isArray(options) || !options.length) return null;
  const want = nums.map(Number);
  // A stated range is represented by its midpoint so that "4 to 5" lands in
  // 4-6 rather than only touching the upper bound of 2-4.
  const target = want.length > 1 ? (Math.min(...want) + Math.max(...want)) / 2 : want[0];
  let containing = null;
  let closest = null;
  let closestDelta = Infinity;
  for (const option of options) {
    const values = String(option).match(/\d+(?:\.\d+)?/g);
    if (!values) continue;
    const v = values.map(Number);
    const optLow = Math.min(...v);
    const optHigh = v.length > 1 ? Math.max(...v) : optLow;
    if (optLow <= target && optHigh >= target) { containing = option; break; }
    const delta = target < optLow ? optLow - target : target - optHigh;
    if (delta < closestDelta) { closestDelta = delta; closest = option; }
  }
  return containing || closest;
}

/**
 * Answer the candidate-specific questions that gate a disabled final action
 * (Shine: Current Location, Notice Period, Salary). Only values the candidate
 * actually supplied are used; anything unknown is left for a human.
 */
async function answerCandidateQuestions(page, profile) {
  const candidate = profile?.candidate || {};
  const answered = [];
  const unanswered = [];

  const location = String(candidate.current_location || "").trim();
  if (location) {
    const box = page.locator(
      'div[role="combobox"][aria-label*="ocation" i], input[aria-label*="ocation" i], input[placeholder*="ocation" i]',
    ).first();
    if (await box.count()) {
      await box.click({ timeout: 4000 }).catch(() => {});
      await box.fill(location, { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
      // Option labels live in .combobox-input-option-label. Pick the closest
      // match to what was typed rather than blindly taking the first row.
      const options = await page.locator(".combobox-input-option-label").allInnerTexts().catch(() => []);
      const wanted = location.toLowerCase().split(",")[0].trim();
      const best = options.find((o) => o.trim().toLowerCase() === wanted)
        || options.find((o) => o.toLowerCase().includes(wanted))
        || options[0];
      if (best) {
        await page.locator(".combobox-input-option-label").filter({ hasText: best }).first()
          .click({ timeout: 4000 }).catch(() => {});
        console.log(`    [answer] current location → "${best.trim()}"`);
        answered.push("current_location");
      } else {
        unanswered.push("current_location");
      }
      await page.waitForTimeout(600);
    }
  }

  // Chip groups: pick the offered option closest to the stated preference.
  const groups = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const out = [];
    [...document.querySelectorAll("div")].filter(visible).forEach((el) => {
      const chips = [...el.querySelectorAll("button")].filter(visible);
      if (chips.length < 2 || chips.length > 8) return;
      const parentChips = el.parentElement
        ? [...el.parentElement.querySelectorAll("button")].filter(visible).length : 0;
      if (parentChips === chips.length) return;
      out.push(chips.map((c) => ((c.innerText || "") || "").trim()).filter(Boolean));
    });
    return out;
  }).catch(() => []);

  for (const labels of groups) {
    const joined = labels.join(" ").toLowerCase();
    if (/notice|join|days?|months?/.test(joined) && candidate.notice_period) {
      const pick = matchChipOption(labels, candidate.notice_period);
      if (pick) {
        const chip = page.locator("button").filter({ hasText: new RegExp(`^\\s*${pick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).first();
        if (await chip.count()) {
          await chip.click({ timeout: 4000 }).catch(() => {});
          console.log(`    [answer] notice period → "${pick}"`);
          answered.push("notice_period");
          continue;
        }
      }
    }
    if (/salary|ctc|compensation|lpa|lakh/.test(joined)) {
      unanswered.push(`salary (offered: ${labels.join(" / ")})`);
      continue;
    }
    if (/experience|exp\b/.test(joined)) {
      unanswered.push(`experience (offered: ${labels.join(" / ")})`);
    }
  }

  // Native selects and custom comboboxes both gate the final action.
  const selects = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    return [...document.querySelectorAll("select")].filter(visible).map((el) => ({
      kind: "select",
      id: el.id || "",
      name: el.name || "",
      label: (el.getAttribute("aria-label") || el.id || el.name || "").replace(/\s+/g, " ").trim().slice(0, 40),
      options: [...el.options].map((o) => String(o.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    }));
  }).catch(() => []);

  for (const select of selects) {
    const hint = `${select.id} ${select.name} ${select.label}`.toLowerCase();
    if (!/salary|ctc|compensation|lpa|lakh|year|month/.test(hint)) continue;
    let pick = null;
    if (/salary|ctc|compensation|lpa|lakh/.test(hint)) {
      pick = matchSalaryOption(select.options, candidate.expected_salary);
    } else if (/year/.test(hint)) {
      const years = Number.parseInt(String(candidate.experience_years ?? ""), 10);
      if (Number.isFinite(years)) {
        pick = select.options.find((o) => new RegExp(`^\\s*${years}\\s+year`, "i").test(o)) || null;
      }
    }
    if (!pick) {
      unanswered.push(`${hint.split(" ")[0] || "field"} (offered: ${select.options.join(" / ")})`);
      continue;
    }
    await page.locator("select").filter({ has: page.locator(`option:text-is("${pick}")`) }).first()
      .selectOption({ label: pick }).catch(() => {});
    console.log(`    [answer] ${hint.split(" ")[0] || "field"} → "${pick}"`);
    answered.push(hint.split(" ")[0] || "field");
  }

  // Custom dropdowns (Shine) render options as .select-option-label inside
  // li[role="option"]; the trigger is identified by the text it currently shows.
  const DROPDOWN_OPTION_SELECTOR = '.select-option-label, li[role="option"], .combobox-input-option-label';
  const dropdowns = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const found = [];
    [...document.querySelectorAll("div,button,span")].filter(visible).forEach((el) => {
      const text = ((el.textContent || "") || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 40) return;
      if (/^select current salary$/i.test(text)) found.push({ text, kind: "salary" });
      else if (/^\d+\s+years?$/i.test(text)) found.push({ text, kind: "experience years" });
      else if (/^\d+\s+months?$/i.test(text)) found.push({ text, kind: "experience months" });
    });
    return [...new Map(found.map((f) => [f.kind, f])).values()];
  }).catch(() => []);

  for (const dropdown of dropdowns) {
    const kind = dropdown.kind;
    const years = Number.parseInt(String(candidate.experience_years ?? ""), 10);
    const matcher = (options) => {
      if (kind === "salary") return matchSalaryOption(options, candidate.expected_salary);
      if (kind === "experience years") {
        if (!Number.isFinite(years)) return null;
        return options.find((o) => new RegExp(`^\\s*${years}\\s+year`, "i").test(o)) || null;
      }
      return options.find((o) => /^\s*0\s+month/i.test(o)) || null;
    };
    const trigger = page.getByText(dropdown.text, { exact: true }).first();
    if (!(await trigger.count())) continue;
    await trigger.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const options = (await page.locator(DROPDOWN_OPTION_SELECTOR).allInnerTexts().catch(() => []))
      .map((o) => o.trim()).filter(Boolean);
    const pick = matcher(options);
    if (!pick) {
      unanswered.push(`${kind} (offered: ${options.join(" / ") || "none"})`);
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }
    await page.locator(DROPDOWN_OPTION_SELECTOR).filter({ hasText: pick }).first()
      .click({ timeout: 4000 }).catch(() => {});
    console.log(`    [answer] ${kind} → "${pick}"`);
    answered.push(kind);
    await page.waitForTimeout(600);
  }

  return { answered, unanswered };
}

/**
 * Some portals verify the phone by SMS before the application is actually
 * submitted. The code proves the operator controls that number, so it is only
 * ever supplied by a human at the prompt — never generated, guessed, or read
 * from anywhere else. Returns the submitted state so the caller can verify.
 */
async function completeSmsVerification(page, { timeoutMs = 180000 } = {}) {
  if (!ENTER_OTP && !OTP_PAUSE) return { state: "not-requested" };
  // Gate on page text rather than fragile class names: the dialog copy is the
  // reliable signal that a code is actually being requested.
  for (let attempt = 0; attempt < 10; attempt++) {
    const asking = await page.evaluate(() =>
      /verification code|enter otp|one[-\s]?time password|\botp\b|code (?:we|we've) sent/i.test(document.body?.innerText || "")
    ).catch(() => false);
    if (asking) break;
    if (attempt === 9) {
      console.log("  [otp] no code prompt detected — leaving for manual completion");
      return { state: "not-present" };
    }
    await page.waitForTimeout(1000);
  }

  console.log("\n  [otp] This portal sent a verification code to your phone.");
  if (OTP_PAUSE) {
    // The browser is headed, so let the operator finish in the visible window
    // and poll for the result rather than reading a code out of thin air.
    console.log(`  [otp] complete the code in the browser window; waiting up to ${Math.round(OTP_PAUSE_MS / 1000)}s…`);
    const flowUrl = page.url();
    const deadline = Date.now() + OTP_PAUSE_MS;
    while (Date.now() < deadline) {
      const done = await page.evaluate(() =>
        /application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
      ).catch(() => false);
      if (done) return { state: "submitted" };
      // The code dialog is modal, so the only way out of it is a successful
      // verification. Portals then redirect to onboarding/recommended jobs,
      // which says nothing about the application.
      const current = page.url();
      if (current && current !== flowUrl && !/otp|verif/i.test(current)) {
        console.log(`  [otp] left the verification dialog for ${current.slice(0, 90)} — treating as verified`);
        return { state: "submitted" };
      }
      await page.waitForTimeout(2000);
    }
    console.log("  [otp] no confirmation appeared — leaving for manual completion");
    return { state: "unconfirmed" };
  }
  process.stdout.write("  [otp] Enter the code you received (blank to skip): ");
  const code = await readLineFromStdin(timeoutMs);
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length < 4) {
    console.log("\n  [otp] no usable code supplied — leaving for manual completion");
    return { state: "skipped" };
  }

  // Prefer explicit one-time-code inputs; otherwise scope to the dialog so the
  // underlying form's phone field is never targeted.
  const explicit = page.locator('input[autocomplete="one-time-code"]');
  let target = explicit;
  if ((await explicit.count().catch(() => 0)) < digits.length) {
    const dialog = page.locator('[role="dialog"], [class*="modal"], [class*="Modal"]').last();
    const scoped = (await dialog.count().catch(() => 0))
      ? dialog.locator("input")
      : page.locator('input[inputmode="numeric"]');
    if ((await scoped.count().catch(() => 0)) >= digits.length) target = scoped;
  }
  const available = await target.count().catch(() => 0);
  if (available >= digits.length) {
    for (let i = 0; i < digits.length; i++) {
      await target.nth(i).fill(digits[i], { timeout: 3000 }).catch(() => {});
    }
  } else if (available === 1) {
    await target.first().fill(digits, { timeout: 3000 }).catch(() => {});
  } else {
    console.log("  [otp] could not locate the code boxes — leaving for manual completion");
    return { state: "no-inputs" };
  }
  const confirm = page.locator(
    'button:has-text("Verify & Submit"), button:has-text("Verify and Submit"), button:has-text("Verify"), button:has-text("Submit")',
  ).first();
  if (await confirm.count()) {
    await confirm.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const ok = await page.evaluate(() =>
    /application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
  ).catch(() => false);
  return { state: ok ? "submitted" : "unconfirmed" };
}

function readLineFromStdin(timeoutMs = 180000) {
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/\d{4,8}/);
      if (match) finish(match[0]);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    setTimeout(() => finish(""), Math.max(1000, Number(timeoutMs) || 180000)).unref?.();
  });
}

/**
 * Visible entry fields still left empty. A final click that produces no
 * confirmation is almost always blocked by one of these, and many portals
 * mark requiredness with a CSS asterisk rather than the required attribute.
 */
async function describeEmptyEntryFields(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const out = [];
    [...document.querySelectorAll("input, textarea")].filter(visible).forEach((el) => {
      const type = String(el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "file", "checkbox", "radio"].includes(type)) return;
      if (String(el.value || "").trim()) return;
      const label = el.getAttribute("aria-label")
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
        || el.placeholder
        || el.name
        || type;
      out.push(String(label).replace(/\s+/g, " ").trim().slice(0, 40));
    });
    return [...new Set(out)].slice(0, 8);
  }).catch(() => []);
}

/**
 * Tick required terms/privacy agreement boxes, but only under the explicit
 * operator flag. Marketing opt-ins and unrelated boxes are never touched, and
 * every acceptance is logged so the action is auditable.
 */
async function acceptRequiredTerms(page) {
  if (!ACCEPT_TERMS) return [];
  if (!page || typeof page.evaluate !== "function") return [];
  const accepted = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const agreement = /\b(terms|privacy policy|privacy notice|acceptable use|consent|agree|i understand|i acknowledge)\b/i;
    const marketing = /\b(newsletter|marketing|promotional|offers|subscribe|product updates|marketing communications)\b/i;
    const ticked = [];
    [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).forEach((el) => {
      if (el.checked) return;
      const required = el.required
        || el.getAttribute("aria-required") === "true"
        || /\brequired\b/i.test(String(el.className || ""));
      if (!required) return;
      const label = el.getAttribute("aria-label")
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
        || (el.closest("label")?.textContent)
        || el.name
        || "";
      const text = String(label).replace(/\s+/g, " ").trim();
      if (!agreement.test(text) || marketing.test(text)) return;
      el.click();
      ticked.push(text.slice(0, 70));
    });
    return [...new Set(ticked)];
  }).catch(() => []);
  for (const text of accepted) {
    console.log(`  [terms-accepted] ticked under operator authorisation: "${text}"`);
  }
  return accepted;
}

/**
 * List unticked required checkboxes. These are usually legal attestations
 * ("I agree to the Terms of Use"), which the candidate must give themselves, so
 * they are reported rather than clicked.
 */
async function describeUncheckedConsents(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const out = [];
    [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).forEach((el) => {
      if (el.checked) return;
      const required = el.required
        || el.getAttribute("aria-required") === "true"
        || /\brequired\b/i.test(String(el.className || ""));
      if (!required) return;
      const label = el.getAttribute("aria-label")
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
        || (el.closest("label")?.textContent)
        || el.name
        || "required checkbox";
      out.push(String(label).replace(/\s+/g, " ").trim().slice(0, 70));
    });
    return [...new Set(out)].slice(0, 5);
  }).catch(() => []);
}

/**
 * List visible required inputs that are still empty. A disabled final control
 * is almost always caused by one of these, and the operator needs to know
 * which answers only the candidate can give.
 */
async function describeMissingRequiredFields(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const out = [];
    document.querySelectorAll("input, select, textarea").filter(visible).forEach((el) => {
      const type = String(el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "file", "checkbox", "radio"].includes(type)) return;
      const required = el.required
        || el.getAttribute("aria-required") === "true"
        || /\brequired\b/i.test(String(el.className || ""));
      if (required && !String(el.value || "").trim()) {
        out.push(String(el.getAttribute("aria-label") || el.name || el.id || el.placeholder || type).slice(0, 40));
      }
    });
    return [...new Set(out)].slice(0, 8);
  }).catch(() => []);
}

/**
 * Click an intermediate Apply/modal trigger. These controls are frequently
 * below the fold or briefly covered by a sticky header, so scroll first, allow
 * a longer budget, and retry once through the overlay. Triggers are never
 * final submissions, so this stays on the plain click path.
 */
async function clickTriggerControl(el) {
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  try {
    await el.click({ timeout: 12000 });
    return true;
  } catch {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      await el.click({ timeout: 8000, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Walk a multi-step application form (Continue/Next -> ... -> Submit) for
 * portals that expose no single visible submit control. Intermediate steps are
 * clicked directly; a step whose label states submission intent goes through
 * the normal final-action guard instead. Returns a `stopped` reason rather than
 * throwing so the caller decides the recorded outcome.
 */
async function advanceMultiStepFlow(page, {
  ats, navBoundary, profile, job, finalGuard, maxSteps = 6, tag = "flow",
} = {}) {
  const navSelector = [
    "button:has-text('Continue')",
    "button:has-text('Next')",
    "button:has-text('Proceed')",
    "[role='button']:has-text('Continue')",
    "[role='button']:has-text('Next')",
  ].join(", ");
  for (let step = 0; step < maxSteps; step++) {
    if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) return { stopped: "redirect" };
    await fillCommonFields(page, ats, profile, job, navBoundary);
    const next = page.locator(navSelector).first();
    if ((await next.count()) === 0) return { stopped: "no-navigation" };
    const label = (((await next.innerText().catch(() => "")) || "")
      || (await next.getAttribute("aria-label").catch(() => ""))
      || (await next.getAttribute("value").catch(() => ""))).trim().slice(0, 60);
    // A navigation control must either be an explicit intermediate step or
    // state submission intent. Anything else is left untouched.
    if (!intermediateActionLabel(label) && !isSubmissionControlLabel(label)) {
      console.log(`  [${tag}] step ${step + 1}: refusing to click non-navigation control ("${label || "no label"})`);
      return { stopped: "non-navigation-label" };
    }
    if (await next.isDisabled().catch(() => true)) {
      console.log(`  [${tag}] step ${step + 1}: "${label}" disabled — a required input is missing`);
      return { stopped: "disabled" };
    }
    if (!intermediateActionLabel(label)) {
      const finalClick = await clickFinalControl(page, next, label, finalGuard);
      if (finalClick.captcha) return { stopped: "captcha" };
      if (!finalClick.clicked) {
        return { stopped: finalGuardAction(finalClick) || (finalClick.allowed ? "needs-verification" : "needs-review") };
      }
      await page.waitForTimeout(3000);
      return { stopped: "submitted" };
    }
    console.log(`  [${tag}] step ${step + 1}: clicking "${label}"`);
    await next.scrollIntoViewIfNeeded().catch(() => {});
    await next.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const confirmed = await page.evaluate(() =>
      /application submitted|you applied|application received|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|successfully applied/i.test(document.body?.innerText || "")
    ).catch(() => false);
    if (confirmed) return { stopped: "confirmed" };
  }
  return { stopped: "max-steps" };
}

// Every final control goes through this one guard. A live run without --auto
// may fill and advance intermediate steps, but it must never click a final
// application action on behalf of the user.
async function checkFinalActionGuards(options = {}) {
  const pageGuard = options.page?.[Symbol.for("pulseops.browserApplyGuard")] || null;
  const guard = { ...(pageGuard || {}), ...options };
  const dryRun = guard.dryRun ?? DRY_RUN;
  const auto = guard.auto ?? AUTO;
  if (!finalSubmissionAllowed({ dryRun, auto })) {
    return { allowed: false, reason: "auto-required" };
  }
  // Never submit an application that would carry invented contact details.
  const missingContact = missingContactFields(guard.profile);
  if (guard.profile && missingContact.length) {
    return { allowed: false, reason: "profile-incomplete", missing: missingContact };
  }
  if (typeof guard.page?.url === "function") {
    let currentUrl = "";
    try { currentUrl = guard.page.url(); } catch { return { allowed: false, reason: "redirect-blocked" }; }
    // Final actions are PII-bearing too.  A missing/insecure current URL is
    // never evidence that the page is safe, even when a caller omitted the
    // optional navigation-boundary object.
    if (!parseHttpUrl(currentUrl)) {
      return { allowed: false, reason: "redirect-blocked" };
    }
    if (guard.navigationBoundary
        && !isCurrentPageTrusted(currentUrl, guard.navigationBoundary.ats || "generic", guard.navigationBoundary)) {
      return { allowed: false, reason: "redirect-blocked" };
    }
  }
  const dbPath = guard.dbPath || resolveDbPath();
  const jobId = guard.jobId ?? guard.job_id ?? null;
  const ownerToken = guard.claimToken || guard.ownerToken || null;
  let state;
  if (typeof guard.pauseReader === "function") {
    const supplied = await guard.pauseReader(dbPath, jobId, ownerToken);
    state = supplied === true ? { available: true, paused: false, claimOwned: jobId ? true : null }
      : supplied === false ? { available: true, paused: true, claimOwned: false }
      : (supplied || { available: false, paused: true, claimOwned: false });
  } else {
    state = await readFinalActionState(dbPath, jobId, ownerToken);
  }
  if (!state.available || state.paused) {
    return { allowed: false, reason: state.reason || "send-paused", state };
  }
  if (jobId !== null && jobId !== undefined && jobId !== "" && state.claimOwned !== true) {
    return { allowed: false, reason: "claim-lost", state };
  }
  if (jobId !== null && jobId !== undefined && jobId !== "" && !ownerToken) {
    return { allowed: false, reason: "claim-required", state };
  }
  return { allowed: true, reason: "ready", state };
}

// Every final control goes through this one guard. A live run without --auto
// may fill and advance intermediate steps, but it must never click a final
// application action on behalf of the user.
async function clickFinalControl(page, locator, label, options = {}) {
  const guard = { ...(options || {}), page };
  const first = await checkFinalActionGuards(guard);
  if (!first.allowed) {
    if (first.reason === "auto-required") {
      console.log(`  [human-in-loop] final ${label} requires --auto; leaving it for the operator`);
    } else if (first.reason === "profile-incomplete") {
      console.log(`  [contact-block] not submitting "${label}": profile is missing ${(first.missing || []).join(", ")}`);
    } else {
      console.log(`  [final-block] ${label}: ${first.reason}`);
    }
    return { allowed: false, clicked: false, blocked: first.reason, reason: first.reason };
  }
  if (await hasCaptcha(page)) {
    console.log(`  [captcha] final ${label} is blocked until verification disappears`);
    if (!(await waitForCaptchaResolution(page))) {
      return { allowed: true, clicked: false, captcha: true };
    }
  }
  if (!locator || (await locator.count().catch(() => 0)) === 0) {
    return { allowed: true, clicked: false };
  }
  // An operator-authorised terms acceptance must land before the final click,
  // otherwise required-field validation silently swallows the submission.
  if (ACCEPT_TERMS) await acceptRequiredTerms(page).catch(() => []);

  const disabled = await locator.isDisabled().catch(() => true);
  if (disabled) {
    const missing = await describeMissingRequiredFields(page);
    const consents = await describeUncheckedConsents(page);
    const detail = [
      missing.length ? `unanswered required fields: ${missing.join(", ")}` : "",
      consents.length ? `consent boxes to tick: ${consents.join(" | ")}` : "",
    ].filter(Boolean).join("; ");
    console.log(`  [final-disabled] "${label}" is disabled${detail ? ` — ${detail}` : ""}`);
    if (consents.length) console.log("  [consent] terms/privacy checkboxes are a legal agreement and are never ticked automatically");
    return { allowed: true, clicked: false, disabled: true, missing, consents };
  }

  // Re-read both global pause and the exact claim after CAPTCHA/field work and
  // immediately before the final click. This closes the mid-run pause race.
  const last = await checkFinalActionGuards(guard);
  if (!last.allowed) {
    console.log(`  [final-block] ${label}: ${last.reason}`);
    return { allowed: false, clicked: false, blocked: last.reason, reason: last.reason };
  }
  try {
    // Sticky headers can cover a long form's submit control; scroll it into
    // view and allow a longer budget before giving up.
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await locator.click({ timeout: 15000 });
    console.log(`  [submit] clicked final ${label}`);
    return { allowed: true, clicked: true };
  } catch (e) {
    console.log(`  [submit] final ${label} click failed: ${String(e).slice(0, 100)}`);
    return { allowed: true, clicked: false, error: e };
  }
}

async function hasCaptcha(page) {
  try {
    for (const selector of CAPTCHA_SELECTORS) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      // Treat even a hidden challenge frame as present. A later visibility
      // check is safer than allowing a challenge to fall through unnoticed.
      if (count > 0) return true;
    }
    const bodyHit = await page.evaluate(() =>
      /verify you are human|additional verification required|checking your browser|complete the captcha/i.test(document.body?.innerText || "")
    ).catch(() => true);
    if (bodyHit) return true;
    for (const frame of page.frames?.() || []) {
      const frameHit = await frame.locator("body").innerText().catch(() => null);
      if (frameHit === null) return true;
      if (/verify you are human|additional verification required|checking your browser|complete the captcha/i.test(frameHit)) return true;
    }
    return false;
  } catch (e) {
    console.log(`  [captcha] challenge probe failed; fail closed: ${String(e).slice(0, 100)}`);
    return true;
  }
}

async function waitForCaptchaResolution(page) {
  try {
    if (!(await hasCaptcha(page))) return true;
    if (DRY_RUN) return false;
    const started = Date.now();
    let announced = false;
    while (await hasCaptcha(page)) {
      if (Date.now() - started >= CAPTCHA_WAIT_MS) return false;
      if (!announced) {
        console.log(`  [captcha] verification is still present; waiting up to ${Math.ceil(CAPTCHA_WAIT_MS / 1000)}s`);
        if (!HEADED) console.log("    (run with --headed to solve it manually)");
        announced = true;
      }
      await page.waitForTimeout(1000).catch(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    }
    return true;
  } catch (e) {
    // A failed challenge probe is not evidence that verification disappeared.
    console.log(`  [captcha] challenge probe failed; blocking: ${String(e).slice(0, 100)}`);
    return false;
  }
}

async function fillCommonFields(page, ats, profile, job, originUrl = null) {
  const currentUrl = typeof page?.url === "function" ? page.url() : "";
  // Autofill sends PII, so dry-run and live mode share the same HTTPS
  // same-origin gate.  A missing boundary is never treated as a preview
  // exemption.
  if (!originUrl || !currentUrl || !isCurrentPageTrusted(currentUrl, ats, originUrl)) {
    console.log("  [fill] blocked: page is not a trusted HTTPS origin");
    return false;
  }
  if (await hasCrossOriginFormOrFrame(page, originUrl)) {
    console.log("  [fill] blocked: cross-origin form/iframe target detected");
    return false;
  }
  const candidate = profile.candidate || {};
  const fullName = candidate.name || "";
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ") || "User";
  // After an approved off-site hop the page is a corporate careers site, so the
  // originating ATS field set (e.g. LinkedIn's) no longer describes it. Use the
  // generic set, which covers split first/last name fields.
  const onExternalHost = onExternalAts(originUrl);
  const effectiveAts = onExternalHost ? "generic" : ats;
  const sels = ATS_SELECTORS[effectiveAts]?.fields || ATS_SELECTORS.generic.fields;

  // Try name fields (split or combined)
  if (sels.firstName) await tryFill(page, sels.firstName, firstName);
  if (sels.lastName)  await tryFill(page, sels.lastName, lastName);
  if (sels.name)      await tryFill(page, sels.name, fullName);
  if (sels.email)     await tryFill(page, sels.email, candidate.email || "");
  // Never invent a phone number for a live application. Leave the field empty
  // and let the final-action guard refuse the submit instead.
  if (sels.phone)     await tryFill(page, sels.phone, candidate.phone || "");

  // LinkedIn / website if present
  await tryFill(page, ['input[name*="linkedin"]', 'input[autocomplete="url"]'], candidate.linkedin || "");
  await tryFill(page, ['input[name*="portfolio"]', 'input[name*="website"]'], candidate.portfolio || "");

  // Cover letter: use HQ recommendation if available (generic placeholder)
  if (sels.cover) {
    const cover = `Dear Hiring Manager,\n\nI am excited to apply for ${job.title} at ${job.company}. My background in ${profile.domain?.title || "Backend Engineering"} aligns closely with this role.\n\nBest regards,\n${fullName}`;
    await tryFill(page, sels.cover, cover);
  }
  return true;
}

async function hasVisibleAppliedBadge(page) {
  const pageHit = await page.evaluate(() => {
    const statusText = /^(applied|already applied|application submitted|application sent|you applied)$/i;
    const statusAria = /^(applied|already applied|application submitted|application sent|you applied)/i;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const nodes = [...document.querySelectorAll("button, a, [role='button'], [role='status'], span, div")];
    const body = (document.body?.innerText || "").replace(/\s+/g, " ");
    const strong = /you (?:already )?applied|application (?:submitted|sent)|applied successfully|applied on/i.test(body)
      && !/apply now|apply for this job|not applied/i.test(body);
    // A search or results page shows many postings. A bare "Applied" chip
    // there belongs to a different job and must never mark this row verified.
    const jobLinks = [...document.querySelectorAll('a[href*="/jobs/"], a[href*="/role/"], a[href*="/company/"]')]
      .filter(visible).length;
    const multiJob = jobLinks > 1;
    if (multiJob && !strong) return false;
    if (!multiJob && nodes.some((el) => visible(el) && statusText.test((el.innerText || el.textContent || "").trim().replace(/\s+/g, " ")))) return true;
    return strong || nodes.some((el) => visible(el) && statusAria.test((el.getAttribute("aria-label") || "").trim()));
  }).catch(() => false);
  if (pageHit) return true;
  for (const frame of page.frames?.() || []) {
    const hit = await frame.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      return /^(applied|already applied|application submitted|application sent|you applied)$/i.test(text)
        || /you (?:already )?applied|application (?:submitted|sent)|applied successfully/i.test(text);
    }).catch(() => false);
    if (hit) return true;
  }
  return false;
}

// Naukri Campus periodically injects a full-screen Young Turk contest promo.
// It can render inside a same-origin iframe and its close icon is often an
// unlabelled SVG, so ordinary [class*=close] selectors miss it.
async function dismissNaukriOverlays(page) {
  const markerPattern = /India.?s biggest skill contest|Get noticed by top companies|Enrol now/i;
  for (let attempt = 0; attempt < 3; attempt++) {
    let frame = null;
    let marker = null;
    for (const candidate of page.frames()) {
      const loc = candidate.getByText(markerPattern).last();
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
        frame = candidate;
        marker = loc;
        break;
      }
    }
    if (!marker) return attempt > 0;

    if (attempt === 0) {
      await marker.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      if (!(await marker.isVisible().catch(() => false))) {
        console.log("  [overlay] dismissed Naukri promo with Escape");
        return true;
      }
    }

    const closeSelectors = [
      '[aria-label*="close" i]', '[title*="close" i]',
      'button:has-text("✕")', 'button:has-text("×")',
      '[class*="close" i]',
    ];
    let clicked = false;
    for (const selector of closeSelectors) {
      const close = frame.locator(selector).first();
      if (await close.count().catch(() => 0) && await close.isVisible().catch(() => false)) {
        if (await close.click({ timeout: 2500, force: true }).then(() => true).catch(() => false)) {
          clicked = true;
          break;
        }
      }
    }

    // Verified Young Turk geometry: the "Enrol now" button is centred near the
    // bottom and the unlabelled X is about (+290, -395) pixels from its centre.
    if (!clicked) {
      const box = await marker.boundingBox().catch(() => null);
      if (box) {
        const x = Math.min(1240, box.x + box.width / 2 + 290);
        const y = Math.max(8, box.y - 395);
        await page.mouse.click(x, y).catch(() => {});
        clicked = true;
      }
    }

    await page.waitForTimeout(800);
    if (!(await marker.isVisible().catch(() => false))) {
      console.log("  [overlay] dismissed Naukri Young Turk promo");
      return true;
    }
    if (!clicked) break;
  }
  console.log("  [overlay] warning: Naukri promo remained open; apply click may be intercepted");
  return false;
}

function attachPreparedRuntime(job, prepared = {}) {
  if (!job || !prepared?.allowed) return job;
  const dbPath = prepared.dbPath || prepared.guard?.dbPath || null;
  const claimToken = prepared.claimToken || prepared.guard?.claimToken || null;
  if (dbPath) {
    job._db_path = dbPath;
    job._dbPath = dbPath;
  }
  if (claimToken) {
    job._claimToken = claimToken;
    job._claim_token = claimToken;
  }
  return job;
}

async function prepareJobRuntime(job, runtime = {}) {
  const dbPath = runtime.dbPath || job?._db_path || job?._dbPath || null;
  const jobId = runtime.jobId ?? runtime.job_id ?? job?.job_id ?? job?.id ?? null;
  const isManual = !!(job?.manual_url || job?._manual_url);
  if (DRY_RUN) {
    return {
      allowed: true,
      guard: { dryRun: true, auto: AUTO, dbPath, jobId: null, claimToken: null },
    };
  }

  if (isManual) {
    const pause = await manualUrlDatabaseGuard({ dbPath, dryRun: false });
    if (!pause.allowed) {
      return { allowed: false, reason: pause.reason || "send-paused", dbPath: pause.dbPath || null };
    }
    job._db_path = pause.dbPath;
    return {
      allowed: true,
      dbPath: pause.dbPath,
      guard: { dryRun: false, auto: AUTO, dbPath: pause.dbPath, jobId: null, claimToken: null },
    };
  }

  if (jobId === null || jobId === undefined || jobId === "") {
    return { allowed: false, reason: "claim-required" };
  }
  const selectedDb = dbPath || getAuthoritativeDbPath();
  if (!isExistingDbPath(selectedDb)) {
    return { allowed: false, reason: "db-missing", dbPath: selectedDb || null };
  }
  // An explicit --job-id is not an override switch. Re-run every durable
  // eligibility guard here, immediately before claiming, so a manually
  // supplied row cannot bypass score/status/pause/simulation policy.
  if (!isEligibleJob(job, { explicit: true })) {
    return { allowed: false, reason: "job-not-eligible", dbPath: selectedDb };
  }
  let claimToken = runtime.claimToken || runtime.ownerToken || job?._claimToken || job?._claim_token || null;
  if (!claimToken) {
    claimToken = randomUUID();
    const claim = await claimJobForApply(jobId, { dbPath: selectedDb, ownerId: claimToken });
    if (!claim.claimed) {
      return { allowed: false, reason: claim.reason || "claim-blocked", dbPath: selectedDb, claim };
    }
    job._claimToken = claimToken;
    job._claim_token = claimToken;
  }
  const state = await readFinalActionState(selectedDb, jobId, claimToken);
  if (!state.available || state.paused || state.claimOwned !== true) {
    return { allowed: false, reason: state.reason || "claim-lost", dbPath: selectedDb, claimToken, state };
  }
  job._db_path = selectedDb;
  job._dbPath = selectedDb;
  job._claimToken = claimToken;
  job._claim_token = claimToken;
  return {
    allowed: true,
    dbPath: selectedDb,
    claimToken,
    guard: { dryRun: false, auto: AUTO, dbPath: selectedDb, jobId, claimToken },
  };
}

function finalGuardAction(result) {
  const reason = result?.blocked || result?.reason || "";
  if (["send-paused", "db-missing", "settings-unavailable", "pause-query-failed"].includes(reason)) return "send-paused";
  if (["claim-lost", "claim-required", "claim-blocked"].includes(reason)) return "claim-blocked";
  if (reason === "redirect-blocked") return "redirect-blocked";
  if (reason === "profile-incomplete") return "profile-incomplete";
  if (result?.error) return "needs-verification";
  return null;
}

// Contact details are factual claims to an employer. A missing value must stop
// the submission rather than be replaced by a placeholder, because a recruiter
// cannot reach a fabricated number and the application is misrepresenting the
// candidate.
const REQUIRED_CONTACT_FIELDS = ["name", "email", "phone"];

function missingContactFields(profile) {
  const candidate = profile?.candidate || {};
  return REQUIRED_CONTACT_FIELDS.filter((field) => !String(candidate[field] || "").trim());
}

async function processJob(browser, job, profile, runtime = {}) {
  const url = String(job.link || job.url || "");
  const ats = inferATS(url);
  const navBoundary = createNavigationBoundary(url, ats);
  const resumePdf = findResumePdf(job.company, job.title, job.pdf_path);
  console.log(`\n[Job] ${job.company} — ${job.title}`);
  console.log(`  URL: ${url}`);
  console.log(`  ATS: ${ats} | PDF: ${resumePdf ? path.basename(resumePdf) : "none (will use generic)"}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN (no submit)" : AUTO ? "LIVE (AUTO final actions enabled)" : "LIVE (manual final action required)"}`);

  // Validate the initial URL before runtime/claim work, context creation, or
  // page navigation.  This is deliberately true in dry-run: previewing an
  // HTTP job must not turn into a plaintext request or browser session.
  if (!isAllowedInitialJobUrl(url)) {
    console.log("  [redirect-block] initial job URL must be HTTPS before any page interaction");
    return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
  }

  if (isSimulationJob(job)) {
    console.log("  [simulation-guard] durable simulation/mock marker — refusing browser apply");
    return { company: job.company, title: job.title, link: url, ats, action: "simulation-blocked", pdf: resumePdf };
  }

  if (!url || /example\.com/i.test(url) || MOCK_ONLY) {
    console.log(`  [mock] dry-run preview — would open ${url}`);
    await new Promise(r=>setTimeout(r, 200));
    return { company: job.company, title: job.title, link: url, ats, action: "mock-preview", pdf: resumePdf };
  }

  // Claim DB-backed jobs before early terminal/precondition returns. This
  // lets auth-wall, invalid-host, and dead-link outcomes persist against the
  // exact claim instead of leaving the row Evaluated forever.
  const prepared = await prepareJobRuntime(job, runtime);
  if (!prepared.allowed) {
    console.log(`  [${prepared.reason || "guard-block"}] no page opened for ${job.company}`);
    return {
      company: job.company,
      title: job.title,
      link: url,
      ats,
      action: prepared.reason === "claim-blocked" || prepared.reason === "claim-lost" || prepared.reason === "claim-required" ? "claim-blocked" : "send-paused",
      pdf: resumePdf,
      claimToken: prepared.claimToken || job?._claimToken || null,
    };
  }
  const finalGuard = { ...(prepared.guard || {}), navigationBoundary: navBoundary, profile };
  if (!DRY_RUN) {
    const beforeOpen = finalGuard.jobId
      ? await readFinalActionState(finalGuard.dbPath, finalGuard.jobId, finalGuard.claimToken)
      : await readSendPause(finalGuard.dbPath);
    if (!beforeOpen.available || beforeOpen.paused
        || (finalGuard.jobId && beforeOpen.claimOwned !== true)) {
      console.log(`  [${beforeOpen.reason || "send-paused"}] page opening refused`);
      return {
        company: job.company,
        title: job.title,
        link: url,
        ats,
        action: beforeOpen.paused || !beforeOpen.available ? "send-paused" : "claim-blocked",
        pdf: resumePdf,
        claimToken: finalGuard.claimToken || null,
      };
    }
  }

  if (ats === "indeed" && !INCLUDE_INDEED) {
    console.log("  [portal-disabled] Indeed is disabled by user; use --include-indeed only for a deliberate manual override");
    return { company: job.company, title: job.title, link: url, ats, action: "portal-disabled", pdf: resumePdf };
  }

  // The YC scraper can also emit category and company pages. They are not
  // application listings and must never enter the browser submit path.
  if (ats === "yc" && !/\/jobs\/\d+(?:[/?#]|$)/i.test(url)) {
    console.log("  [invalid] YC category/company URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Ashby company boards (jobs.ashbyhq.com/<company>) list many roles and have
  // no application form. Treating them as a listing burns the row every run.
  if (ats === "ashby" && !isAshbyJobListing(url)) {
    console.log("  [invalid] Ashby company board URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Greenhouse company boards behave the same way.
  if (ats === "greenhouse" && !isGreenhouseJobListing(url)) {
    console.log("  [invalid] Greenhouse company board URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Lever company boards behave the same way.
  if (ats === "lever" && !isLeverJobListing(url)) {
    console.log("  [invalid] Lever company board URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Naukri search/category pages are not listings either.
  if (ats === "naukri" && !isNaukriJobListing(url)) {
    console.log("  [invalid] Naukri search URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Wellfound search/category pages are not listings either.
  if (ats === "wellfound" && !isWellfoundJobListing(url)) {
    console.log("  [invalid] Wellfound search URL is not an application listing — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "invalid-listing", pdf: resumePdf };
  }

  // Simulated rows must never reach a live submission path.
  if (hasSimulationFragment(url)) {
    console.log("  [invalid] URL carries a simulation marker — skipping");
    return { company: job.company, title: job.title, link: url, ats, action: "simulation-blocked", pdf: resumePdf };
  }

  if (!isAllowedNavigationUrl(url, ats, navBoundary)) {
    console.log("  [redirect-block] initial URL is outside the strict ATS allowlist");
    return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
  }

  const hasSession = fs.existsSync(path.join(ROOT, "portal", "storageState.json"));
  if ((ats === "linkedin" || ats === "naukri") && !hasSession) {
    console.log(`  [authwall-skip] ${ats} needs portal/storageState.json — run: node portal/save_sessions.mjs`);
    return { company: job.company, title: job.title, link: url, ats, action: "authwall-skip", pdf: resumePdf };
  }

  // Cheap pre-flight: classify the page over plain HTTP first. Unstyled
  // server-rendered pages can be read (and salary-checked) with no browser.
  const pageProbe = await probeJobPage(url);
  if (pageProbe.mode === BASIC_HTML) {
    console.log(`  [probe] basic HTML page (${pageProbe.reason}) — ${pageProbe.signals.textLength} chars of text`);
  } else if (pageProbe.mode !== "unavailable") {
    console.log(`  [probe] needs a browser (${pageProbe.reason})`);
  }

  // EDGE mode: share one persistent Edge context across jobs (never close it)
  const context = sharedCtx || await browser.newContext({
    viewport: { width: 1366, height: 900 },
    // Use headed storageState if exists for logged-in portals (Naukri/LinkedIn)
    storageState: hasSession ? path.join(ROOT, "portal", "storageState.json") : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page[Symbol.for("pulseops.browserApplyGuard")] = finalGuard;
  try {
    await installNavigationGuard(page, ats, navBoundary);
  } catch (e) {
    console.log(`  [redirect-block] could not install navigation guard: ${String(e).slice(0, 100)}`);
    if (!sharedCtx) await context.close();
    return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
  }

  try {
    console.log(`  [nav] goto ${url.slice(0,90)}`);
    if (!(await navigateAllowed(page, url, ats, navBoundary))) {
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
    }
    await waitForApplicationSurface(page, 30000);
    await page.waitForTimeout(1500);
    if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
      console.log("  [redirect-block] page changed origin before overlay handling");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
    }
    // Naukri Campus can cover the job page with a Young Turk contest promo.
    await dismissNaukriOverlays(page);
    if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
      console.log("  [redirect-block] page changed origin before form interaction");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
    }
    // A server-side Applied badge is authoritative for the human-facing ATSs.
    // Check it before opening another application modal (including the Naukri
    // Young Turk flow) and record a verified, idempotent outcome.
    if (HUMAN_FINAL_STATUSES.has(ats) && !(await hasCaptcha(page)) && await hasVisibleAppliedBadge(page)) {
      console.log(`  [${ats}] server-side Applied badge already present — recording verified submission`);
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "verified", verifiedBy: "server-badge", pdf: resumePdf };
    }

    // Dead-listing guard: never attempt submits on 404/expired job pages
    const deadHit = await page.evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 2000);
      return /404|page not found|unable to load the page|may not be valid|posting has been removed|job (?:posting )?(?:has been|was) removed|no longer exists|no longer available|no longer accepting applications|no longer open|job (?:you are trying to view )?(?:has |is |was )?expired|position (has been )?filled|this job is (?:no longer|closed)|job is closed|posting (?:has )?ended/i.test(t);
    }).catch(() => false);
    if (deadHit && !(await hasCaptcha(page))) {
      console.log("  [dead] job page is 404/expired — skipping (mark for DB cleanup)");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dead-link", pdf: resumePdf };
    }

    // A posting that states pay under the floor is not worth an application.
    const salaryBlock = await rejectLowStatedSalary(page, job, pageProbe);
    if (salaryBlock) {
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: salaryBlock.action, pdf: resumePdf };
    }

    // A CAPTCHA is a hard stop. In live/auto mode the only way onward is an
    // actual disappearance of the challenge; a timeout or stale marker returns
    // captcha-blocked and can never fall through to Apply/Submit.
    if (await hasCaptcha(page)) {
      console.log(`  [captcha] CAPTCHA/Challenge detected — waiting for verification to disappear`);
      if (!HEADED) console.log("    (run with --headed to solve manually)");
      await page.screenshot({ path: path.join(ROOT, `output/apply-${String(job.company || "job").replace(/\W/g,"_")}-captcha.png`), fullPage: true }).catch(()=>{});
      if (!(await waitForCaptchaResolution(page))) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
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
    let applyNavigation = await detectAndClickApply(page, ats, navBoundary, finalGuard);
    // After an approved off-site hop the page is a corporate careers site, so
    // the originating ATS selectors no longer exist. Re-detect with the
    // generic set (e.g. "Apply for this role"). The hop itself already counts
    // as a click, so this must not depend on that flag.
    if (!applyNavigation.blocked && onExternalAts(navBoundary)) {
      const retry = await detectAndClickApply(page, "generic", navBoundary, finalGuard);
      if (retry.clicked) applyNavigation = retry;
    }
    // Opening the form is racy: the trigger may only scroll to a lazily
    // rendered section, a cookie notice can cover it, and hydration timing
    // varies. Retry the trigger and wait for real fields before giving up.
    if (!applyNavigation.blocked) {
      let surfaceReady = false;
      for (let attempt = 1; attempt <= 3 && !surfaceReady; attempt++) {
        await dismissConsentBanners(page);
        surfaceReady = await waitForApplicationSurface(page, 12000);
        if (surfaceReady) break;
        console.log(`  [form-open] attempt ${attempt}: form not rendered, re-triggering Apply`);
        const again = await detectAndClickApply(page, onExternalAts(navBoundary) ? "generic" : ats, navBoundary, finalGuard);
        if (again.blocked) break;
      }
      if (surfaceReady) await fillCommonFields(page, ats, profile, job, navBoundary);
    }
    if (applyNavigation.blocked) {
      if (!sharedCtx) await context.close();
      const action = ["send-paused", "claim-blocked", "claim-lost"].includes(applyNavigation.reason)
        ? applyNavigation.reason
        : (applyNavigation.reason === "unknown-control" || applyNavigation.reason === "trigger-failed" ? "needs-review" : "redirect-blocked");
      return { company: job.company, title: job.title, link: url, ats, action, pdf: resumePdf };
    }
    if (applyNavigation.missingState === "closed-listing") {
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dead-link", pdf: resumePdf };
    }
    if (applyNavigation.missingState === "external-apply") {
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "manual-submit-required", pdf: resumePdf };
    }
    if (applyNavigation.finalAction) {
      const finalClick = applyNavigation.finalClick || {};
      if (finalClick.captcha) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
      }
      if (!finalClick.clicked) {
        if (!sharedCtx) await context.close();
        const action = DRY_RUN ? "dry-run-preview"
          : (finalClick.blocked === "send-paused" || finalClick.blocked === "db-missing" ? "send-paused"
            : (finalClick.blocked === "claim-lost" || finalClick.blocked === "claim-required" ? "claim-blocked"
              : (finalClick.error ? "needs-verification" : "needs-review")));
        return { company: job.company, title: job.title, link: url, ats, action, pdf: resumePdf };
      }
      await page.waitForTimeout(2500);
      if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "needs-verification", pdf: resumePdf };
      }
      const confirmed = await hasVisibleAppliedBadge(page) || await page.evaluate(() =>
        /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
      ).catch(() => false);
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: confirmed ? "verified" : "needs-verification", pdf: resumePdf };
    }
    await page.waitForTimeout(1500);
    if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
    }
    if (await hasCaptcha(page)) {
      await page.screenshot({ path: path.join(ROOT, `output/apply-${String(job.company || "job").replace(/\W/g,"_")}-captcha.png`), fullPage: true }).catch(()=>{});
      if (!(await waitForCaptchaResolution(page))) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
      }
    }
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
          const retryLabel = ((await retry.innerText().catch(() => "")) || "Apply").trim();
          const retryType = typeof retry.getAttribute === "function" ? await retry.getAttribute("type").catch(() => "") : "";
          const retryClass = classifyApplyControl({
            label: retryLabel,
            selector: "button#apply-button",
            oneStep: await pageHasOneStepApplicationForm(page),
            isSubmit: retryType === "submit",
          });
          if (retryClass.final) {
            const retryFinal = await clickFinalControl(page, retry, retryLabel, finalGuard);
            if (!retryFinal.clicked) {
              if (!sharedCtx) await context.close();
              return {
                company: job.company,
                title: job.title,
                link: url,
                ats,
                action: retryFinal.blocked === "send-paused" ? "send-paused" : "needs-review",
                pdf: resumePdf,
              };
            }
          } else if (retryClass.intermediate) {
            await retry.click({ timeout: 5000, force: true });
          } else {
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: "needs-review", pdf: resumePdf };
          }
          await page.waitForTimeout(3000);
        } else break;
      }
      if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
      }
      if (!opened) {
        const appliedNow = await page.evaluate(() => /successfully applied|you have successfully applied/i.test(document.body?.innerText || ""));
        console.log(appliedNow ? "  [naukri-chat] already applied" : "  [naukri-chat] chat did not open — aborting");
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: appliedNow ? "verified" : "needs-review", pdf: resumePdf };
      }
    }

    const screenshotPath = path.join(ROOT, "output", `apply-preview-${job.company.replace(/\W/g,"_")}-${Date.now()}.png`);
    let chatNeedsUser = [];
    fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });

    // YC / Wellfound "reach out" modal: written answer(s) (50-char minimum)
    // + Send. Drafted per-job by Gemini from cv.md (portal/yc_answers.py).
    // Wellfound uses the identical pattern ("Send application" button).
    if (ats === "yc" || ats === "wellfound") {
      await page.waitForTimeout(2500);
      if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
      }
      if (await hasCrossOriginFormOrFrame(page, navBoundary)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "needs-review", pdf: resumePdf };
      }
      const nAreas = await page.locator("textarea").count().catch(() => 0);
      const modalOpen = nAreas > 0 || await page.evaluate(() =>
        /reach out to the team|start a conversation with the team/i.test(document.body?.innerText || "")
      ).catch(() => false);
      if (modalOpen && nAreas > 0) {
        // Wellfound location gate: "This job does not support the locations on
        // your profile" disables the answer box until you pick a location
        // option. Only ever claims relocation with explicit user approval.
        if (ats === "wellfound") {
          const gate = await page.evaluate(() =>
            /does not support the locations on your profile/i.test(document.body?.innerText || "")
          ).catch(() => false);
          if (gate) {
            console.log(`  [yc] location gate present — claiming relocate (user-approved)`);
            await page.evaluate(() => {
              const radios = [...document.querySelectorAll('input[type="radio"]')];
              for (const r of radios) {
                const wrap = (r.closest("label")?.innerText || r.parentElement?.innerText || "").trim();
                if (/i can relocate to/i.test(wrap) && !r.checked) r.click();
              }
            }).catch(() => {});
            await page.waitForTimeout(1500);
            // react-select location box: type prefix, click the option (verified
            // 2026-09-23: "Bang" -> "Bangalore Urban"; empty query opens nothing)
            try {
              // Focus via JS (react-select input is often 0-opacity; Playwright
              // visibility checks refuse it), then type with the keyboard.
              await page.evaluate(() => {
                const ctrl = document.querySelector("[class*='select__control']");
                const inp = ctrl ? ctrl.querySelector("input") : document.querySelector("[class*='select__control'] input");
                if (inp) { inp.scrollIntoView({ block: "center" }); inp.focus(); }
              }).catch(() => {});
              await page.waitForTimeout(800);
              await page.keyboard.type("Bang", { delay: 80 }).catch(() => {});
              await page.waitForTimeout(2500);
              const opt = page.locator("[class*='select__option']").filter({ hasText: /bangalore|bengaluru/i }).first();
              if ((await opt.count()) > 0) {
                await opt.click({ timeout: 5000 });
                console.log(`  [yc] location set to Bangalore Urban`);
              } else {
                console.log(`  [yc] no Bangalore option appeared`);
              }
              await page.waitForTimeout(2000);
            } catch (e) { console.log(`  [yc] location pick failed: ${String(e).slice(0, 80)}`); }
          }
        }
        console.log(`  [yc] outreach modal open with ${nAreas} textarea(s) — drafting answers`);
        let answers = null;
        try {
          const { execFileSync } = await import("node:child_process");
          const roleSnippet = await page.evaluate(() =>
            (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 800)
          ).catch(() => "");
          const helper = path.join(ROOT, "portal", "yc_answers.py");
          // Scraped text is passed as an argv value, never interpolated into a
          // shell command. execFileSync does not invoke a command shell.
          const out = execFileSync("python", [
            helper,
            String(job.company || ""),
            String(job.title || ""),
            String(roleSnippet || ""),
          ], {
            cwd: ROOT,
            encoding: "utf-8",
            timeout: 120000,
            windowsHide: true,
            shell: false,
          });
          answers = JSON.parse(out.trim().split(/\r?\n/).pop());
        } catch (e) { console.log(`  [yc] answer drafting failed: ${String(e).slice(0, 120)}`); }
        if (answers) {
          const keys = ["intro", "built", "why"];
          for (let i = 0; i < Math.min(nAreas, 3); i++) {
            const area = page.locator("textarea").nth(i);
            const text = answers[keys[i]] || "";
            try {
              await area.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
              await area.click({ timeout: 8000 });
              await area.fill(text, { timeout: 8000 });
            } catch (e) {
              // Fallback: JS focus + value set + input events (modals/overlays)
              await page.evaluate(([idx, val]) => {
                const t = document.querySelectorAll("textarea")[idx];
                if (!t) return;
                t.scrollIntoView({ block: "center" });
                t.focus();
                document.execCommand("selectAll", false, null);
                document.execCommand("insertText", false, val);
                t.dispatchEvent(new Event("input", { bubbles: true }));
                t.dispatchEvent(new Event("change", { bubbles: true }));
              }, [i, text]).catch(() => {});
            }
            const gotLen = await page.evaluate((idx) =>
              ((document.querySelectorAll("textarea")[idx] || {}).value || "").length, i
            ).catch(() => -1);
            console.log(`  [yc] textarea ${i + 1}: target ${text.length} chars, actual ${gotLen}`);
          }
          await page.waitForTimeout(1500);
          const sendBtn = page.locator('button:has-text("Send application"), button:has-text("Send")').first();
          let sent = false;
          let clickError = false;
          if (DRY_RUN) {
            console.log(`  [DRY-RUN] YC answers drafted — would click Send (use --live)`);
          } else if ((await sendBtn.count()) > 0) {
            const lens = await page.evaluate(() =>
              [...document.querySelectorAll("textarea")].map((t) => (t.value || "").length)
            ).catch(() => []);
            const answersReady = lens.length >= nAreas && lens.slice(0, nAreas).every((length) => length >= 50);
            console.log(`  [yc] textarea lens: ${JSON.stringify(lens)}; ready=${answersReady}`);
            if (!answersReady) {
              console.log("  [yc] answers are incomplete — refusing final Send");
            } else {
              const sendLabel = ((await sendBtn.innerText().catch(() => "Send application")) || "Send application").trim();
              const clicked = await clickFinalControl(page, sendBtn, sendLabel, finalGuard);
              if (clicked.captcha) {
                if (!sharedCtx) await context.close();
                return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
              }
              const guardAction = finalGuardAction(clicked);
              if (guardAction) {
                if (!sharedCtx) await context.close();
                return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
              }
              clickError = !!clicked.error;
              sent = clicked.clicked;
              if (sent) {
                await page.waitForTimeout(3000);
                if (await hasCaptcha(page)) {
                  if (!(await waitForCaptchaResolution(page))) {
                    if (!sharedCtx) await context.close();
                    return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
                  }
                }
                await page.waitForTimeout(2000);
              }
            }
          } else {
            console.log("  [yc] Send button not found — refusing an unverified submission");
          }
          if (DRY_RUN) {
            await page.screenshot({ path: screenshotPath.replace("preview", "yc-final"), fullPage: false }).catch(() => {});
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: "dry-run-preview", pdf: resumePdf };
          }
          if (!sent) {
            const ycAction = clickError ? "needs-verification" : "needs-review";
            console.log(`  [yc] final Send was not clicked; recording ${ycAction}`);
            await page.screenshot({ path: screenshotPath.replace("preview", "yc-final"), fullPage: false }).catch(() => {});
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: ycAction, pdf: resumePdf };
          }
          if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
          }
          const postSend = await page.evaluate(() =>
            (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400)
          ).catch(() => "");
          const modalGone = await page.evaluate(() =>
            [...document.querySelectorAll("textarea")].length === 0
          ).catch(() => false);
          const serverApplied = await hasVisibleAppliedBadge(page);
          const ycDone = serverApplied || (modalGone && /message sent|application sent|we'll be in touch|thanks for reaching out|successfully/i.test(postSend));
          console.log(`  [yc] post-send check: done=${ycDone} modalGone=${modalGone} :: ${postSend.slice(0, 180)}`);
          await page.screenshot({ path: screenshotPath.replace("preview", "yc-final"), fullPage: false }).catch(() => {});
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: ycDone ? "verified" : "needs-verification", pdf: resumePdf };
        }
        console.log(`  [yc] modal open but answers unavailable — leaving for user`);
        if (!DRY_RUN) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "needs-review", pdf: resumePdf };
        }
      } else {
        console.log(`  [yc] no outreach modal detected — continuing to generic submit`);
      }
    }

    if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
      console.log("  [redirect-block] refusing to fill a page outside the ATS allowlist");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
    }
    await fillCommonFields(page, ats, profile, job, navBoundary);
    if (await hasCaptcha(page)) {
      if (!(await waitForCaptchaResolution(page))) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
      }
    }
    const uploaded = await tryUpload(page, ATS_SELECTORS[ats]?.fields?.resume || ATS_SELECTORS.generic.fields.resume, resumePdf, ats, navBoundary);

    // A resume upload usually triggers a server-side parse that reveals the
    // real form only minutes later (e.g. Shine "Reading Your Resume"). Fields
    // were filled before the form existed, so wait for it and fill again —
    // otherwise required inputs such as phone stay empty and the final action
    // remains disabled.
    if (uploaded) {
      const formWaitMs = Number.parseInt(process.env.PULSEOPS_FORM_WAIT_MS || "150000", 10);
      if (await waitForApplicationSurface(page, Number.isFinite(formWaitMs) ? formWaitMs : 150000)) {
        await fillCommonFields(page, ats, profile, job, navBoundary);
        // Answer the candidate-only questions that gate a disabled final
        // action, using only values the candidate actually supplied.
        const answers = await answerCandidateQuestions(page, profile);
        if (answers.answered.length) console.log(`    [answer] completed: ${answers.answered.join(", ")}`);
        if (answers.unanswered.length) console.log(`    [answer] needs a human: ${answers.unanswered.join("; ")}`);
      }
    }

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
    console.log(`  [preview] screenshot → ${path.relative(ROOT, screenshotPath)}`);
    console.log(`  [preview] form URL: ${page.url().slice(0,120)}`);

    // Naukri chat apply: cookie banner + bot questionnaire (bot types first — wait for it).
    if (ats === "naukri" && !DRY_RUN) {
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
      let manualFinalRequired = false;
      let finalAttempted = false;
      for (let step = 0; step < 14; step++) {
        if (manualFinalRequired) break;
        if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
        }
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
                const saveLabel = ((await save.innerText().catch(() => "Save")) || "Save").trim();
                if (finalActionLabel(saveLabel)) {
                  const finalClick = await clickFinalControl(page, save, saveLabel, finalGuard);
                  if (finalClick.captcha) {
                    if (!sharedCtx) await context.close();
                    return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
                  }
                  if (!finalClick.clicked) {
                    const guardAction = finalGuardAction(finalClick);
                    if (guardAction) {
                      if (!sharedCtx) await context.close();
                      return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
                    }
                    manualFinalRequired = true;
                    break;
                  }
                  finalAttempted = true;
                  saved = true;
                  break;
                }
                console.log(`  [naukri-chat] unrecognised save control "${saveLabel}"; refusing it`);
                manualFinalRequired = true;
                break;
              }
              await page.waitForTimeout(1200);
            }
            if (saved) await page.waitForTimeout(2500);
            else console.log("  [naukri-chat] Save stayed disabled — answer may not have registered");
            if (manualFinalRequired || finalAttempted) break;
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
            const saveLabel = ((await save.innerText().catch(() => "Save")) || "Save").trim();
            if (finalActionLabel(saveLabel)) {
              const finalClick = await clickFinalControl(page, save, saveLabel, finalGuard);
              if (finalClick.captcha) {
                if (!sharedCtx) await context.close();
                return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
              }
              if (finalClick.clicked) {
                finalAttempted = true;
                await page.waitForTimeout(2500);
              } else {
                const guardAction = finalGuardAction(finalClick);
                if (guardAction) {
                  if (!sharedCtx) await context.close();
                  return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
                }
                manualFinalRequired = true;
              }
            } else {
              console.log(`  [naukri-chat] unrecognised save control "${saveLabel}"; refusing it`);
              manualFinalRequired = true;
            }
          }
          console.log(`  [naukri-chat] step ${step + 1}: typed ${filled.ans}`);
          if (manualFinalRequired || finalAttempted) break;
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
            if (finalActionLabel(label) && (DRY_RUN || !AUTO)) {
              manualFinalRequired = true;
              console.log(`  [naukri-chat] final option "${label}" requires --auto; leaving it for the operator`);
              break;
            }
            await btn.waitFor({ state: "visible", timeout: 2000 });
            await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            if (finalActionLabel(label)) {
              const finalClick = await clickFinalControl(page, btn, label, finalGuard);
              if (finalClick.captcha) {
                if (!sharedCtx) await context.close();
                return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
              }
              if (!finalClick.clicked) {
                const guardAction = finalGuardAction(finalClick);
                if (guardAction) {
                  if (!sharedCtx) await context.close();
                  return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
                }
                manualFinalRequired = true;
                break;
              }
              finalAttempted = true;
            } else {
              await btn.click({ timeout: 5000 });
            }
          } catch {
            if (finalActionLabel(label) && (DRY_RUN || !AUTO)) {
              manualFinalRequired = true;
              break;
            }
            if (finalActionLabel(label)) {
              manualFinalRequired = true;
              console.log("  [naukri-chat] final option could not be clicked safely; leaving it for review");
            } else {
              // Fallback for an intermediate option only. Final actions never
              // use this raw JS click path.
              await page.evaluate((t) => {
                const els = Array.from(document.querySelectorAll("button, a, [role='button'], div"));
                const el = els.find((e) => (e.innerText || "").trim() === t && e.offsetParent !== null);
                if (el) el.click();
              }, label).catch(() => {});
            }
          }
          await page.waitForTimeout(2500);
          // Verify the chat advanced (option gone); else retry next loop
          const stillThere = await page.locator(OPT(label)).first().count().catch(() => 1);
          clicked = label + (stillThere ? " (retry?)" : "");
          break;
        }
        if (manualFinalRequired || finalAttempted) break;
        if (clicked) {
          console.log(`  [naukri-chat] step ${step + 1}: answered "${clicked}"`);
          // After any chip answer, hit Save/Send if showing (chat often waits on it)
          await page.waitForTimeout(1500);
          const postSave = page.locator("button:has-text('Save'), button:has-text('Send'), button:has-text('Submit')").first();
          if ((await postSave.count()) > 0) {
            const postLabel = ((await postSave.innerText().catch(() => "")) || "Save").trim();
            if (finalActionLabel(postLabel) && (DRY_RUN || !AUTO)) {
              manualFinalRequired = true;
              console.log(`  [naukri-chat] final post-answer action "${postLabel}" requires --auto`);
            } else if (finalActionLabel(postLabel)) {
              const finalClick = await clickFinalControl(page, postSave, postLabel, finalGuard);
              if (finalClick.captcha) {
                if (!sharedCtx) await context.close();
                return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
              }
              if (finalClick.clicked) {
                finalAttempted = true;
                console.log("  [naukri-chat] clicked final post-answer action");
                await page.waitForTimeout(2500);
              } else {
                const guardAction = finalGuardAction(finalClick);
                if (guardAction) {
                  if (!sharedCtx) await context.close();
                  return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
                }
                manualFinalRequired = true;
              }
            } else {
              console.log(`  [naukri-chat] post-answer control "${postLabel}" is not recognised; refusing it`);
              manualFinalRequired = true;
            }
          }
          if (manualFinalRequired || finalAttempted) break;
          continue;
        }
        // No options: either done or bot still working — check success, else wait more
        const doneEarly = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent/i.test(document.body?.innerText || ""));
        if (doneEarly) break;
        const chatGone = await page.locator("button:has-text('Fresher'), button:has-text('Continue')").first().count().catch(() => 0);
        if (step > 4 && chatGone === 0) break;
        await page.waitForTimeout(2000);
      }
      const done = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent/i.test(document.body?.innerText || ""));
      if (done) {
        console.log("  [naukri-chat] SUCCESS — recording verified submission");
        await page.screenshot({ path: screenshotPath.replace("preview", "submitted"), fullPage: true }).catch(() => {});
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "verified", verifiedBy: "confirmation", pdf: resumePdf };
      }
      if (manualFinalRequired) {
        console.log("  [naukri-chat] final submission was not clicked; recording NeedsReview");
        await page.screenshot({ path: screenshotPath.replace("preview", "final-review"), fullPage: false }).catch(() => {});
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "needs-review", pdf: resumePdf, needsUser: chatNeedsUser };
      }
      console.log("  [naukri-chat] no success confirmation detected");
    }

    // Indeed smartapply: Continue through steps → Review (100%) → Submit application.
    if (ats === "indeed" && !DRY_RUN) {
      for (let step = 0; step < 6; step++) {
        if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
        }
        await fillCommonFields(page, ats, profile, job, navBoundary);
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
        const label = (((await next.innerText().catch(() => "")) || "").trim()
          || (await next.getAttribute("aria-label").catch(() => ""))
          || (await next.getAttribute("value").catch(() => ""))).slice(0, 60);
        const dis = await next.isDisabled().catch(() => true);
        if (dis) {
          console.log(`  [indeed] "${label}" disabled — missing required input, stopping`);
          break;
        }
        console.log(`  [indeed] step ${step + 1}: clicking "${label}"`);
        await next.scrollIntoViewIfNeeded().catch(() => {});
        let clicked = false;
        if (!intermediateActionLabel(label) && !isSubmissionControlLabel(label)) {
          console.log(`  [indeed] step ${step + 1}: refusing to click non-submit control ("${label}")`);
          break;
        }
        if (!intermediateActionLabel(label)) {
          const finalClick = await clickFinalControl(page, next, label, finalGuard);
          if (finalClick.captcha) {
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
          }
          if (!finalClick.clicked) {
            if (!sharedCtx) await context.close();
            const guardAction = finalGuardAction(finalClick);
            return { company: job.company, title: job.title, link: url, ats, action: guardAction || (finalClick.allowed ? "needs-verification" : "needs-review"), pdf: resumePdf };
          }
          clicked = true;
        } else {
          await next.click({ timeout: 5000 }).catch(() => {});
        }
        await page.waitForTimeout(2500);
        const done = await page.evaluate(() => /application submitted|you applied|application received|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent/i.test(document.body?.innerText || ""));
        if (done) break;
        if (clicked) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "needs-verification", pdf: resumePdf };
        }
      }
    }

    // LinkedIn Easy Apply is multi-step: Next (x N) → Review → Submit. Walk it.
    if (ats === "linkedin" && !DRY_RUN) {
      for (let step = 0; step < 5; step++) {
        if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
        }
        const next = page.locator("div[role='dialog'] button[aria-label='Continue to next step'], div[role='dialog'] button:has-text('Next'), button:has-text('Review your application')").first();
        if ((await next.count()) === 0) break;
        const label = ((await next.innerText().catch(() => "")) || "").trim().slice(0, 30);
        // Fill any visible inputs on this step before advancing
        await fillCommonFields(page, ats, profile, job, navBoundary);
        console.log(`  [easy-apply] step ${step + 1}: clicking "${label}"`);
        await next.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Most portals (Shine, Naukri-free aggregators, Greenhouse mirrors, custom
    // ATS front-ends) drive a multi-step form with no single submit control.
    // Walk it instead of stalling at "no Submit button detected".
    if (!DRY_RUN && !["linkedin", "naukri", "indeed"].includes(ats)) {
      const flow = await advanceMultiStepFlow(page, { ats, navBoundary, profile, job, finalGuard, tag: ats });
      if (flow.stopped === "redirect" || flow.stopped === "captcha") {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: flow.stopped === "captcha" ? "captcha-blocked" : "redirect-blocked", pdf: resumePdf };
      }
      if (flow.stopped === "submitted" || flow.stopped === "confirmed") {
        const ok = await page.evaluate(() =>
          /application submitted|you applied|application received|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|successfully applied/i.test(document.body?.innerText || "")
        ).catch(() => false);
        await page.screenshot({ path: screenshotPath.replace("preview", "submitted"), fullPage: true }).catch(() => {});
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: ok ? "verified" : "needs-verification", pdf: resumePdf };
      }
      if (["send-paused", "claim-blocked", "claim-lost", "needs-review", "needs-verification", "db-missing", "profile-incomplete"].includes(flow.stopped)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: flow.stopped, pdf: resumePdf };
      }
    }

    // Naukri chat flow already attempted submit above — don't re-click the covered Apply button
    if (ats === "naukri") {
      if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
      }
      const done = await page.evaluate(() => /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent/i.test(document.body?.innerText || ""));
      await page.screenshot({ path: screenshotPath.replace("preview", "final"), fullPage: false }).catch(() => {});
      if (!sharedCtx) await context.close();
      if (DRY_RUN) return { company: job.company, title: job.title, link: url, ats, action: "dry-run-preview", pdf: resumePdf, needsUser: chatNeedsUser };
      return { company: job.company, title: job.title, link: url, ats, action: done ? "verified" : "needs-verification", pdf: resumePdf, needsUser: chatNeedsUser };
    }

    if (await hasCaptcha(page)) {
      await page.screenshot({ path: path.join(ROOT, `output/apply-${String(job.company || "job").replace(/\W/g,"_")}-captcha.png`), fullPage: true }).catch(()=>{});
      if (!(await waitForCaptchaResolution(page))) {
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
      }
    }

    // Detect submit button
    const onExternalHost = onExternalAts(navBoundary);
    const submitSels = onExternalHost
      ? [...new Set([...(ATS_SELECTORS[ats]?.submitBtn || []), ...ATS_SELECTORS.generic.submitBtn])]
      : (ATS_SELECTORS[ats]?.submitBtn || ATS_SELECTORS.generic.submitBtn);
    let submitFound = false;
    for (const sel of submitSels) {
      const probe = await pickVisible(page.locator(sel));
      if ((await probe.count()) > 0) {
        const label = ((await probe.innerText().catch(() => "")) || "").trim().slice(0, 60);
        if (!isSubmissionControlLabel(label)) {
          console.log(`  [submit-skip] ${sel} is not an application submit (${label || "no label"})`);
          continue;
        }
        console.log(`  [found] Submit → ${sel} ("${label}")`);
        submitFound = true;
        break;
      }
    }
    if (!submitFound) console.log(`  [warn] no Submit button detected — site may use multi-step flow`);

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] would WAIT for approval, then click Submit — skipping (use --live to enable)`);
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dry-run-preview", pdf: resumePdf, screenshot: screenshotPath };
    }

    if (!AUTO) {
      console.log(`  [human-in-loop] final submit for ${job.company} requires --auto; no final click was made`);
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "needs-review", pdf: resumePdf };
    }

    console.log(`\n  [AUTO] --auto flag: submitting without prompt for ${job.company}`);
    let clicked = false;
    let clickError = false;
    let blockedFields = [];
    for (const sel of submitSels) {
      const el = await pickVisible(page.locator(sel));
      if ((await el.count()) > 0) {
        const label = ((await el.innerText().catch(() => sel)) || sel).trim().slice(0, 60);
        // Fail closed: a control only counts as the final submission when its
        // label states submission intent. Search/filter/consent submits are
        // never clicked on the user's behalf.
        if (!isSubmissionControlLabel(label)) {
          console.log(`  [submit-skip] refusing to click non-submit control ${sel} ("${label || "no label"}")`);
          continue;
        }
        const finalClick = await clickFinalControl(page, el, label || sel, finalGuard);
        if (finalClick.captcha) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "captcha-blocked", pdf: resumePdf };
        }
        const guardAction = finalGuardAction(finalClick);
        if (guardAction) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: guardAction, pdf: resumePdf };
        }
        if (finalClick.error) clickError = true;
        if (finalClick.disabled && Array.isArray(finalClick.missing)) {
          blockedFields = [...new Set([...blockedFields, ...finalClick.missing])];
        }
        if (finalClick.clicked) {
          clicked = true;
          await page.waitForTimeout(3000);
          if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
            if (!sharedCtx) await context.close();
            return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
          }
          await page.screenshot({ path: screenshotPath.replace("preview","submitted"), fullPage: true }).catch(()=>{});
          break;
        }
      }
    }
    if (!clicked) {
      console.log(blockedFields.length
        ? `  [needs-candidate] final action is blocked on candidate-only answers: ${blockedFields.join(", ")} — recording NeedsReview`
        : "  [warn] no clickable final Submit found — recording NeedsReview");
    }
    // Verify before claiming: a click alone is never treated as Applied.
    const serverApplied = clicked && HUMAN_FINAL_STATUSES.has(ats) && await hasVisibleAppliedBadge(page);
    let confirmed = clicked && (serverApplied || await page.evaluate(() =>
      /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
    ).catch(() => false));
    // A final click that lands on an SMS verification step is not a submission.
    // With --enter-otp the operator supplies the code they received.
    if (clicked && !confirmed) {
      const otp = await completeSmsVerification(page);
      if (otp.state === "submitted") {
        confirmed = true;
        await page.screenshot({ path: screenshotPath.replace("preview", "verified"), fullPage: true }).catch(() => {});
      } else if (otp.state === "not-present") {
        confirmed = false;
      }
    }
    // Diagnose before the context closes, otherwise the page is gone.
    if (clicked && !confirmed) {
      const empty = await describeEmptyEntryFields(page).catch(() => []);
      const consents = await describeUncheckedConsents(page).catch(() => []);
      if (empty.length) console.log(`  [blocked-by] empty fields still on the form: ${empty.join(", ")}`);
      if (consents.length) console.log(`  [consent] needs your tick: ${consents.join(" | ")}`);
      // A headed run can simply be finished by hand: hold the window open and
      // poll for the confirmation rather than dead-ending the row.
      if (OTP_PAUSE && (empty.length || consents.length)) {
        console.log(`  [handoff] finish this application in the browser window; waiting up to ${Math.round(OTP_PAUSE_MS / 1000)}s…`);
        const deadline = Date.now() + OTP_PAUSE_MS;
        while (Date.now() < deadline) {
          const done = await page.evaluate(() =>
            /application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received|submitted successfully/i.test(document.body?.innerText || "")
          ).catch(() => false);
          if (done) { confirmed = true; break; }
          await page.waitForTimeout(2000);
        }
        if (confirmed) console.log("  [handoff] confirmation seen — recording verified submission");
      }
    }
    if (!sharedCtx) await context.close();
    return { company: job.company, title: job.title, link: url, ats, action: confirmed ? "verified" : (clicked || clickError ? "needs-verification" : "needs-review"), pdf: resumePdf };
  } catch (e) {
    console.log(`  [error] ${e.message.slice(0,300)}`);
    try { await page.screenshot({ path: path.join(ROOT, `output/apply-error-${job.company.replace(/\W/g,"_")}.png`), fullPage: true }); } catch {}
    if (!sharedCtx) await context.close();
    return { company: job.company, title: job.title, link: url, ats, action: "error", error: e.message };
  }
}

async function loadJobsFromDB() {
  const dbPath = resolveDbPath();

  if (FLAG_CONFLICT) {
    console.log("[guard] --job-url and --job-id are mutually exclusive");
    return [];
  }

  // A manually supplied URL is a possible PII destination even in dry-run.
  // Reject it before the DB guard can turn it into a browser job.
  if (SINGLE_URL && !isAllowedInitialJobUrl(SINGLE_URL)) {
    console.log("[guard] --job-url must be an HTTPS URL; no browser will be opened");
    return [];
  }

  if (SINGLE_URL) {
    const pauseGuard = await manualUrlDatabaseGuard({ dbPath, dryRun: DRY_RUN });
    if (!pauseGuard.allowed) {
      console.log(`[guard] --job-url refused: ${pauseGuard.reason}; an existing authoritative DB/settings state is required for live mode`);
      return [];
    }
    return [{
      company: "Manual",
      title: "Manual Test",
      link: SINGLE_URL,
      source: "manual",
      manual_url: true,
      _manual_url: true,
      _db_path: pauseGuard.dbPath,
      _send_paused: pauseGuard.paused,
      _send_pause_available: pauseGuard.available,
    }];
  }

  if (!dbPath) {
    const configured = String(process.env.PULSEOPS_DB || "").trim();
    console.log(configured
      ? `[DB] PULSEOPS_DB configured path is unavailable: ${configured}`
      : "[DB] no pulseops.db found");
    return [];
  }
  const pauseAtLoad = await readSendPause(dbPath);
  if (!pauseAtLoad.available) {
    console.log(`[DB] pause state unavailable (${pauseAtLoad.reason}); refusing DB job selection`);
    return [];
  }
  if (pauseAtLoad.paused) {
    console.log("[DB] send_paused=1; no DB jobs selected");
    return [];
  }

  const { execFileSync } = await import("node:child_process");
  // The Python code is fixed; all values (DB path, mode, id) are argv values.
  // Keeping the query in Python preserves compatibility with the existing
  // SQLite schema without ever constructing a shell command.
  const queryRows = (mode, id = "", includeIndeed = INCLUDE_INDEED) => {
    const pythonCode = String.raw`
import json, sqlite3, sys
db_path, mode, wanted_id, include_indeed = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

def send_paused():
    try:
        tables = {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "settings" not in tables:
            return None
        row = conn.execute("SELECT value FROM settings WHERE key='send_paused'").fetchone()
        if row is None:
            return False
        return str(row[0] or "").strip().lower() in {"1", "true", "yes", "on"}
    except Exception:
        return None

def columns(table):
    return {str(row[1]) for row in conn.execute("PRAGMA table_info(%s)" % table)}

job_columns = columns("jobs")
if not {"id", "company", "title", "link"}.issubset(job_columns):
    print(json.dumps([]))
    raise SystemExit(0)

where = []
params = []
if mode == "job":
    where.append("j.\"id\"=?")
    params.append(int(wanted_id))
elif mode == "email":
    if "send_queue" not in {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        print(json.dumps([]))
        raise SystemExit(0)
    where.extend(["q.\"status\"='pending'", "j.\"id\"=q.\"job_id\""])
else:
    if "status" in job_columns:
        where.append("LOWER(COALESCE(j.\"status\",''))='evaluated'")
        where.append("LOWER(COALESCE(j.\"status\",'')) NOT IN ('applied','sent','followupsent','expired','skipped','verified','needsreview','needsverification','applying','sendpaused','simulated')")
    if "score" in job_columns:
        where.append("COALESCE(j.\"score\",0)>=75")
    if "link" in job_columns:
        where.append("LOWER(COALESCE(j.\"link\",'')) LIKE 'https://%'")
        if include_indeed != "1":
            where.append("LOWER(COALESCE(j.\"link\",'')) NOT LIKE '%indeed.com%'")
        where.append("LOWER(COALESCE(j.\"link\",'')) NOT LIKE '%workatastartup.com/jobs/l/%'")
        where.append("LOWER(COALESCE(j.\"link\",'')) NOT LIKE '%workatastartup.com/companies/%'")
    if "source" in job_columns:
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'mock%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'sim:%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'sim-%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'simulation%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'simulated%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'fixture%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'sample%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'test%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'portal%'")
        where.append("LOWER(COALESCE(j.\"source\",'')) NOT LIKE 'scraper%'")
    if "run_id" in job_columns:
        where.append("LOWER(COALESCE(j.\"run_id\",'')) NOT LIKE 'sim-%'")
        where.append("LOWER(COALESCE(j.\"run_id\",'')) NOT LIKE 'simulation%'")
        where.append("LOWER(COALESCE(j.\"run_id\",'')) NOT LIKE 'simulated%'")
        where.append("LOWER(COALESCE(j.\"run_id\",'')) NOT LIKE 'mock-%'")
        where.append("LOWER(COALESCE(j.\"run_id\",'')) NOT LIKE 'test-%'")
    if "run_marker" in job_columns:
        where.append("LOWER(COALESCE(j.\"run_marker\",'')) NOT LIKE 'sim-%'")
        where.append("LOWER(COALESCE(j.\"run_marker\",'')) NOT LIKE 'simulation%'")
        where.append("LOWER(COALESCE(j.\"run_marker\",'')) NOT LIKE 'simulated%'")

# Do not select known terminal rows or rows awaiting a G10 human review. The
# same checks are repeated in JS after the query for schema/file-based cases.
outreach_columns = columns("outreach") if "outreach" in {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} else set()
if outreach_columns and "job_id" in outreach_columns and mode != "job":
    blocked = []
    if "status" in outreach_columns:
        # Terminal states only. A pending G10 review gates the email channel, not
        # a browser application to an open role.
        blocked.append("LOWER(COALESCE(o.\"status\",'')) IN ('sent','simulated','cooldown','referral','blacklisted','bounced','followup_sent','followupsent')")
    if "channel" in outreach_columns:
        blocked.append("LOWER(COALESCE(o.\"channel\",''))='referral'")
    if "notes" in outreach_columns:
        blocked.append("LOWER(COALESCE(o.\"notes\",'')) LIKE '%g4:%' OR LOWER(COALESCE(o.\"notes\",'')) LIKE '%g5:%' OR LOWER(COALESCE(o.\"notes\",'')) LIKE '%cooldown%'")
    scope = ["o.\"job_id\"=j.\"id\""]
    if blocked:
        where.append("NOT EXISTS (SELECT 1 FROM outreach o WHERE (" + " OR ".join(scope) + ") AND (" + " OR ".join(blocked) + "))")

if mode == "email":
    sql = "SELECT j.* FROM jobs j JOIN send_queue q ON q.\"job_id\"=j.\"id\""
else:
    sql = "SELECT j.* FROM jobs j"
if where:
    sql += " WHERE " + " AND ".join(where)
# Prefer rows that are genuine ATS-hosted job listings. LinkedIn and aggregator
# pages need per-site handling and were consuming every run's limited slots,
# starving the ~18 Greenhouse/Lever listings that have real application forms.
sql += """
 ORDER BY CASE
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%greenhouse.io/%/jobs/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%lever.co/%/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%ashbyhq.com/%/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%myworkdayjobs.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%workday.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%smartrecruiters.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%linkedin.com/%' THEN 2
   ELSE 1
 END, j."id" DESC
 LIMIT 100"""
rows = conn.execute(sql, params).fetchall()
result = []
paused = send_paused()
for row in rows:
    item = dict(row)
    item["_send_paused"] = paused
    item["_send_pause_available"] = paused is not None
    item["_db_pause_available"] = paused is not None
    if outreach_columns and "id" in item:
        outreach_rows = []
        if "job_id" in outreach_columns:
            # Scope strictly to this listing. Matching on company as well meant a
            # single outreach to one role silently blocked every other role at
            # that company, which is not what the cooldown is for.
            outreach_rows = conn.execute(
                'SELECT o.* FROM outreach o WHERE o."job_id"=?', [item["id"]],
            ).fetchall()
        item["_outreach_statuses"] = [str(r["status"]) for r in outreach_rows] if "status" in outreach_columns else []
        item["_outreach_channels"] = [str(r["channel"]) for r in outreach_rows] if "channel" in outreach_columns else []
        item["_outreach_notes"] = [str(r["notes"]) for r in outreach_rows] if "notes" in outreach_columns else []
        item["_pending_g10_review"] = any(str(r["status"] or "").lower() in ("needs_review", "review_pending", "pending_review") for r in outreach_rows) if "status" in outreach_columns else False
    result.append(item)
print(json.dumps(result))
`;
    const out = execFileSync("python", ["-c", pythonCode, dbPath, mode, String(id), includeIndeed ? "1" : "0"], {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true,
    });
    const line = out.trim().split(/\r?\n/).pop();
    return line ? JSON.parse(line) : [];
  };

  if (SINGLE_JOB_ID) {
    try {
      const rawId = String(SINGLE_JOB_ID).trim();
      if (!/^\d+$/.test(rawId)) throw new Error("invalid --job-id");
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid --job-id");
      const rows = queryRows("job", String(id));
      if (!rows.length) {
        console.log(`  [db] job #${id} was not found`);
        return [];
      }
      const eligible = rows.filter((row) => isEligibleJob(row, { explicit: true }));
      if (!eligible.length) {
        const row = rows[0];
        console.log(`  [guard] --job-id #${id} refused (status=${row.status || "unknown"}, source=${row.source || "unknown"}, simulation=${isSimulationJob(row)}, pending_g10=${row._pending_g10_review === true})`);
        return [];
      }
      return eligible.map((row) => ({ ...row, job_id: row.id, _db_path: dbPath }));
    } catch (e) {
      console.log(`  [db] load by id ${SINGLE_JOB_ID} failed: ${e.message.slice(0, 120)}`);
    }
    return [];
  }

  // send_queue is an e-mail overflow queue, not a browser-apply queue. Only
  // include it when the operator explicitly supplies --email-queue.
  if (LOAD_EMAIL_QUEUE) {
    try {
      const rows = queryRows("email").filter((row) => isEligibleJob(row, { explicit: true }));
      if (rows.length) {
        console.log(`[DB] loaded ${rows.length} explicit --email-queue rows`);
        return rows.slice(0, 5).map((row) => ({ ...row, job_id: row.id, _db_path: dbPath, queue_source: "email-queue" }));
      }
    } catch (e) {
      console.log(`[DB] email-queue load failed: ${e.message?.slice(0, 120)}`);
    }
  }

  // Safe unattended default: only fresh, scored, trustworthy, unsubmitted
  // rows. JS repeats the policy after the query so blacklist/contact files and
  // unusual schemas still fail closed.
  try {
    const rows = queryRows("default").filter((row) => isEligibleJob(row));
    if (rows.length) {
      console.log(`[DB] loaded ${rows.length} recent eligible Evaluated jobs`);
      return rows.slice(0, 5).map((row) => ({ ...row, job_id: row.id, _db_path: dbPath }));
    }
  } catch (e) {
    console.log(`[DB] eligible-jobs load failed: ${e.message?.slice(0, 120)}`);
  }

  console.log("[DB] no eligible real jobs found");
  return [];
}

function isMockJob(j) {
  const link = String(j?.link || j?.url || "");
  return !link || /example\.com/i.test(link) || isSimulationJob(j);
}

function statusForBrowserResult(result) {
  const action = String(result?.action || "");
  if (action === "verified" || (action === "submitted" && result?.confirmed === true)) return "Verified";
  if (action === "submitted" || ["unverified", "chat-incomplete", "needs-verification", "no-submit", "not-submitted", "click-failed", "error"].includes(action)) return "NeedsVerification";
  if (["needs-review", "captcha-blocked", "manual-submit-required", "redirect-blocked", "simulation-blocked", "authwall-skip", "portal-disabled", "profile-incomplete"].includes(action)) return "NeedsReview";
  if (action === "dead-link" || action === "invalid-listing") return "Expired";
  if (action === "salary-below-threshold") return "Skipped";
  // A pause/claim miss is deliberately not written.  The existing Applying
  // marker remains recoverable instead of being downgraded to Evaluated.
  return null;
}

async function persistBrowserResult(result, {
  dbPath = resolveDbPath(),
  dryRun = DRY_RUN,
  claimToken = result?.claimToken || result?.ownerToken || result?.owner || result?._claimToken || result?._claim_token || null,
  requireClaim = true,
} = {}) {
  if (dryRun) return { updated: false, reason: "dry-run" };
  const jobId = Number.parseInt(result?.job_id ?? result?.jobId ?? result?.id, 10);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return { updated: false, reason: "invalid-id" };
  const nextStatus = statusForBrowserResult(result);
  if (!nextStatus) return { updated: false, reason: "no-status-transition" };
  if (requireClaim && !claimToken) return { updated: false, reason: "claim-required" };
  if (!isExistingDbPath(dbPath)) return { updated: false, reason: "db-missing" };

  const pythonCode = String.raw`
import datetime, json, os, sqlite3, sys
path, raw_id, status, owner, raw_now = sys.argv[1:6]
result = {"updated": False, "reason": "persist-failed"}
try:
    job_id = int(raw_id)
    if not os.path.isfile(path) or not owner:
        result["reason"] = "db-missing" if not os.path.isfile(path) else "claim-required"
    else:
        conn = sqlite3.connect(path, timeout=5)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE")
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(jobs)")}
        if not {"id", "status", "processed_at"}.issubset(cols):
            result["reason"] = "db-schema-unavailable"
        else:
            row = conn.execute("SELECT status, processed_at FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                result["reason"] = "job-not-found"
            else:
                current = str(row[0] or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")
                marker = str(row[1] or "")
                marker_owner = marker.rsplit("|", 1)[1] if "|" in marker else ""
                if current != "applying" or marker_owner != owner:
                    result["reason"] = "claim-lost"
                else:
                    stamp = datetime.datetime.fromtimestamp(float(raw_now) / 1000.0, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                    new_marker = "browser-apply-result|" + stamp + "|" + owner
                    cur = conn.execute("UPDATE jobs SET status=?, processed_at=? WHERE id=? AND LOWER(COALESCE(status,''))='applying' AND processed_at=?", (status, new_marker, job_id, marker))
                    result = {"updated": cur.rowcount == 1, "reason": "updated" if cur.rowcount == 1 else "claim-race-lost"}
        conn.commit()
except Exception:
    try:
        conn.rollback()
    except Exception:
        pass
print(json.dumps(result))
`;
  const changed = runSqliteJson(dbPath, pythonCode, [dbPath, String(jobId), nextStatus, String(claimToken || ""), String(Date.now())], 7000);
  if (changed?.updated) console.log(`  [db] job #${jobId} -> ${nextStatus} (1 row)`);
  else console.log(`  [db] job #${jobId} result not persisted (${changed?.reason || "unknown"})`);
  return changed || { updated: false, reason: "persist-failed" };
}

async function persistBrowserResults(results, options = {}) {
  const list = Array.isArray(results) ? results : [results];
  const persisted = [];
  for (const result of list) {
    persisted.push(await persistBrowserResult(result, options));
  }
  return persisted;
}

async function main() {
  const profile = loadProfile();
  console.log(`[Profile] ${profile.candidate?.name} <${profile.candidate?.email}> — ${profile.domain?.title || ""}`);
  if (FLAG_CONFLICT) {
    console.error("[FATAL] --job-url and --job-id cannot be used together; no browser was launched.");
    process.exitCode = 4;
    return;
  }
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
  const beforeHttpsFilter = jobs.length;
  jobs = jobs.filter((job) => {
    const link = job?.link || job?.url;
    if (isAllowedInitialJobUrl(link)) return true;
    console.log(`  [redirect-block] dropped non-HTTPS job URL: ${String(link || "").slice(0, 120)}`);
    return false;
  });
  if (beforeHttpsFilter !== jobs.length) {
    console.log(`  [guard] dropped ${beforeHttpsFilter - jobs.length} non-HTTPS job URL(s); no browser was opened for them`);
  }
  if (!DRY_RUN && MOCK_ONLY) {
    console.error("[FATAL] --live --mock refused: simulation mode cannot open a live browser.");
    process.exitCode = 4;
    return;
  }
  if (!INCLUDE_INDEED) {
    const beforeIndeed = jobs.length;
    jobs = jobs.filter((job) => inferATS(job.link || job.url) !== "indeed");
    if (beforeIndeed !== jobs.length) console.log("[guard] Indeed disabled; use --include-indeed only for a deliberate run");
  }
  if (!DRY_RUN) {
    const real = jobs.filter((j) => !isMockJob(j) && !isSimulationJob(j));
    const dropped = jobs.length - real.length;
    if (dropped > 0) console.log(`[guard] dropped ${dropped} simulation/mock listing(s) — live never submits them`);
    jobs = real;
  }
  if (!jobs.length) {
    if (SINGLE_JOB_ID) {
      // An explicitly requested job that is no longer eligible is a real
      // failure worth surfacing to the operator and to CI.
      console.error(`[FATAL] --job-id ${SINGLE_JOB_ID} refused or no longer eligible; no browser was launched.`);
      process.exitCode = 4;
      return;
    }
    // An empty queue is a normal outcome (everything is on cooldown, already
    // terminal, or out of scope), not a failure.
    console.log("[DB] queue is empty — nothing eligible to apply to right now (cooldowns, terminal rows, or out-of-scope roles).");
    return;
  }
  if (!DRY_RUN) {
    // One last preflight before launch.  The same fresh pause/claim checks are
    // repeated in processJob and clickFinalControl for mid-run changes.
    const firstDb = SINGLE_URL ? getAuthoritativeDbPath() : resolveDbPath();
    const pause = await readSendPause(firstDb);
    if (!pause.available || pause.paused) {
      console.error(`[FATAL] send_paused=${pause.paused ? "1" : "unavailable"} (${pause.reason}); no browser was launched.`);
      process.exitCode = 4;
      return;
    }
    // Find the first job that can actually be claimed and put it at the front.
    // Only that one is claimed here: processJob claims each remaining job
    // itself, so preflight-claiming the whole batch would orphan rows that are
    // never reached if the run stops early.
    let firstClaimable = null;
    for (const job of jobs) {
      const prepared = await prepareJobRuntime(job, {});
      if (prepared.allowed) { firstClaimable = [job, prepared]; break; }
      console.log(`[skip] #${job.id} ${job.company} — ${prepared.reason}`);
    }
    if (!firstClaimable) {
      console.log("[DB] every queued job is held or unclaimable right now; no browser was launched.");
      return;
    }
    // Carry the preflight's exact claim token into processJob. Without this,
    // the first pass would see its own fresh Applying row as another worker.
    attachPreparedRuntime(firstClaimable[0], firstClaimable[1]);
    jobs = [firstClaimable[0], ...jobs.filter((j) => j !== firstClaimable[0])];
  }
  console.log(`[Jobs] ${jobs.length} to process (dry-run=${DRY_RUN}, headed=${HEADED})`);

  const { chromium } = await import("playwright");
  let browser = null;
  const results = [];
  try {
    if (EDGE || process.argv.includes("--edge")) {
      console.log(`[Edge] persistent profile ${path.join(ROOT, ".edge-profile")} (msedge, headed)`);
      sharedCtx = await chromium.launchPersistentContext(path.join(ROOT, ".edge-profile"), {
        channel: "msedge",
        headless: false,
        viewport: { width: 1366, height: 900 },
      });
    } else {
      browser = await chromium.launch({ headless: !HEADED });
    }

    for (const job of jobs) {
      const shouldCheckPause = !DRY_RUN || job.job_id != null || job._db_path || job._dbPath;
      if (shouldCheckPause) {
        const pause = await readSendPause(job._db_path || job._dbPath || resolveDbPath());
        if (!pause.available || pause.paused) {
          console.log(`  [send-paused] stopping before later job #${job.job_id || "manual"} (${pause.reason})`);
          results.push({
            company: job.company,
            title: job.title,
            link: job.link || job.url,
            ats: inferATS(job.link || job.url),
            action: "send-paused",
            job_id: job.job_id || null,
            claimToken: job._claimToken || job._claim_token || null,
          });
          break;
        }
      }

      let r;
      try {
        r = await processJob(browser, job, profile, {
          dbPath: job._db_path || job._dbPath || null,
          claimToken: job._claimToken || job._claim_token || null,
        });
      } catch (error) {
        // The claim is deliberately persisted as NeedsVerification on an
        // unexpected crash; never let it fall back to Evaluated.
        r = {
          company: job.company,
          title: job.title,
          link: job.link || job.url,
          ats: inferATS(job.link || job.url),
          action: "error",
          error: String(error?.message || error),
        };
      }
      const result = {
        ...r,
        job_id: job.job_id || job.id || null,
        claimToken: job._claimToken || job._claim_token || r.claimToken || null,
        _db_path: job._db_path || job._dbPath || null,
      };
      results.push(result);
      // Persist after every job, before waiting or closing the browser.  This
      // is the durable recovery point if the process dies mid-batch.
      if (!DRY_RUN) {
        await persistBrowserResults([result], {
          dbPath: result._db_path || resolveDbPath(),
          dryRun: false,
          claimToken: result.claimToken,
        });
      }
      if (["send-paused", "claim-blocked", "claim-lost"].includes(result.action)) break;
      // Be nice to sites
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } finally {
    if (sharedCtx) await sharedCtx.close().catch(() => {});
    else if (browser) await browser.close().catch(() => {});
  }

  const outPath = path.join(ROOT, "output", "apply-results.json");
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ran_at: new Date().toISOString(), dry_run: DRY_RUN, jobs, results }, null, 2), "utf-8");
  console.log(`\n[+] Done ${results.length} jobs → ${path.relative(ROOT, outPath)}`);
  console.log(DRY_RUN ? "[*] DRY-RUN — no applications submitted. Re-run with --live --headed after verifying previews." : "[*] LIVE — final actions require --auto; verified/needs-review outcomes are recorded conservatively.");

  // Discord confirmation: only server-verified outcomes are announced.
  if (!DRY_RUN && results.some(r => r.action === "verified")) {
    const webhook = process.env.DISCORD_WEBHOOK_URL || "";
    if (webhook) {
      for (const r of results.filter(x => x.action === "verified")) {
        const msg = `✅ Verified application to ${r.company} — ${r.title} via ${r.ats}`;
        try {
          const resp = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: msg }) });
          if (resp.ok) console.log(`  [Discord] confirmation sent: ${msg}`);
          else console.log(`  [Discord] REJECTED (HTTP ${resp.status}) — did NOT deliver: ${msg}`);
        } catch (e) { console.log(`  [Discord] confirm failed: ${e.message.slice(0,80)}`); }
      }
    }
  }
}

export {
  ATS_ALLOWED_HOSTS,
  ATS_SERVICE_HOSTS,
  attachPreparedRuntime,
  CLAIM_RECOVERY_MS,
  DB_PATH,
  SIMULATION_RUN_PREFIX,
  SIMULATION_SOURCE_PREFIX,
  CAPTCHA_SELECTORS,
  classifyApplyAction,
  classifyApplyControl,
  clickFinalControl,
  createNavigationBoundary,
  detectAndClickApply,
  finalSubmissionAllowed,
  findResumePdf,
  getAuthoritativeDbPath,
  hasCrossOriginFormOrFrame,
  hasVisibleAppliedBadge,
  inferATS,
  installNavigationGuard,
  isFinalApplyControl,
  isAllowedInitialJobUrl,
  isAllowedNavigationUrl,
  isStrictTargetRole,
  isSubmissionControlLabel,
  isAshbyJobListing,
  isGreenhouseJobListing,
  isLeverJobListing,
  isWellfoundJobListing,
  isNaukriJobListing,
  hasSimulationFragment,
  matchChipOption,
  matchSalaryOption,
  answerCandidateQuestions,
  advanceMultiStepFlow,
  missingContactFields,
  tryPinExternalApplyOrigin,
  isAllowedAssetRequest,
  isAllowedReadOnlyApiRequest,
  isBlacklistedJob,
  isCurrentPageTrusted,
  isEligibleJob,
  isMockJob,
  isSimulationJob,
  isTerminalStatus,
  loadJobsFromDB,
  manualUrlDatabaseGuard,
  parseHttpUrl,
  persistBrowserResult,
  persistBrowserResults,
  pinNavigationOrigin,
  processJob,
  readFinalActionState,
  readSendPause,
  claimJobForApply,
  recoverJobClaim,
  resolveDbPath,
  statusForBrowserResult,
  verifyJobClaim,
  waitForCaptchaResolution,
  waitForApplicationSurface,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch(e=>{ console.error("[Fatal] apply crashed", e); process.exit(1); });
}
