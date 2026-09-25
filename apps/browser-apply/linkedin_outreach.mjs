#!/usr/bin/env node
/**
 * apps/browser-apply/linkedin_outreach.mjs — guarded LinkedIn recruiter finder
 *
 * This tool is preview-only. Standalone DM/connection sending is disabled
 * because it lacks durable per-recipient idempotency. LinkedIn Easy Apply
 * remains available through the guarded apps/browser-apply/apply.mjs engine.
 *
 * Usage:
 *   node apps/browser-apply/linkedin_outreach.mjs --dry-run --company "Acme"
 *   node apps/browser-apply/linkedin_outreach.mjs --dry-run --all
 *   node apps/browser-apply/linkedin_outreach.mjs --live --headed            # preview only
 *
 * Requires: portal/storageState.json with a logged-in LinkedIn session
 *   (run: node apps/browser-apply/save_sessions.mjs, log in with EMAIL, not Google)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const LIVE = process.argv.includes("--live");
const DRY_RUN = process.argv.includes("--dry-run") || !LIVE;
const HEADED = process.argv.includes("--headed") || DRY_RUN;
const AUTO = process.argv.includes("--auto");
const STANDALONE_SEND_DISABLED = true;
const COMPANY_FLAG = (() => {
  const index = process.argv.findIndex((arg) => arg === "--company");
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value.trim() || null : null;
})();

const SESSION = path.join(ROOT, "portal", "storageState.json");
const MENTION = process.env.DISCORD_USER_ID ? `<@${process.env.DISCORD_USER_ID}>` : "@here";
const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_HOSTS = Object.freeze(["linkedin.com", "www.linkedin.com"]);

// These are deliberately duplicated here rather than imported from apply.mjs.
// The standalone sender must fail closed even if the other entry point changes.
const SIMULATION_MARKER_RE = /^(?:mock|sim(?:ulated|ulation)?|fixture|sample|test|demo)(?:$|[:/_ \-])/i;
const JOB_STATUS_EXCLUSIONS = new Set([
  "applied", "sent", "verified", "needsreview", "needsverification", "expired", "skipped",
  "followupsent", "simulated", "sendpaused", "emailqueued", "blacklisted", "referral", "cooldown",
]);
const OUTREACH_STATUS_EXCLUSIONS = new Set([
  "applied", "sent", "verified", "needsreview", "needsverification", "expired", "skipped",
  "followupsent", "followup_sent", "simulated", "reviewposted", "review_posted",
  "needsreview", "review_pending", "pending_review", "cooldown", "referral", "blacklisted", "bounced",
]);
const PENDING_G10_STATUSES = new Set([
  "needsreview", "needs_review", "reviewpending", "review_pending", "pendingreview", "pending_review",
  "reviewposted", "review_posted", "g10pending", "g10_pending", "g10review", "g10_review", "pending", "g10",
]);
const CAPTCHA_SELECTORS = [
  'iframe[src*="captcha"]',
  'iframe[src*="challenges.cloudflare"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="turnstile"]',
  '[data-testid="captcha"]',
  "[data-captcha]",
  ".cf-challenge",
  ".cf-turnstile",
  "[class*='captcha' i]",
  "form[action*='captcha' i]",
];
const CAPTCHA_TEXT_RE = /verify you are human|additional verification required|checking your browser|complete the captcha|unusual traffic|security check/i;
const CAPTCHA_WAIT_MS = (() => {
  const parsed = Number.parseInt(process.env.PULSEOPS_CAPTCHA_WAIT_MS || "180000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180000;
})();

/**
 * The query is fixed code and receives the DB path/company as argv values.  It
 * never interpolates user input into a shell command.  Returning the complete
 * job row is intentional: the JS policy below repeats every safety check after
 * SQLite has returned data.
 */
const DB_STATE_QUERY = String.raw`
import json, sqlite3, sys

db_path, company = sys.argv[1], str(sys.argv[2] or "").strip()
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
tables = {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

def pause_state():
    if "settings" not in tables:
        return None
    try:
        row = conn.execute("SELECT value FROM settings WHERE key='send_paused'").fetchone()
        if row is None:
            return False
        value = str(row[0] or "").strip().lower()
        if value in {"1", "true", "yes", "on", "paused"}:
            return True
        if value in {"", "0", "false", "no", "off", "active"}:
            return False
        return None
    except Exception:
        return None

paused = pause_state()
if "jobs" not in tables:
    print(json.dumps({"ok": False, "error": "jobs-table-missing", "send_paused": paused, "jobs": []}))
    raise SystemExit(0)
job_columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(jobs)")}
if not {"id", "company", "title", "link", "score", "status"}.issubset(job_columns):
    print(json.dumps({"ok": False, "error": "jobs-schema-incomplete", "send_paused": paused, "jobs": []}))
    raise SystemExit(0)

where = ""
params = []
if company:
    where = " WHERE LOWER(TRIM(COALESCE(company,''))) = LOWER(TRIM(?))"
    params.append(company)
rows = conn.execute("SELECT * FROM jobs" + where + " ORDER BY id DESC LIMIT 100", params).fetchall()

outreach_rows = []
outreach_columns = set()
outreach_guard_known = "outreach" not in tables
if "outreach" in tables:
    outreach_columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(outreach)")}
    outreach_guard_known = "status" in outreach_columns and ("job_id" in outreach_columns or "company" in outreach_columns)
    if outreach_columns:
        outreach_rows = [dict(row) for row in conn.execute("SELECT * FROM outreach").fetchall()]

def same_job(outreach, job):
    if "job_id" in outreach and "id" in job and outreach.get("job_id") is not None and job.get("id") is not None:
        if str(outreach.get("job_id")) == str(job.get("id")):
            return True
    left = str(outreach.get("company") or "").strip().lower()
    right = str(job.get("company") or "").strip().lower()
    left_norm = str(outreach.get("company_normalised") or "").strip().lower()
    right_norm = str(job.get("company_normalised") or "").strip().lower()
    return bool(left and right and (left == right or (left_norm and left_norm == right_norm)))

result = []
for row in rows:
    item = dict(row)
    related = [o for o in outreach_rows if same_job(o, item)]
    item["_outreach_statuses"] = [str(o.get("status") or "") for o in related] if "status" in outreach_columns else []
    item["_outreach_channels"] = [str(o.get("channel") or "") for o in related] if "channel" in outreach_columns else []
    item["_outreach_notes"] = [str(o.get("notes") or "") for o in related] if "notes" in outreach_columns else []
    item["_pending_g10_review"] = any(
        str(o.get("status") or "").strip().lower().replace("-", "_") in {
            "needs_review", "review_pending", "pending_review", "review_posted", "g10_pending", "g10_review"
        }
        for o in related
    )
    item["_send_paused"] = paused
    item["_database_pause_known"] = paused is not None
    item["_outreach_guard_known"] = outreach_guard_known
    result.append(item)

print(json.dumps({"ok": True, "send_paused": paused, "jobs": result}, default=str))
`;

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * LinkedIn navigation is intentionally exact-host, HTTPS-only.  A suffix check
 * such as host.endsWith("linkedin.com") would permit linkedin.com.evil.test;
 * a subdomain such as evil.linkedin.com is not needed by this flow and is also
 * rejected.
 */
function isAllowedLinkedInUrl(value) {
  const url = parseHttpUrl(value);
  if (!url || url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  return LINKEDIN_HOSTS.includes(url.hostname.toLowerCase());
}

function linkedInUrl(value, base = LINKEDIN_ORIGIN) {
  try {
    const url = new URL(String(value || ""), base);
    return isAllowedLinkedInUrl(url.toString()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isLinkedInProfileUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return isAllowedLinkedInUrl(url.toString()) && /^\/in\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isExpectedLinkedInPath(actual, expected) {
  try {
    const actualUrl = new URL(String(actual || ""));
    const expectedUrl = new URL(String(expected || ""));
    if (!isAllowedLinkedInUrl(actualUrl.toString()) || !isAllowedLinkedInUrl(expectedUrl.toString())) return false;
    const stripSlash = (value) => value.replace(/\/+$/, "");
    return stripSlash(actualUrl.pathname) === stripSlash(expectedUrl.pathname);
  } catch {
    return false;
  }
}

function normaliseStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[ _-]+/g, "");
}

function isTruthyPause(value) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "on", "paused"].includes(String(value ?? "").trim().toLowerCase());
}

function isKnownPause(value) {
  if (value === null) return false;
  if (value === false || value === 0) return true;
  return ["", "0", "false", "no", "off", "active"].includes(String(value).trim().toLowerCase());
}

function isSimulationJob(job) {
  if (job?.simulated === true || job?.is_simulation === true || job?.simulation === true) return true;
  const markers = [
    job?.source,
    job?.run_id,
    job?.run_marker,
    job?.runId,
    job?.simulation_marker,
    job?.simulationMarker,
  ];
  if (markers.some((value) => {
    const text = String(value || "").trim();
    return SIMULATION_MARKER_RE.test(text)
      || /(?:^|[^a-z])(mock|sim|simulated|simulation|fixture|sample|test|demo)(?:[^a-z]|$)/i.test(text);
  })) return true;
  // Older fixture rows put the durable marker in the summary rather than source.
  return /^\s*\[\s*sim(?:ulated|ulation)?\b/i.test(String(job?.text_summary || ""));
}

function isTrustworthySource(source) {
  const value = String(source || "").trim();
  if (!value || isSimulationJob({ source: value })) return false;
  return !/^(?:unknown|untrusted|fixture|sample|test|demo|mock|sim(?:ulation)?|manual|queue|fallback|scraper)(?:$|[:/_ \-])/i.test(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function hasPriorOutcome(job) {
  const statuses = [
    ...asArray(job?._outreach_statuses),
    ...asArray(job?.outreach_statuses),
    ...asArray(job?.outreach_status),
  ];
  return statuses.some((status) => OUTREACH_STATUS_EXCLUSIONS.has(normaliseStatus(status)));
}

function hasPendingG10Review(job) {
  const flag = job?._pending_g10_review ?? job?.pending_g10_review;
  if (flag === true || flag === 1 || ["1", "true", "yes", "pending"].includes(String(flag || "").toLowerCase())) {
    return true;
  }
  const statuses = [
    ...asArray(job?._outreach_statuses),
    ...asArray(job?.outreach_statuses),
    ...asArray(job?.outreach_status),
    job?._review_status,
  ];
  if (statuses.some((status) => {
    const value = String(status || "").trim().toLowerCase();
    return PENDING_G10_STATUSES.has(value) || PENDING_G10_STATUSES.has(normaliseStatus(status))
      || /g10.*(?:pending|review)|(?:pending|review).*g10/.test(value);
  })) return true;
  const notes = [
    ...asArray(job?._outreach_notes),
    ...asArray(job?.outreach_notes),
    job?.notes,
    job?.reason,
    job?.blocked_reason,
    job?.text_summary,
  ].join(" ");
  return /\bG10\s*:?[^\n]*(?:pending|review|no verified|missing)|pending\s+G10|review[_ ]posted/i.test(notes);
}

/**
 * The same policy is applied after the SQL query and again immediately before
 * a final action.  `requirePauseKnown` is used for DB-backed rows; synthetic
 * preview rows are never eligible for sending.
 */
function isEligibleJob(job, { requirePauseKnown = false } = {}) {
  if (!job || job._manual_preview) return false;
  const status = normaliseStatus(job.status);
  if (status !== "evaluated") return false;
  if (JOB_STATUS_EXCLUSIONS.has(status)) return false;
  const score = Number(job.score);
  if (!Number.isFinite(score) || score < 75) return false;
  if (!parseHttpUrl(job.link)) return false;
  if (isSimulationJob(job) || !isTrustworthySource(job.source)) return false;
  if (hasPriorOutcome(job) || hasPendingG10Review(job)) return false;
  if (job._outreach_guard_known === false) return false;
  if (Object.prototype.hasOwnProperty.call(job, "_send_paused") && !isKnownPause(job._send_paused)) return false;
  if (isTruthyPause(job._send_paused)) return false;
  if (requirePauseKnown && !isKnownPause(job._send_paused)) return false;
  return true;
}

function resolveDbPath(env = process.env, root = ROOT) {
  const configured = String(env.PULSEOPS_DB || "").trim();
  if (configured) {
    const candidates = [
      path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured),
      path.isAbsolute(configured) ? configured : path.resolve(root, configured),
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
    // An explicit PULSEOPS_DB is authoritative even when it does not exist.
    // Never silently fall back to the repository DB after a typo or mount miss.
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || null;
  }
  return [
    path.join(root, "pulseops.db"),
    path.join(root, ".state", "pulseops.db"),
  ].find((candidate) => fs.existsSync(candidate)) || null;
}

function readDatabaseState(dbPath = resolveDbPath(), company = "") {
  if (!dbPath) {
    return { ok: false, error: "no-db-configured", send_paused: null, jobs: [] };
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: "configured-db-unavailable", send_paused: null, jobs: [] };
  }
  try {
    const output = execFileSync(
      "python",
      ["-c", DB_STATE_QUERY, dbPath, String(company || "")],
      { encoding: "utf-8", timeout: 15000, windowsHide: true },
    );
    const line = String(output).trim().split(/\r?\n/).pop();
    const parsed = line ? JSON.parse(line) : null;
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.jobs)) {
      return { ok: false, error: parsed?.error || "invalid-db-state", send_paused: null, jobs: [] };
    }
    return parsed;
  } catch (error) {
    return { ok: false, error: `db-read-failed:${String(error?.message || error).slice(0, 120)}`, send_paused: null, jobs: [] };
  }
}

/** Read the current global pause, never a value cached at process start. */
function readGlobalSendPaused(dbPath = resolveDbPath()) {
  const state = readDatabaseState(dbPath, "");
  return {
    known: state.ok && state.send_paused !== null,
    paused: state.send_paused === true,
    state,
  };
}

function findCurrentJob(state, requestedJob) {
  if (!state?.ok || !requestedJob) return null;
  const requestedId = Number(requestedJob.id);
  if (Number.isSafeInteger(requestedId) && requestedId > 0) {
    const requestedCompany = String(requestedJob.company || "").trim().toLowerCase();
    if (!requestedCompany) return null;
    return state.jobs.find((job) => {
      if (Number(job.id) !== requestedId) return false;
      const currentCompany = String(job.company || "").trim().toLowerCase();
      return !requestedCompany || !currentCompany || requestedCompany === currentCompany;
    }) || null;
  }
  return null;
}

/** Re-read all mutable DB policy at the last possible moment. */
function refreshJobForAction(job, dbPath = resolveDbPath()) {
  const state = readDatabaseState(dbPath, "");
  if (!state.ok) return { ok: false, reason: "database-unavailable", state };
  if (state.send_paused !== false) {
    return { ok: false, reason: "send-paused-or-unknown", state };
  }
  const current = findCurrentJob(state, job);
  if (!current || !isEligibleJob(current, { requirePauseKnown: true })) {
    return { ok: false, reason: "job-no-longer-eligible", state };
  }
  return { ok: true, job: current, state };
}

function finalSubmissionAllowed({ dryRun = DRY_RUN, auto = AUTO } = {}) {
  return !STANDALONE_SEND_DISABLED && dryRun === false && auto === true;
}

async function hasCaptcha(page) {
  // A failed probe is evidence of an unknown page state, so it is treated as a
  // challenge.  This is the important fail-closed branch.
  try {
    if (!page || typeof page.locator !== "function" || typeof page.evaluate !== "function") return true;
    for (const selector of CAPTCHA_SELECTORS) {
      const count = await page.locator(selector).count();
      if (!Number.isInteger(count) || count < 0) return true;
      if (count > 0) return true;
    }
    const bodyHit = await page.evaluate((pattern) => {
      const text = document.body?.innerText || document.body?.textContent || "";
      return new RegExp(pattern, "i").test(text);
    }, CAPTCHA_TEXT_RE.source);
    if (bodyHit) return true;
    if (typeof page.frames !== "function") return true;
    const frames = page.frames();
    if (!Array.isArray(frames)) return true;
    for (const frame of frames) {
      const frameText = await frame.locator("body").innerText();
      if (CAPTCHA_TEXT_RE.test(frameText || "")) return true;
    }
    return false;
  } catch (error) {
    console.log(`  [captcha] challenge probe failed; fail closed: ${String(error).slice(0, 100)}`);
    return true;
  }
}

async function waitForCaptchaResolution(page, waitMs = CAPTCHA_WAIT_MS) {
  try {
    if (!(await hasCaptcha(page))) return true;
    if (DRY_RUN || !AUTO) return false;
    const started = Date.now();
    while (await hasCaptcha(page)) {
      if (Date.now() - started >= waitMs) return false;
      await page.waitForTimeout(1000);
    }
    return true;
  } catch (error) {
    console.log(`  [captcha] challenge probe failed; blocking: ${String(error).slice(0, 100)}`);
    return false;
  }
}

async function installLinkedInNavigationGuard(page) {
  if (!page || typeof page.route !== "function") throw new Error("LinkedIn navigation guard unavailable");
  await page.route("**/*", async (route) => {
    try {
      const request = route.request();
      const isNavigation = typeof request.isNavigationRequest === "function"
        ? request.isNavigationRequest()
        : true;
      let isMainFrame = true;
      try {
        const frame = request.frame();
        isMainFrame = !frame || frame === page.mainFrame() || frame.parentFrame() === null;
      } catch {
        isMainFrame = true;
      }
      if (isNavigation && isMainFrame && !isAllowedLinkedInUrl(request.url())) {
        console.log(`    [redirect-block] refusing navigation to ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch {
      // An uncertain route must never fall through to an external page.
      try { await route.abort("blockedbyclient"); } catch {}
    }
  });
}

async function navigateLinkedIn(page, target) {
  const safeTarget = linkedInUrl(target);
  if (!safeTarget) return false;
  try {
    await page.goto(safeTarget, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    console.log(`    [redirect-block] navigation failed: ${String(error).slice(0, 100)}`);
    return false;
  }
  return isAllowedLinkedInUrl(page.url());
}

async function assertNoCaptcha(page) {
  if (await hasCaptcha(page)) {
    const error = new Error("captcha-blocked");
    error.code = "CAPTCHA_BLOCKED";
    throw error;
  }
}

function loadProfile() {
  for (const candidate of [
    path.join(ROOT, "config", "profile.yml"),
    path.join(ROOT, "config", "profile.yml.example"),
  ]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = yaml.load(fs.readFileSync(candidate, "utf-8"));
      if (parsed?.candidate) return parsed;
    } catch {}
  }
  return { candidate: { name: "Avradeep Majumder" }, domain: { title: "Backend Engineer" } };
}

function draftDM(profile, person, job) {
  const first = String(person?.name || "there").split(" ")[0];
  const candidateName = profile.candidate?.name || "there";
  return (
    `Hi ${first}, I'm ${candidateName} — a final-year B.Tech CSE (AI/ML) student ` +
    `building production AI/backend systems (fraud-intelligence platform, blockchain logistics, GNN threat detection). ` +
    `I saw ${job.company} is hiring for ${job.title || "a role"} and would love to be considered. ` +
    `Happy to share my resume. Thanks!`
  );
}

async function findPeople(page, company) {
  if (!isAllowedLinkedInUrl(`${LINKEDIN_ORIGIN}/search/results/companies/`)) {
    return { error: "linkedin-host-boundary", people: [] };
  }
  const searchUrl = `${LINKEDIN_ORIGIN}/search/results/companies/?keywords=${encodeURIComponent(company)}`;
  if (!(await navigateLinkedIn(page, searchUrl))) return { error: "company-search-blocked", people: [] };
  await assertNoCaptcha(page);
  await page.waitForTimeout(2500);
  const companyHref = await page.evaluate(() => {
    const anchor = document.querySelector('a[href*="/company/"]');
    return anchor ? anchor.getAttribute("href") : null;
  });
  let companyUrl = companyHref ? linkedInUrl(companyHref) : null;
  if (!companyUrl) {
    console.log("  [info] no valid LinkedIn company page — trying people search");
    const peopleUrl = `${LINKEDIN_ORIGIN}/search/results/people/?keywords=${encodeURIComponent(company)}`;
    if (!(await navigateLinkedIn(page, peopleUrl))) return { error: "people-search-blocked", people: [] };
    await assertNoCaptcha(page);
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(1000);
      await assertNoCaptcha(page);
    }
    const direct = await page.evaluate((co) => {
      const out = [];
      const scope = document.querySelector("main") || document;
      for (const anchor of scope.querySelectorAll('a[href*="/in/"]')) {
        const href = anchor.getAttribute("href")?.split("?")[0] || null;
        const card = anchor.closest("div");
        const context = (card?.parentElement?.innerText || "").slice(0, 200);
        const text = (anchor.textContent || "").trim().replace(/\s+/g, " ");
        if (!href || !text || text.length < 3 || text.length > 80 || /follow/i.test(text)) continue;
        if (out.some((person) => person.href === href)) continue;
        out.push({ href, text, headline: context.slice(0, 120), company: co });
        if (out.length >= 8) break;
      }
      return out;
    }, company);
    const people = direct
      .map((person) => ({ ...person, url: linkedInUrl(person.href) }))
      .filter((person) => isLinkedInProfileUrl(person.url))
      .map((person) => ({
        name: person.text,
        url: person.url,
        headline: person.headline,
        hire: /recruit|talent|hiring|hr |human resources|founder|ceo|cto|people/i.test(`${person.text} ${person.headline}`) ? 0 : 1,
      }))
      .filter((person) => person.headline.toLowerCase().includes(company.split(" ")[0].toLowerCase()))
      .sort((a, b) => a.hire - b.hire);
    if (!people.length) {
      console.log(`  [info] no relevant people at ${company} — skipping (no guessing)`);
      return { error: "no-relevant-people", people: [] };
    }
    return { slug: null, people: people.slice(0, 2) };
  }

  const companyPath = new URL(companyUrl).pathname;
  const match = companyPath.match(/^\/company\/([^/]+)/i);
  if (!match) return { error: "invalid-company-path", people: [] };
  const slug = decodeURIComponent(match[1]);
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return { error: "invalid-company-slug", people: [] };
  const peopleUrl = `${LINKEDIN_ORIGIN}/company/${encodeURIComponent(slug)}/people/`;
  if (!(await navigateLinkedIn(page, peopleUrl))) return { error: "people-page-blocked", people: [] };
  await assertNoCaptcha(page);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1200);
    await assertNoCaptcha(page);
  }
  const rawPeople = await page.evaluate(() => {
    const out = [];
    const scope = document.querySelector("main") || document;
    for (const anchor of scope.querySelectorAll('a[href*="/in/"]')) {
      const href = anchor.getAttribute("href")?.split("?")[0] || null;
      const text = (anchor.textContent || "").trim().replace(/\s+/g, " ");
      if (!href || !text || text.length < 3 || text.length > 80 || /follow/i.test(text)) continue;
      if (out.some((person) => person.href === href)) continue;
      const card = anchor.closest("li, div");
      const sub = card?.parentElement?.querySelector("div[class*='subtitle'], div[class*='headline'], p.t-14");
      out.push({ href, text, headline: (sub && sub !== anchor ? sub.textContent || "" : "").trim().slice(0, 120) });
      if (out.length >= 12) break;
    }
    return out;
  });
  const people = rawPeople
    .map((person) => ({ ...person, url: linkedInUrl(person.href) }))
    .filter((person) => isLinkedInProfileUrl(person.url))
    .map((person) => ({
      name: person.text,
      url: person.url,
      headline: person.headline,
      hire: /recruit|talent|hiring|hr |human resources|founder|ceo|cto|people|hiring manager/i.test(`${person.text} ${person.headline}`) ? 0 : 1,
    }))
    .sort((a, b) => a.hire - b.hire);
  return { slug, people: people.slice(0, 2) };
}

/**
 * The sole final-action gate.  No DM/connect send control is clicked anywhere
 * else.  It performs a fresh DB/pause check immediately before the click and
 * repeats the check once more to narrow the pause/verification race window.
 */
async function clickFinalAction(page, locator, {
  job,
  person,
  label = "final action",
  dryRun = DRY_RUN,
  auto = AUTO,
  dbPath = resolveDbPath(),
} = {}) {
  const guardOptions = { job, person, label, dryRun, auto, dbPath };
  let decision = await finalActionGuard(page, guardOptions);
  if (!decision.allowed) return { clicked: false, allowed: false, reason: decision.reason };

  let count;
  try { count = await locator.count(); } catch (error) {
    return { clicked: false, allowed: true, reason: "locator-unavailable" };
  }
  if (!count) return { clicked: false, allowed: true, reason: "send-button-not-found" };

  // Re-read the DB and pause after locating the control, immediately before the
  // side effect.  A pause toggled while the composer was open still wins.
  decision = await finalActionGuard(page, guardOptions);
  if (!decision.allowed) return { clicked: false, allowed: true, reason: decision.reason };

  let disabled;
  try { disabled = await locator.isDisabled(); } catch (error) {
    return { clicked: false, allowed: true, reason: "locator-check-failed" };
  }
  if (disabled) return { clicked: false, allowed: true, reason: "send-disabled" };
  // Keep the last mutable checks adjacent to the irreversible click.
  const lastPause = readGlobalSendPaused(dbPath);
  if (!lastPause.known || lastPause.paused) return { clicked: false, allowed: true, reason: "send-paused-or-unknown" };
  if (await hasCaptcha(page)) return { clicked: false, allowed: true, reason: "captcha-blocked" };
  try {
    await locator.click({ timeout: 5000 });
    console.log(`  [send] clicked guarded ${label}`);
    return { clicked: true, allowed: true, via: label };
  } catch (error) {
    return { clicked: false, allowed: true, reason: "click-failed", error: String(error).slice(0, 100) };
  }
}

async function finalActionGuard(page, {
  job,
  person,
  label = "final action",
  dryRun = DRY_RUN,
  auto = AUTO,
  dbPath = resolveDbPath(),
} = {}) {
  if (!finalSubmissionAllowed({ dryRun, auto })) {
    return { allowed: false, reason: "live-and-auto-required" };
  }
  if (!isLinkedInProfileUrl(person?.url) || !isAllowedLinkedInUrl(page?.url?.())) {
    return { allowed: false, reason: "linkedin-host-boundary" };
  }
  if (await hasCaptcha(page)) {
    console.log(`  [captcha] refusing ${label}; challenge is present or could not be probed`);
    return { allowed: false, reason: "captcha-blocked" };
  }
  const fresh = refreshJobForAction(job, dbPath);
  if (!fresh.ok) return { allowed: false, reason: fresh.reason };
  // The pause is deliberately checked again as the final mutable DB read.
  const pause = readGlobalSendPaused(dbPath);
  if (!pause.known || pause.paused) return { allowed: false, reason: "send-paused-or-unknown" };
  return { allowed: true, job: fresh.job };
}

async function sendDM(page, person, text, job, {
  dryRun = DRY_RUN,
  auto = AUTO,
  dbPath = resolveDbPath(),
} = {}) {
  // This early return is intentionally before page.goto or any click.  Thus
  // --live alone cannot even open a composer, let alone send a message.
  if (!finalSubmissionAllowed({ dryRun, auto })) {
    return { sent: false, reason: "live-and-auto-required" };
  }
  if (!isLinkedInProfileUrl(person?.url)) return { sent: false, reason: "linkedin-host-boundary" };
  if (!(await navigateLinkedIn(page, person.url))) return { sent: false, reason: "profile-navigation-blocked" };
  if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };
  if (!isAllowedLinkedInUrl(page.url()) || !isExpectedLinkedInPath(page.url(), person.url)) {
    return { sent: false, reason: "profile-page-mismatch" };
  }
  const openingGuard = await finalActionGuard(page, {
    job,
    person,
    label: "LinkedIn Message/Connect opening",
    dryRun,
    auto,
    dbPath,
  });
  if (!openingGuard.allowed) return { sent: false, reason: openingGuard.reason };

  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  const firstName = String(person.name || "").split(" ")[0];
  if (!firstName) return { sent: false, reason: "person-name-missing" };

  // Click only the header section containing Contact info.  This is an
  // intermediate navigation click, never the final send control.
  async function clickHeaderButton(label) {
    if (!isAllowedLinkedInUrl(page.url()) || await hasCaptcha(page)) return false;
    return page.evaluate((labelText) => {
      const contactInfo = Array.from(document.querySelectorAll("a")).find(
        (anchor) => (anchor.textContent || "").trim() === "Contact info"
      );
      if (!contactInfo) return false;
      let section = contactInfo;
      for (let i = 0; i < 10 && section; i++) {
        section = section.parentElement;
        if (section && section.tagName === "SECTION") break;
      }
      if (!section || section.tagName !== "SECTION") return false;
      const button = Array.from(section.querySelectorAll("a, button")).find(
        (element) => (element.innerText || "").trim() === labelText
      );
      if (!button) return false;
      button.scrollIntoView({ block: "center" });
      button.click();
      return true;
    }, label);
  }

  const messageClicked = await clickHeaderButton("Message");
  if (!messageClicked) {
    // Do not fall through to a connection action if Message is unavailable.
    // The caller can report the draft for manual handling.
    return { sent: false, reason: "no-message-button (not a connection / InMail only)" };
  }
  await page.waitForTimeout(2000);
  if (!isAllowedLinkedInUrl(page.url())) return { sent: false, reason: "linkedin-host-boundary" };
  if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };

  const boxSelector = [
    "aside div.msg-form__contenteditable[contenteditable='true']",
    "div.msg-overlay div[contenteditable='true']",
    "div[role='dialog'] div[contenteditable='true']",
    "div[role='dialog'] textarea",
    "div.msg-form__contenteditable",
  ].join(", ");
  let box = null;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };
    const candidate = page.locator(boxSelector).first();
    if ((await candidate.count()) > 0) {
      box = candidate;
      break;
    }
  }

  const premium = page.locator("div[role='dialog']:has-text('Start 1 month free trial'), div[role='dialog']:has-text('Invest in your career')").first();
  if ((await premium.count()) > 0) {
    console.log("  [dm] Premium paywall — direct Message needs Premium; closing modal");
    await page.locator("div[role='dialog'] button[aria-label='Dismiss']").first().click({ timeout: 3000 }).catch(() => {});
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(800);
      if ((await page.locator("div[role='dialog']").count()) === 0) break;
    }
  }

  if (!box) {
    // A missing composer is a deliberate fallback point, but it is still a
    // live side effect.  Connect is only attempted in live+auto mode (the
    // early guard above), and the final invitation button goes through the
    // same centralized guard as a DM.
    console.log("  [dm] no message overlay — trying Connect with note");
    const connectGuard = await finalActionGuard(page, {
      job,
      person,
      label: "LinkedIn Connect opening",
      dryRun,
      auto,
      dbPath,
    });
    if (!connectGuard.allowed) return { sent: false, reason: connectGuard.reason };
    let connected = await clickHeaderButton("Connect");
    if (!connected) {
      const moreClicked = await clickHeaderButton("More");
      if (moreClicked) {
        await page.waitForTimeout(1200);
        if (!isAllowedLinkedInUrl(page.url())) return { sent: false, reason: "linkedin-host-boundary" };
        connected = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll("div[role='dialog'] button, div.artdeco-dropdown button, div[role='menu'] div[role='menuitem']"));
          const connect = items.find((element) => (element.innerText || "").trim() === "Connect");
          if (!connect) return false;
          connect.click();
          return true;
        });
      }
    }
    if (!connected) return { sent: false, reason: "connect-not-available" };
    await page.waitForTimeout(2500);
    if (!isAllowedLinkedInUrl(page.url())) return { sent: false, reason: "linkedin-host-boundary" };
    if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };

    const addNote = page.locator('button[aria-label="Add a note"], button:has-text("Add a note")').first();
    if ((await addNote.count()) === 0) {
      const invitation = page.locator('button[aria-label="Send without a note"], button:has-text("Send without a note"), button[aria-label="Send now"], button:has-text("Send now"), button[aria-label="Send invitation"]').first();
      if ((await invitation.count()) === 0) return { sent: false, reason: "invite-send-not-found" };
      const modalText = await page.locator("div[role='dialog']:has-text('Connect'), div[role='dialog']:has-text('invitation')").first().innerText().catch(() => "");
      if (!modalText.toLowerCase().includes(firstName.toLowerCase())) {
        return { sent: false, reason: "modal-person-mismatch" };
      }
      const invitationResult = await clickFinalAction(page, invitation, {
        job,
        person,
        label: "LinkedIn connection invitation without note",
        dryRun,
        auto,
        dbPath,
      });
      if (!invitationResult.clicked) return { sent: false, reason: invitationResult.reason || "invitation-blocked" };
      return { sent: true, via: "connect-invite-no-note" };
    }

    if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };
    await addNote.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const noteBox = page.locator('textarea[name="message"], div[role="dialog"] textarea').first();
    if ((await noteBox.count()) === 0) return { sent: false, reason: "note-box-not-found" };
    await noteBox.fill(String(text || "").slice(0, 290), { timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(500);
    const invitationButton = page.locator('button[aria-label="Send invitation"], button:has-text("Send invitation")').first();
    if ((await invitationButton.count()) === 0) return { sent: false, reason: "invite-send-not-found" };
    const modalText = await page.locator("div[role='dialog']").first().innerText().catch(() => "");
    if (!modalText.toLowerCase().includes(firstName.toLowerCase())) {
      return { sent: false, reason: "modal-person-mismatch" };
    }
    const invitationResult = await clickFinalAction(page, invitationButton, {
      job,
      person,
      label: "LinkedIn connection invitation with note",
      dryRun,
      auto,
      dbPath,
    });
    if (!invitationResult.clicked) return { sent: false, reason: invitationResult.reason || "invitation-blocked" };
    return { sent: true, via: "connect-with-note" };
  }

  if (await hasCaptcha(page)) return { sent: false, reason: "captcha-blocked" };
  await box.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.type(String(text || "").slice(0, 700), { delay: 10 }).catch(() => null);
  await page.waitForTimeout(800);
  const send = page.locator(
    "aside button.msg-form__send-button:not([disabled]), div[role='dialog'] button:has-text('Send'), button.msg-form__send-button"
  ).first();
  const result = await clickFinalAction(page, send, {
    job,
    person,
    label: "LinkedIn message",
    dryRun,
    auto,
    dbPath,
  });
  if (!result.clicked) return { sent: false, reason: result.reason || "send-blocked" };
  return { sent: true, via: result.via || "message" };
}

// Keep the same guard name as apply.mjs for callers/tests that audit both
// browser entry points, while the implementation remains sender-specific.
const clickFinalControl = clickFinalAction;
const finalActionAllowed = finalSubmissionAllowed;

async function notifyDiscord(lines) {
  const webhook = process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) {
    console.log("[Discord] no webhook — printing instead");
    return;
  }
  const content = `${MENTION}\n${lines.join("\n").slice(0, 1900)}`;
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (response.ok) console.log("[Discord] tagged notification sent");
    else console.log(`[Discord] REJECTED (HTTP ${response.status}) — message did NOT deliver`);
  } catch (error) {
    console.log(`[Discord] failed: ${error.message?.slice(0, 80)}`);
  }
}

async function loadJobs() {
  // A named company is useful for a read-only preview, but it is never a live
  // bypass: live+auto must find an eligible, authoritative DB row.
  if (COMPANY_FLAG && DRY_RUN) {
    return [{ company: COMPANY_FLAG, title: "Backend role", link: "", _manual_preview: true }];
  }
  const state = readDatabaseState(resolveDbPath(), COMPANY_FLAG || "");
  if (!state.ok) {
    console.log(`[DB] ${state.error}; no jobs selected`);
    return [];
  }
  const eligible = state.jobs.filter((job) => isEligibleJob(job, { requirePauseKnown: true }));
  console.log(`[DB] ${eligible.length} eligible real jobs (send_paused=${state.send_paused})`);
  return eligible.slice(0, 5);
}

async function main() {
  const profile = loadProfile();
  console.log(`[Mode] ${DRY_RUN ? "DRY-RUN" : "LIVE PREVIEW (standalone sending disabled)"}`);
  if (AUTO) {
    console.error("[guard] standalone LinkedIn DM/invitation sending is disabled; use guarded apply.mjs for Easy Apply");
    process.exitCode = 6;
    return;
  }
  if (LIVE && !AUTO) {
    console.log("[guard] --live is preview-only; no DM or connection invitation is allowed");
  }
  if (!fs.existsSync(SESSION)) {
    console.error("[ERR] No session at portal/storageState.json — run: node apps/browser-apply/save_sessions.mjs");
    process.exitCode = 1;
    return;
  }

  const jobs = await loadJobs();
  if (!jobs.length) {
    console.log("[Jobs] none — no eligible Evaluated jobs are available");
    return;
  }
  console.log(`[Jobs] ${jobs.length} (send-enabled=${finalSubmissionAllowed()})`);

  const { chromium } = await import("playwright");
  let browser = null;
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      storageState: SESSION,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    try {
      await installLinkedInNavigationGuard(page);
    } catch (error) {
      console.error(`[ERR] LinkedIn navigation guard unavailable: ${String(error).slice(0, 120)}`);
      process.exitCode = 5;
      return;
    }

    if (!(await navigateLinkedIn(page, `${LINKEDIN_ORIGIN}/feed/`))) {
      console.error("[ERR] LinkedIn session check could not stay on the exact LinkedIn host");
      process.exitCode = 2;
      return;
    }
    const currentUrl = page.url();
    if (!isAllowedLinkedInUrl(currentUrl) || /\/login(?:[/?#]|$)|authwall/i.test(currentUrl)) {
      console.error("[ERR] LinkedIn session expired or redirected off-domain — re-run save_sessions.mjs");
      process.exitCode = 2;
      return;
    }
    console.log("[OK] LinkedIn session live");

    const results = [];
    for (const job of jobs) {
      console.log(`\n[Company] ${job.company}`);
      let found;
      try {
        found = await findPeople(page, job.company);
      } catch (error) {
        const reason = error?.code === "CAPTCHA_BLOCKED" ? "captcha-blocked" : String(error?.message || error).slice(0, 120);
        console.log(`  [error] ${reason}`);
        results.push({ job, error: reason });
        continue;
      }
      if (found.error || !found.people.length) {
        const reason = found.error || "no-people";
        console.log(`  [warn] ${reason}`);
        results.push({ job, error: reason });
        continue;
      }

      const lines = [`🔎 **LinkedIn outreach — ${job.company} (${job.title})**`];
      for (const person of found.people) {
        const draft = draftDM(profile, person, job);
        console.log(`  [person] ${person.name} — ${person.headline || "?"} — ${person.url}`);
        let dm = { sent: false, reason: DRY_RUN ? "dry-run" : "live-requires-auto" };
        if (finalSubmissionAllowed()) {
          try {
            dm = await sendDM(page, person, draft, job);
          } catch (error) {
            dm = { sent: false, reason: String(error?.message || error).slice(0, 80) };
          }
        }
        console.log(`  [dm] sent=${dm.sent} ${dm.via || dm.reason || ""}`);
        lines.push(
          `• **${person.name}** (${person.headline || "member"})\n  <${person.url}>\n  ` +
          `Draft: ${draft.slice(0, 200)}${dm.sent ? `\n  ✅ **Sent via LinkedIn (${dm.via || "dm"})**` : `\n  ⏳ Not sent (${dm.reason}) — draft above, please send by hand`}`
        );
        results.push({ job, person, dm: dm.sent, reason: dm.reason });
      }
      if (DRY_RUN || AUTO) {
        await notifyDiscord(lines);
      } else {
        console.log("  [Discord] live preview notification suppressed (no --auto)");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "output", "linkedin-outreach.json"),
    JSON.stringify({ ran_at: new Date().toISOString(), dry_run: DRY_RUN, live: LIVE, auto: AUTO, results }, null, 2),
    "utf-8",
  );
  console.log(`\n[+] Done → output/linkedin-outreach.json`);
}

export {
  AUTO,
  CAPTCHA_SELECTORS,
  DB_STATE_QUERY,
  JOB_STATUS_EXCLUSIONS,
  LINKEDIN_HOSTS,
  OUTREACH_STATUS_EXCLUSIONS,
  PENDING_G10_STATUSES,
  clickFinalAction,
  clickFinalControl,
  finalActionAllowed,
  finalActionGuard,
  finalSubmissionAllowed,
  findPeople,
  hasCaptcha,
  isAllowedLinkedInUrl,
  isEligibleJob,
  isExpectedLinkedInPath,
  isKnownPause,
  isLinkedInProfileUrl,
  isSimulationJob,
  linkedInUrl,
  normaliseStatus,
  readDatabaseState,
  readGlobalSendPaused,
  refreshJobForAction,
  resolveDbPath,
  sendDM,
  waitForCaptchaResolution,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error("[Fatal]", error);
    process.exitCode = 1;
  });
}
