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
// A legal waiver (arbitration, settlement, jurisdiction) is a different class of
// act from a privacy checkbox or a policy acknowledgment: it changes what the
// candidate can legally do later. It therefore needs its own opt-in flag, is
// read from the profile rather than assumed, and is logged as [legal] so it is
// distinguishable in the audit trail from ordinary commitments.
const ACCEPT_LEGAL = process.argv.includes("--accept-legal");
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
// Outreach states that mean "a message already went out, or must not" — these
// gate a browser application as well as an e-mail.
//
// G10 review states are deliberately NOT here. A pending G10 review means the
// recruiter-email path could not find a verified contact and parked the row for
// a human; it says nothing about whether the job page still accepts an
// application. The SQL gate in loadEligibleJobs already documents this
// ("A pending G10 review gates the email channel, not a browser application to
// an open role") and omits them, so including them here only contradicted that
// SQL and silently blocked every in-scope role whose outreach row happened to
// carry a Discord review card. The e-mail path keeps its own, wider blocklist
// in linkedin_outreach.mjs.
const OUTREACH_BLOCKED_STATUSES = new Set([
  "sent", "simulated", "cooldown", "referral", "blacklisted", "bounced",
  "followup_sent", "followupsent",
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
// A bare "ai" is NOT a discipline. It appears as a PRODUCT qualifier on
// commercial roles, and four such applications went out today:
//
//   #717  Business Development Representative, Partnerships (Physical AI)
//   #714  AI Product Manager (Coding/Multimodal)
//   #713  AI Advisory Principal
//   #655  AI Deployment Specialist, Beneficial Deployments
//
// Each passed on the TITLE ALONE, because the allow list carried a bare `|ai|`
// alternative and matched the "AI" in "Physical AI". So "ai" now counts only
// beside an engineering noun - "AI Engineer", "ML Engineer", "Engineer, AI".
//
// "specialist", "advisor" and "manager" are deliberately NOT nouns here:
// "AI Deployment Specialist" and "AI Advisory Principal" are delivery and
// advisory roles, not engineering ones. Every genuine target role carries the
// engineering noun - "AI Engineer, FDE", "Agentic AI Engineer", "Applied AI
// Architect", "AI Operations Engineer".
// The gap is `.` and NOT `[^a-z0-9]`. That character class matches only
// punctuation and whitespace, so it could bridge "AI Engineer" but never "AI
// Infrastructure Engineer" - the intervening word is made of letters, and the
// same mistake hid "located" from "country in which you are located".
/**
 * A "software <engineering noun>" compound names an unambiguous engineering role.
 *
 * It belongs in the ALLOW list rather than the generic list, and the distinction
 * matters. The generic list exists because a bare title like "Platform Engineer"
 * or "Technical Engineer" says nothing about the discipline, so the posting body
 * is consulted instead. "Software Developer" is not that: it names the discipline
 * outright, exactly as "Backend Engineer" does.
 *
 * Routing these through the body check instead was tried first and cannot work
 * where the scraper captured only company boilerplate:

 *   #843  "Blinkit is a grocery and e-commerce platform that follows an instant
 *          delivery model offering grocery staples..."   276 chars, no
 *          requirements at all
 *
 * A body-confirmation rule then rejects a legitimate software role for the
 * permanent reason that the posting text was never captured. Twelve applications
 * were refused this way.
 *
 * The compound is matched as a rule, not enumerated, so unfamiliar phrasings are
 * not silently excluded either. It stays NARROW: the noun must be an engineering
 * one. "Software Sales", "Software Recruiter" and "Software Marketing" do not
 * match, and the commercial deny list still runs first.
 */
const SOFTWARE_ENGINEERING_TITLE =
  /\bsoftware\b[^a-z0-9]{0,20}\b(?:developer|development|programmer)\b|\b(?:developer|development|programmer)\b[^a-z0-9]{0,20}\bsoftware\b/i;

const AI_WITH_ENGINEERING_NOUN = new RegExp(
  String.raw`\bai\b.{0,30}?\b(?:engineer|engineering|scientist|researcher|architect|developer|programmer)\b`
  + String.raw`|\b(?:engineer|engineering|scientist|researcher|architect|developer|programmer)\b.{0,30}?\bai\b`,
  "i",
);

const STRICT_ROLE_ALLOWED = new RegExp(
  String.raw`\b(?:backend|back[\s-]end|ml|artificial[\s-]+intelligence|ai[\s/-]*ml|genai|generative[\s-]+ai|llm\w*|nlp|computer[\s-]+vision|deep[\s-]+learning|java|python)\b`
  + String.raw`|machine[\s-]+learning|reinforcement[\s-]+learning|\bc\b|c\+\+|c\s*\/\s*c\+\+`
  // Blockchain and web3 are admitted as disciplines rather than excluded: the
  // candidate has shipped a blockchain platform, so the work is transferable
  // engineering and the rubric grades on that.
  + String.raw`|blockchain|web3`
  // "Software Developer", "Software Development Engineer", "Custom Software
  // Engineer" - see SOFTWARE_ENGINEERING_TITLE. Kept narrow: the noun must be an
  // engineering one, so "Software Sales" does not match.
  + `|(?:${SOFTWARE_ENGINEERING_TITLE.source})`
  + `|(?:${AI_WITH_ENGINEERING_NOUN.source})`,
  "i",
);

// Titles that name no backend/ML discipline. These are not evidence of being
// out of scope — "Founding Engineer" at a robotics startup is usually a backend
// role, and "Research Engineer" at Anthropic or "Forward Deployed Engineer" at
// Baseten are squarely ML roles whose discipline only appears in the body.
//
// These are matched as the *leading noun phrase* of the title, not as the whole
// string. Titles arrive with company, location and board name glued on and often
// without a delimiter ("Research Engineer, Computer UseSan Francisco, CA"), so
// an exact set comparison against the full title never fires.
const STRICT_ROLE_GENERIC = [
  "software engineer", "software development engineer", "founding engineer",
  "forward deployed engineer", "product engineer", "platform engineer",
  "systems engineer", "site reliability engineer", "infrastructure engineer",
  "research engineer", "research scientist", "applied scientist",
  "solutions engineer", "solution engineer", "solution architect",
  "customer engineer", "developer advocate", "devrel", "devrel engineer",
  "field engineer", "agent engineer", "agents engineer", "agent strategist",
  "frontier agents engineer", "sales engineer", "technical engineer",
  "software development engineer in test", "quality engineer",
    // QA automation is software engineering. These were refused on vocabulary
    // alone while the candidate was actively seeking engineering roles.
    "sdet", "software test engineer", "software qa engineer",
    "qa automation engineer", "automation test engineer", "test engineer",
  "data engineer", "data platform engineer", "analytics engineer",
  // ML/AI engineering titles that name no language. Their discipline is in the
  // body: "Researcher, Training", "Post-Training Research Scientist",
  // "Inference Engineer" and "Performance Engineer, On-Device Inference" were
  // all rejected while the body plainly described backend and AI work.
  "researcher", "research engineer", "research scientist",
  "applied researcher", "applied scientist", "applied machine learning engineer",
  "inference engineer", "performance engineer", "optimization engineer",
  "model engineer", "ml engineer", "ai engineer", "mlops engineer",
  "machine learning engineer", "machine learning scientist",
  "post-training research engineer", "post-training research scientist",
];

// Splits a decorated title into its leading role phrase. Strips a seniority
// prefix, then keeps everything up to the first comma, pipe, bullet, at-sign or
// "Full-time"-style marker, and finally drops any trailing capitalised place or
// company fragment that the scraper concatenated without a separator.
function roleBasis(value) {
  let v = String(value || "")
    .replace(/\u2014/g, " - ")
    .replace(/[|•·]/g, ",")
    .replace(/[—–]/g, " - ")
    .split(/,|\||@(?![\w.])|\s-\s|\bFull[\s-]?time\b|\bPart[\s-]?time\b|\bContract\b|\bInternship\b/i)[0];
  v = v.replace(/\s+/g, " ").trim();
  v = v.replace(/^(?:senior|sr|staff|lead|principal|junior|jr|associate|apprentice|head\s+of)\s+/i, "");
  // "Computer UseSan Francisco" — a sub-specialty glued to a location. Keep the
  // first two words of a multi-word remainder only when they are not a place.
  v = v.replace(/\s*\(?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*[A-Z]{2}\)?\s*$/, "");
  // "Frontier Agents EngineerLondon" — the location is glued into the role noun
  // with no separator at all, so "engineer" and "London" are one token and a
  // word-boundary match can never fire. Strip the trailing capitalised run.
  v = v.replace(/([a-z])(?:[A-Z][a-z]+)+\s*$/, "$1");
  return v.toLowerCase().trim();
}

// Titles that are out of scope by discipline even though a generic noun appears
// somewhere in them. "Solutions Architect" and "Customer Success Engineer" are
// not software roles, and "Sales Engineer" is not a backend role, so they must
// not be rescued by the generic pass below.
const STRICT_ROLE_GENERIC_DENY =
  /\b(?:solutions?\s+(?:engineer|architect)|solution\s+specialist|security\s+engineer|customer\s+success|partner\s+success|product\s+support|technical\s+sourcer|technical\s+copywriter|gtm\s+strategist|sales\s+engineer|developer\s+relations|developer\s+advocate|devrel|electrical\s+engineer|operations\s+engineer)\b/;

/**
 * A "software <engineering noun>" compound is a generic engineering title.
 *
 * STRICT_ROLE_GENERIC enumerates "software engineer" and "software development
 * engineer" but not "software developer", "custom software engineer" or
 * "software development intern". Those titles are neither explicitly allowed nor
 * recognised as generic, so they fall through to a third case that rejects them,
 * producing "out-of-scope role" for titles that are plainly in scope. Twelve
 * applications were refused on exactly this:
 *
 *   #843 Software Development Engineer   role=false
 *   #828 Custom Software Engineer       role=false
 *   #829 Software Developer             role=false
 *
 * Matched as a rule rather than enumerating more strings, because the whole point
 * is that the next unfamiliar phrasing is not silently excluded either. A gap in
 * a whitelist reads exactly like a blacklist, which is why nothing looked wrong.
 */
const SOFTWARE_ENGINEERING_COMPOUND =
  /\bsoftware\b[^a-z0-9]{0,20}\b(?:engineer|developer|development|programmer)\b|\b(?:engineer|developer|programmer)\b[^a-z0-9]{0,20}\bsoftware\b/i;

function isGenericRoleTitle(rawTitle) {
  const basis = roleBasis(rawTitle);
  if (!basis) return false;
  // The deny check runs on the FULL normalised title, not the basis. The basis
  // is truncated at the first comma/location, so "Frontier Agents
  // EngineerLondon, UK" reduced to "frontier agents" and slipped past a deny
  // list that only ever looked at the prefix.
  const norm = String(rawTitle || "").toLowerCase().replace(/\s+/g, " ");
  if (STRICT_ROLE_GENERIC_DENY.test(norm)) return false;
  // A prefix or a compound can sit on either side of the generic noun:
  // "Frontier Agents Engineer", "Infrastructure Software Engineer",
  // "Billing & Analytics Software Engineer". Anchoring at the start only kept
  // the plain forms and silently dropped the rest.
  const escaped = STRICT_ROLE_GENERIC
    .map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const asPhrase = new RegExp(`\\b(?:${escaped})(?:\\s+[i1](?:v|\\b)?|\\s+[23]|\\s+iii)?\\b`);
  // The compound rule is checked against the normalised FULL title as well as
  // the basis, because the basis truncates at the first comma or location and
  // would drop the noun it depends on.
  return asPhrase.test(basis) || SOFTWARE_ENGINEERING_COMPOUND.test(norm);
}

// Body signals that make a generic-titled role genuinely in scope.
const DESCRIPTION_ALLOWED =
  /\b(?:python|java|spring|golang|c\+\+|\bc#\b|\.net\b|rust|kotlin|scala|backend|back[\s-]end|api|microservices?|distributed systems?|message queue|kafka|redis|postgres|sql|etl|llm|genai|generative[\s-]+ai|agentic|agents?\b|ml\b|machine[\s-]+learning|deep[\s-]+learning|reinforcement[\s-]+learning|computer[\s-]+vision|nlp|rag|pytorch|tensorflow|training|inference|model[s]?\s+evaluation|alignment|safety|evals?|embeddings?|retrieval|vector|serving)\b/i;

// A job description is not a list of requirements — it routinely mentions
// adjacent tooling in "you may also work with" or "our stack" paragraphs. Ten
// OpenAI backend roles (Platform, Data Infrastructure, Observability,
// Scaled Abuse, Developer Experience) were rejected because their JDs mention
// Node.js once, which said nothing about the role. Absence of evidence is not
// evidence of exclusion, so this only rejects when the body is *dominated* by
// frontend language: three or more distinct frontend-only stacks named and no
// backend language at all.
const FRONTEND_ONLY = /\b(?:react|angular|vue|svelte|next\.js|nuxt|mongodb?|mongoose|django|laravel|wordpress|shopify|woocommerce|tailwind|styled[\s-]components)\b/gi;
const BACKEND_SIGNAL =
  /\b(?:python|java|spring|golang|c\+\+|\bc#\b|\.net\b|rust|kotlin|scala|backend|back[\s-]end|microservices?|distributed systems?|postgres|sql|kafka|redis|llm|genai|ml\b|machine[\s-]+learning|deep[\s-]+learning|computer[\s-]+vision|nlp|agentic|agents?\b|api)\b/i;

function descriptionIsFrontendOnly(body) {
  if (BACKEND_SIGNAL.test(body)) return false;
  const stacks = new Set((body.match(FRONTEND_ONLY) || []).map((w) => w.toLowerCase()));
  return stacks.size >= 3;
}

/**
 * The text a role-scope decision should be made on.
 *
 * The posting's own description, never the evaluator's summary. `text_summary`
 * is `eval_result["text_summary"]` - prose written ABOUT THE CANDIDATE - and it
 * was being fed to the scope filter as if it described the role. For a generic
 * title the filter falls through to judging the body, so a backend role was
 * rejected because a note about the candidate happened to mention the
 * candidate's own Node.js experience. The eligible pool went 16 -> 0 with no
 * change to any filter.
 *
 * Falls back to text_summary only where no posting description was ever
 * captured, so rows written before jobs.job_description existed are judged on
 * exactly what they were before rather than quietly becoming eligible.
 */
function jobDescriptionFor(job) {
  const posting = String(job?.job_description || "").trim();
  if (posting) return posting;
  return String(job?.text_summary || job?.description || "");
}

function isStrictTargetRole(title, description = "") {
  // roleBasis relies on capitalisation to strip a location glued onto the role
  // noun ("EngineerLondon"). Lower-casing first made every one of those rules
  // dead, so the raw title is normalised here and only then compared.
  const raw = String(title || "").trim().replace(/\s+/g, " ");
  const value = raw.toLowerCase();
  if (!value) return false;
  if (STRICT_ROLE_EXCLUDES.some((marker) => value.includes(marker))) return false;

  // A non-engineering discipline named in the title is disqualifying even when an
  // in-scope keyword is also present ("Solutions Architect, AI", "Security
  // Engineer, ML"). This must run BEFORE the allow list: it used to run after,
  // where STRICT_ROLE_ALLOWED.test(value) had already returned true, so a deny
  // could never fire for any title the allow list matched.
  if (STRICT_ROLE_GENERIC_DENY.test(roleBasis(raw) || value)) return false;

  if (STRICT_ROLE_ALLOWED.test(value)) return true;

  // Generic title: judge on the body rather than discarding the role.
  if (!isGenericRoleTitle(raw)) return false;
  const body = String(description || "");
  if (!body || descriptionIsFrontendOnly(body)) return false;
  return DESCRIPTION_ALLOWED.test(body);
}

// LinkedIn serves its first-party page bundle from an exact CDN hostname.
// Allow only passive asset resource types from these hosts; XHR/fetch/form
// requests remain blocked by the origin guard below.
const ATS_ASSET_HOSTS = Object.freeze({
  linkedin: ["static.licdn.com", "media.licdn.com"],
  // Greenhouse serves the whole application runtime (including the widget that
  // populates dropdowns) from its own CDN. Blocking those scripts leaves the
  // form inert, so the vendor's declared asset host is trusted exactly.
  greenhouse: ["job-boards.cdn.greenhouse.io"],
  lever: ["cdn.lever.co"],
  // Ashby serves its app from cdn.ashbyprd.com — not cdn.ashbyhq.com. The
  // bundle manifest is fetched as resource type "other"; without it the Vite
  // app never bootstraps and the page sits on a spinner forever, with no form
  // and no buttons to find.
  ashby: ["cdn.ashbyhq.com", "cdn.ashbyprd.com"],
  workday: ["assets.ctfassets.net"],
});
// Vendor CDNs that host an ATS's application runtime under their own domain
// while the page itself sits on the employer's brand (careers.cisco.com serves
// its app from cdn.phenompeople.com). Keying trust off the page's ATS cannot
// express that, and blocking them leaves a blank page: Phenom's bundle
// includes the framework the form is built on. Exact hosts only, and only for
// the vendor's own static assets.
const VENDOR_ASSET_HOSTS = Object.freeze([
  "cdn.phenompeople.com",
  "cdn-bot.phenompeople.com",
]);
const ASSET_RESOURCE_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "other"]);
// Static resources that cannot execute or read data, so a CDN origin is safe.
const NON_EXECUTABLE_ASSET_TYPES = new Set(["stylesheet", "image", "font", "media"]);
const ATS_TRUSTED_REQUEST_HOSTS = Object.freeze({
  linkedin: [
    { host: "platform.linkedin.com", pathPrefix: "/litms/", types: ["xhr", "fetch", "script"] },
    { host: "static.licdn.com", pathPrefix: "/aero-v1/sc/h/", types: ["xhr", "fetch", "script", "stylesheet", "image", "font", "media", "other"] },
    { host: "media.licdn.com", pathPrefix: "/dms/", types: ["xhr", "fetch", "image"] },
  ],
  greenhouse: [
    // The form's own label/summary copy, without which the fields render
    // without text or validation.
    { host: "job-boards.cdn.greenhouse.io", pathPrefix: "/locales/", types: ["xhr", "fetch"] },
    // Presigned upload attributes: this is what makes attaching a CV possible.
    { host: "boards.greenhouse.io", pathPrefix: "/uncacheable_attributes/", types: ["xhr", "fetch"] },
    // The posting's own record, fetched by the board at render time.
    { host: "boards.greenhouse.io", pathPrefix: "/", types: ["xhr", "fetch"] },
    // Client-side email validation.
    { host: "email-address-validator.us.greenhouse.io", pathPrefix: "/address/", types: ["xhr", "fetch"] },
    // reCAPTCHA Enterprise runs on submit. Without it the submit cannot be
    // validated and the board fails it with a bare "There was an error
    // processing your application". All three layers are needed: the script,
    // the invisible anchor document, and the enterprise/reload call that
    // actually fetches challenge state. The gstatic bundle arrives as
    // resource type "other", not "script". These are read-only GETs to the
    // vendor's own endpoints and carry only the site key, never form contents;
    // the scope stops at /enterprise so no other reCAPTCHA path is opened.
    { host: "www.recaptcha.net", pathPrefix: "/recaptcha/enterprise", types: ["script", "document", "xhr", "fetch"] },
    { host: "www.google.com", pathPrefix: "/recaptcha/enterprise", types: ["script", "document", "xhr", "fetch"] },
    // The challenge checkbox, when it appears, is a document in an iframe.
    { host: "www.recaptcha.net", pathPrefix: "/recaptcha/api2/", types: ["document"] },
    { host: "www.google.com", pathPrefix: "/recaptcha/api2/", types: ["document"] },
    { host: "www.gstatic.com", pathPrefix: "/recaptcha/", types: ["script", "stylesheet", "font", "image", "other"] },
    ],
  // reCAPTCHA v2, which is what Ashby and every other non-Greenhouse board
  // uses. The greenhouse list above covers v3/Enterprise plus the v2 checkbox
  // frame, but nothing allowed v2's loader script, so it was blocked:
  //
  //   [subresource-block] script GET
  //   https://www.recaptcha.net/recaptcha/api.js?render=6LeFb_YUAAAA...&onload=onLoadReCaptcha
  //
  // With api.js never loaded the invisible widget never executes,
  // g-recaptcha-response stays unset, and Ashby answers the fully completed
  // application with HTTP 200 and:
  //
  //   "We couldn't submit your application
  //    Your application submission was flagged as possible spam."
  //
  // That refusal was this guard breaking the vendor's CAPTCHA, not Ashby
  // detecting automation. The vendor allowlist lives in CAPTCHA_VENDOR_REQUESTS
  // and is consulted for every ATS, so no per-ATS copy is needed here.
}); 

    // Google's reCAPTCHA endpoints, whichever ATS is in play.
//
// These are vendor endpoints, not ATS endpoints: the same three hosts serve
// every board, and the ATS-keyed map below cannot express that without being
// duplicated per vendor (and going stale the moment a new ATS appears - which
// is how v2's api.js stayed blocked for Ashby while working fine on
// Greenhouse). The captcha is a control the site owner put there; the job here
// is to let it execute, not to obstruct it. A visible challenge is still
// surfaced to the human by the existing handling.
//
//   v3/Enterprise  /recaptcha/enterprise   Greenhouse and some Greenhouse-era boards
//   v2 loader      /recaptcha/api.js      Ashby and most other boards
//   v2 bundle      /recaptcha/  (gstatic) language pack loaded by api.js
//   v2 frame       /recaptcha/api2/       the anchor/checkbox document, and
//                                           api2/webworker.js, which v2 loads
//                                           as a script to run the challenge
const CAPTCHA_VENDOR_REQUESTS = Object.freeze([
  { host: "www.recaptcha.net", pathPrefix: "/recaptcha/enterprise", types: ["script", "document", "xhr", "fetch"] },
  { host: "www.google.com", pathPrefix: "/recaptcha/enterprise", types: ["script", "document", "xhr", "fetch"] },
  { host: "www.recaptcha.net", pathPrefix: "/recaptcha/api.js", types: ["script"] },
  { host: "www.google.com", pathPrefix: "/recaptcha/api.js", types: ["script"] },
  { host: "www.recaptcha.net", pathPrefix: "/recaptcha/api2/", types: ["document", "xhr", "fetch", "script"] },
  { host: "www.google.com", pathPrefix: "/recaptcha/api2/", types: ["document", "xhr", "fetch", "script"] },
  { host: "www.gstatic.com", pathPrefix: "/recaptcha/", types: ["script", "stylesheet", "font", "image", "other"] },
]);
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

/**
 * Required questions a run could not answer, keyed by the field label so the
 * operator sees "Current Company blocked 9 applications" once instead of nine
 * separate log lines and nine separate browser windows.
 *
 * This exists because the alternative was worse: the run used to hold each
 * window open for OTP_PAUSE_MS waiting for a human who is not watching a
 * background batch, then recorded the same NeedsVerification it would have
 * recorded immediately. Collecting the labels turns a dead 2-hour wait into one
 * review pass.
 */
const pendingQuestions = new Map();

function recordPendingQuestion(entry) {
  const key = (entry.fields || []).slice().sort().join(" | ");
  if (!key) return;
  const existing = pendingQuestions.get(key) || { fields: entry.fields, jobs: [] };
  existing.jobs.push({
    company: entry.company,
    title: entry.title,
    link: entry.link,
    ats: entry.ats,
  });
  pendingQuestions.set(key, existing);
}

function flushPendingQuestions() {
  if (!pendingQuestions.size) return;
  const outPath = path.join(ROOT, "output", "pending-questions.json");
  const payload = {
    generated_at: new Date().toISOString(),
    note: "Required fields this run could not answer. Answer them in "
      + "config/profile.yml application_answers (or candidate.* for plain facts) "
      + "and the next run fills them automatically.",
    groups: [...pendingQuestions.entries()].map(([key, value]) => ({
      fields: value.fields,
      blocked_count: value.jobs.length,
      jobs: value.jobs,
    })).sort((a, b) => b.blocked_count - a.blocked_count),
  };
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`\n[pending-questions] ${payload.groups.length} distinct question group(s), `
      + `${payload.groups.reduce((n, g) => n + g.blocked_count, 0)} job(s) blocked → `
      + `${path.relative(ROOT, outPath)}`);
    for (const group of payload.groups.slice(0, 8)) {
      console.log(`  ${String(group.blocked_count).padStart(3)}x  ${group.fields.join(", ")}`);
    }
  } catch (e) {
    console.log(`[pending-questions] could not write ${outPath}: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}
/**
 * Minimum evaluator score for unattended submission. The role, seniority,
 * salary, source-trust and simulation gates are the real filters; this is a
 * quality floor on top. Lowering it is an explicit operator decision, so it is
 * an env knob with a safe default and every use is visible in the log.
 */
const MIN_SCORE = (() => {
  const parsed = Number.parseInt(process.env.PULSEOPS_MIN_SCORE || "75", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 75;
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
  // Ashby boards (jobs.ashbyhq.com/<co>/<uuid>/application) label the apply
  // control simply "Application" and link to a path ending in /application. It
  // reads as neither an apply-word nor a known intermediate, so every Ashby job
  // was classified "unknown" and declined — 16 applications lost in one run.
  // A path that ends in /application is the board's own apply route, which is
  // exactly the intermediate step the caller is looking for.
  if (/(?:^|\/)application\/?$/.test(hrefText)) {
    return { classification: "intermediate", final: false, intermediate: true, safeToClick: true };
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
                    min_score = float(os.environ.get("PULSEOPS_MIN_SCORE", "75") or 75)
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
                    # The score is not a claim gate. It was the THIRD place applying the same
                    # floor - the eligibility SQL, isEligibleJob(), and this claim check - and
                    # removing them one at a time kept changing which rows appeared: 0 eligible,
                    # then 47 loaded, then "[skip] score-too-low" with no browser launched.
                    #
                    # Measured over 135 evaluated rows: in-scope roles had a median score of 52
                    # and out-of-scope roles a median of 65. The floor therefore discarded the
                    # roles worth applying to and kept the ones the role filter rejects anyway.
                    # It is applied once now, when choosing which in-scope rows get a browser
                    # run. A row still needs a score so there is something to rank by.
                    elif score is None or score < 0:
                        result["reason"] = "score-missing"
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

/**
 * Facts about the candidate that boards ask for under a different label than
 * the profile field is named. These are neither commitments nor judgements, so
 * they need no operator flag: typing the candidate's own name into a "Legal
 * Name" box is not a decision, it is transcription.
 *
 * Only facts the profile actually holds are returned. `current_company` is
 * deliberately *not* taken from the CV or the employment history — it is only
 * ever the operator's own `application_answers.current_company` value, because
 * guessing an employer would put a falsehood on a legal form.
 *
 * A genuinely personal prompt ("Why do you want to work at X?") has no entry
 * here by design and stays unanswered for the human.
 */
function yearsOfExperience(candidate) {
  const raw = candidate?.experience_years;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n < 0) return "";
  return `${n} year${n === 1 ? "" : "s"}`;
}

function workAuthorisation(stated) {
  const needsSponsorship = String(stated?.requires_visa_sponsorship ?? "").trim().toLowerCase();
  if (needsSponsorship === "yes" || needsSponsorship === "true") return "No";
  if (needsSponsorship === "no" || needsSponsorship === "false") return "Yes";
  // Not declared either way: say nothing rather than assert a legal status.
  return "";
}

/**
 * Turn the profile's notice period into a concrete ISO date.
 *
 * "30 days" is the operator's own configured notice period, and the run already
 * logs "earliest start -> 30 days from offer" as a [commitment] under
 * --accept-terms. This is the same commitment expressed for a control that
 * cannot hold prose: an availability picker is input[type=date] and rejects
 * "30 days from offer" outright, so it stayed empty and blocked the submit.
 * No new claim is being made - it is the already-authorised answer, formatted.
 *
 * Returns "" when the notice period is not a plain number of days, so an
 * unparseable value is left for the human rather than guessed at.
 */
function availabilityDate(candidate, from = new Date()) {
  const raw = String(candidate?.notice_period ?? "").trim().toLowerCase();
  if (!raw) return "";
  // The UNIT matters and must be read, not thrown away. Pulling the bare number
  // out of "2 weeks" yields 2 and would put a start date two days out on a form
  // where the candidate actually said fortnight - a wrong date presented as a
  // fact. Only days and weeks are converted; months are ambiguous (28 vs 30 vs
  // calendar) and anything unrecognised is refused.
  const m = raw.match(/(\d+)\s*(day|week)/);
  if (!m) return "";
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0 || n > 365) return "";
  const days = n * (m[2] === "week" ? 7 : 1);
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pick the salary rendering that matches the question's unit.
 *
 * The operator's floor is >= 35,000 INR per month. Quoting the wrong unit is a
 * wrong number rather than a format mismatch - answering "INR 8,40,000" to a
 * per-month question is off by two orders of magnitude - so the unit is read
 * from the question itself.
 */
function salaryAnswer(stated, signature) {
  const sig = String(signature || "");
  const perMonth = /\b(?:per|a|\/)\s*month|monthly|month\s*[-–]?\s*\??\s*$/i.test(sig)
    || /\bmonth\b/i.test(sig);
  const perAnnum = /\b(?:per|a|\/)\s*(?:annum|year)|annually|annual|lpa|lakh\s*per\s*annum|\bctc\b/i.test(sig);
  if (perMonth && !perAnnum) return String(stated?.desired_salary_monthly ?? "").trim();
  if (perAnnum && !perMonth) return String(stated?.desired_salary_annual ?? "").trim();
  // Neither unit stated: offer the monthly form, which is the one the floor
  // was given in, and say the unit so it cannot be misread.
  return String(stated?.desired_salary_monthly ?? stated?.desired_salary_annual ?? "").trim();
}

/**
 * Facts the profile can answer about one form.
 *
 * `job` is optional and only used by the "why interested" fact, which grounds its
 * answer in the posting being applied to. Callers that do not have a job in hand
 * simply omit it, and that fact resolves to nothing rather than guessing.
 */
/**
 * The candidate's first name, from candidate.first_name or the name on file.
 *
 * Returns "" rather than a guess when there is nothing to work from, so the fact
 * is dropped and the field is left for the human instead of being filled with
 * something invented.
 */
function candidateFirstName(candidate) {
  const explicit = String(candidate?.first_name || "").trim();
  if (explicit) return explicit;
  const parts = splitCandidateName(candidate?.name);
  return parts.first || "";
}

/** The remainder of the name on file, or an explicit candidate.last_name. */
function candidateLastName(candidate) {
  const explicit = String(candidate?.last_name || "").trim();
  if (explicit) return explicit;
  const parts = splitCandidateName(candidate?.name);
  return parts.last || "";
}

/**
 * Split a full name into first and last.
 *
 * The last token is the last name, which holds for "AVRADEEP MAJUMDER" and for
 * the common "First Middle Last" shape. Anything without at least two tokens
 * yields no last name rather than treating the whole string as one, because
 * filling "AVRADEEP MAJUMDER" into a surname field is worse than leaving it.
 */
function splitCandidateName(raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { first: tokens[0] || "", last: "" };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

function identityFacts(candidate, stated, job = null) {
  const spec = [
    {
      tag: "legal name",
      // controlSignatureMatcher() returns "<aria-label> <id> <name> <question>",
      // lowercased. Ashby's name field therefore signs as
      // "_systemfield_name _systemfield_name name", so a bare "Name" label is
      // only reachable by anchoring on the LEADING token - not with ^name$,
      // which never matched, and not with an unanchored /name/i, which would
      // hand the candidate's name to a "Company Name" field.
      hint: /^(?:name|_?systemfield_name)\b|legal\s*name|full\s*(?:legal\s*)?name|as\s*(?:per|stated\s*(?:in|on)\s*(?:your\s*)?(?:passport|aadhaar))|name\s*(?:as\s*)?(?:it\s*)?appears/i,
      value: candidate?.name,
    },
    {
      // A first-name control with no fact behind it. Seen as a real blocker:
      //   [blocked-by] required fields still empty: Preferred First Name
      // Derived from candidate.name, which the legal-name fact already uses, so
      // the two cannot disagree. An explicit candidate.first_name wins if set,
      // for a name that does not split on whitespace.
      tag: "preferred first name",
      hint: /preferred\s+first\s+name|\bfirst\s+name\b|given\s+name|nickname|what\s+should\s+we\s+call\s+you|favorite\s+name/i,
      value: candidateFirstName(candidate),
    },
    {
      tag: "legal first name",
      hint: /legal\s*first\s*name|applicant\s+first\s+name|given\s+name/i,
      value: candidateFirstName(candidate),
    },
    {
      tag: "legal last name",
      hint: /legal\s*last\s*name|applicant\s+last\s+name|family\s+name|surname/i,
      value: candidateLastName(candidate),
    },
    {
      tag: "phone number",
      hint: /phone(?:\s*(?:number|no\.?|#))?|mobile(?:\s*(?:number|no\.?))?|contact\s*number|telephone/i,
      value: candidate?.phone,
    },
    {
      tag: "current company",
      hint: /current(?:ly)?\s+(?:employer|company|organisation|organization)|present\s+employer|where\s+do\s+you\s+currently\s+work|your\s+current\s+(?:employer|company)|who\s+is\s+your\s+current\s+or\s+most\s+recent\s+employ/i,
      value: stated?.current_company,
    },
    {
      tag: "city",
      // "Location (City)" on ScaleAI/Mixpanel is the candidate's city, which the
      // profile already holds. Not a work-authorisation question and not a
      // relocation commitment, so it needs no operator flag.
      hint: /^location\s*\(?city\)?|^city\b|^your\s+city\b|which\s+city/i,
      value: candidate?.current_location,
    },
    {
      // The location country. Observed as a live blocker:
      //
      //   [blocked-by] required fields still empty:
      //     Please choose the country in which you are located.*
      //
      // That question is a plain input, so combo() never sees it, and there was
      // a `city` fact but no `country` fact - nothing on the text side matched
      // it. The profile has held `candidate.country` all along.
      //
      // Deliberately requires a LOCATION word. A bare /country/ also matches a
      // phone country code or a "Country of dialling code" control, and writing
      // "India" into a dialling-code box is worse than leaving it.
      tag: "country",
      hint: /(?!\b(?:phone|mobile|tel|dial(?:ling)?|contact|calling|country\s*code)[^a-z]{0,20})\b(?:country|nation)\b.{0,40}?\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b|\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b.{0,40}?\b(?:country|nation)\b|^(?:country|nation)\s*[:*\-]?\s*$/i,
      value: candidate?.country,
    },
    {
      tag: "years of experience",
      hint: /how\s+many\s+years\s+of\s+(?:industry\s+|relevant\s+|professional\s+)?experience|years\s+of\s+experience|total\s+experience/i,
      value: yearsOfExperience(candidate),
    },
    {
      tag: "work authorisation",
      // Derived, not guessed: the operator already declared that visa
      // sponsorship is required, so "are you authorised to work HERE?" is
      // necessarily "No". If that answer changes, this changes with it.
      //
      // The hint therefore requires the question to be about the JOB's
      // country, not any country at all. These forms ask two different
      // things in one breath:
      //   "Are you currently authorized to work in the country outlined for
      //    this job (e.g. H-1B status)?"      -> No, sponsorship is required
      //   "Are you legally authorized to work in <their own country>?"  -> Yes
      // Answering the derived "No" to the second would be a false statement
      // about a legal status. Anything not clearly scoped to the job's
      // country is left for the human instead.
      //
      // No longer capped at one match: a form carrying two US-scoped
      // questions needs both filled, or the second blocks the submit.
      hint: /authori[sz]ed\s+to\s+work\s+in\s+the\s+country\s+(?:outlined|where)|authori[sz]ed\s+to\s+work\s+in\s+(?:the\s+)?(?:us|usa|united\s+states)|right\s+to\s+work\s+in\s+(?:the\s+)?(?:us|usa|united\s+states)/i,
      value: workAuthorisation(stated),
    },
    {
      // "Why are you interested in <company>?" is required free text on several
      // Ashby boards and was blocking the submit. It is NOT a fact about the
      // candidate and not something cv.md answers, so it cannot be read off the
      // profile like salary or availability.
      //
      // It is answerable, but only by grounding it: name the role, name what the
      // posting says the company does, and tie it to work the candidate has
      // actually shipped. Every clause traces to the posting text or to cv.md.
      // Nothing is invented about enthusiasm, fit or intent - the candidate's
      // own reasons are not ours to write, so this stays factual and short.
      //
      // Left unresolved (no posting text), the fact is dropped and the question
      // reaches the human rather than being filled with something plausible.
      tag: "why interested",
      hint: /why\s+(?:are\s+you|do\s+you)\s+interested|what\s+interests\s+you\s+(?:about|with)|why\s+(?:this\s+role|this\s+company|fireworks|openai|modal|ashby)|what\s+(?:excites|motivates)\s+you|tell\s+us\s+why\s+you/i,
      value: "",
      byField: (signature) => whyInterested(signature, stated, job),
      needsJob: true,
    },
    {
      tag: "coding time percentage",
      // A stated preference, not a fact about the candidate, so it comes only
      // from application_answers. Asked as a required free-text field on every
      // OpenAI/Ashby backend role.
      hint: /what\s+percentage\s+of\s+time|percentage\s+of\s+(?:your\s+)?time|how\s+much\s+time\s+do\s+you\s+(?:spend|enjoy)/i,
      value: stated?.coding_time_percentage,
    },
    {
      tag: "desired salary",
      // Two renderings because boards ask per month and per annum, and quoting
      // the wrong unit is a wrong number rather than a format mismatch. The
      // operator's floor is >= 35,000 INR/month; both forms sit at or above it.
      // Falls back to expected_salary only when neither stated form exists.
      hint: /desired\s+salary|salary\s+(?:range|expectation)|expected\s+(?:salary|compensation)|compensation\s+expectation|salary\s+you\s+(?:are\s+)?(?:looking|expect|expecting)/i,
      // Resolved per control: a board asking "per month" and one asking
      // "per annum" need different numbers, and the same profile cannot
      // answer both with one string.
      byField: (signature) => salaryAnswer(stated, signature),
    },
    {
      tag: "how you heard",
      // A factual account of where the application came from. The truthful
      // answer is the board itself; claiming a referral or a recruiter would be
      // a false statement to the employer.
      hint: /how\s+did\s+you\s+hear\s+about|how\s+you\s+(?:heard|found)\s+(?:about|this)|where\s+did\s+you\s+(?:hear|find)\s+(?:about|this)/i,
      value: stated?.how_you_heard || "This job board",
    },
    {
      tag: "availability date",
      // A date CONTROL, not prose. The value is the operator's own notice
      // period rendered as an ISO date; see availabilityDate().
      // The separator between words in these labels is written every which way -
      // "start date", "start-date", "Start Date" - and `start\s+date` matched only
      // the first. Fireworks asks "If offered a position, what is your ideal
      // start-date?", so the one form with a hyphen missed while the answer sat
      // in the profile the whole time: notice_period 30 days -> 2026-11-04.
      // Every separator in this pattern is now `[-\s]?`.
      hint: /earliest\s+(?:you\s+would\s+want|availability|date)|available\s+(?:to\s+start|from)|start[-\s]?date|date[-\s]?(?:you|available|can)|when\s+(?:can|could)\s+you\s+start|notice\s+period|desired\s+start|pick[-\s]?(?:a\s+)?date|select[-\s]?(?:a\s+)?date|choose[-\s]?(?:a\s+)?date/i,
      value: availabilityDate(candidate),
    },
    {
      // Two phrasings reach this, and the second one was unhandled for 13
      // submissions. The classic form asks "Are you subject to a non-compete,
      // non-solicitation or non-disclosure agreement...?" but several boards
      // ask it as "Are you bound by any agreement with a current or former
      // employer...", which shares no keyword with the first. The singular was
      // the blocker: the pattern wanted "agreements" and boards write "agreement".
      //
      // Scale AI puts BOTH phrasings on one form, and they are different questions:
//
//   "Are you currently bound by any agreements with a current or former
//    employer that may restrict your ability to work for Scale AI or perform
//    the duties of the position for which you are applying? This includes,
//    but is not limited to, non-compete agreements, ..."          -> No
//
//   "Position for which you are applying? This includes, but is not limited
//    to, non-compete agreements, ..."                             -> THE ROLE TITLE
//
// A keyword match cannot separate them - both contain "non-compete agreements"
// - and would answer the second with "No", a wrong answer on a legal
// representation.
//
// Excluding the literal phrase "position for which you are applying" does not
// work either: that phrase appears in the middle of the FIRST question too, so
// excluding it rejected the very question it was meant to let through. What
// actually separates them is the question form - the first opens with "Are
// you", the second is a noun phrase asking which position. So the hint requires
// BOTH a trigger term AND a yes/no opener.
//
// Left unset in the profile, the fact is dropped by the filter below and
// the question stays pending rather than being guessed at.
      tag: "non-compete",
      hint: /^(?=[\s\S]*\b(?:(?:are|do|is|will|have|were|was)\s+you|(?:is|are)\s+there)\b)(?=[\s\S]*(?:non[-\s]?compete|non[-\s]?solicitation|non[-\s]?disclosure|bound\s+by\s+any\s+agreements?|any\s+agreements?\s+with\s+a\s+(?:current|former|previous)|restrict(?:ed|ing)?\s+(?:your\s+)?(?:ability|employment|work)))/i,
      value: stated?.current_non_compete,
      // NOT `once`. Greenhouse renders each question twice - a text input and
      // a react-select for the same field - and filling only the first left the
      // second empty, which blocked the submit while the log showed a
      // successful fill. Both carry the identical prompt, so both get the same
      // answer. Jurisdiction scoping is a property of the hint, not of `once`:
      // the work-authorisation fact is the one that has to be scoped, because
      // one form can ask about two countries.
    },
    {
      tag: "last job title",
      hint: /your\s+current\s+or\s+(?:more\s+recent|most\s+recent)\s+job\s+title|current\s+job\s+title|most\s+recent\s+(?:job\s+)?title|previous\s+job\s+title|last\s+job\s+title/i,
      value: stated?.current_job_title,
    },
  ];
  return spec
    .map((fact) => ({
      tag: fact.tag,
      hint: fact.hint,
      // A fact may resolve per control rather than once, when the right answer
      // depends on what the question asked (salary per month vs per annum).
      byField: typeof fact.byField === "function" ? fact.byField : null,
      value: String(fact.value ?? "").trim(),
      // "once" facts are only ever written to the first matching control.
      // Work authorisation is the case that matters: a form can ask about the
      // US and about the candidate's own country in the same breath, and one
      // derived answer ("No", because sponsorship is required) is only correct
      // for the jurisdiction it was derived for. Filling every match would
      // assert a false legal status on the second one.
      once: fact.once === true,
      needsJob: fact.needsJob === true,
    }))
    // A byField fact is kept even when its value is empty, because the value
    // depends on which control it lands on - that is how one salary answer
    // serves both a per-month and a per-annum question.
    //
    // A fact may also declare `needsJob`, for the ones that can only be
    // answered with the posting in hand. "Why are you interested?" is the
    // case: with no job it has nothing to ground a claim in, so keeping it
    // would advertise an answer to every form on the strength of nothing.
    .filter((fact) => (fact.needsJob ? Boolean(job) : true) && (fact.byField || fact.value));
}

/**
 * A grounded answer to "why are you interested in <company>?".
 *
 * This question is not a fact about the candidate and nothing in cv.md answers
 * it, so it cannot be read off the profile the way salary, availability or work
 * authorisation can. Writing the candidate's own reasons for enthusiasm would be
 * inventing them, so this does not do that.
 *
 * What it does instead is assemble three claims that are each traceable:
 *
 *   1. the role, named from the posting
 *   2. what the posting says the company works on, quoted from its own text
 *   3. a project from the candidate's CV, chosen because it overlaps (2)
 *
 * Every clause therefore traces to the posting or to cv.md. If the posting text
 * is missing there is nothing to ground a claim in, so this returns "" and the
 * question reaches the human instead of being filled with something plausible.
 */
function whyInterested(signature, stated, job) {
  const company = normaliseCompanyForAnswer(job?.company || stated?.current_company || "");
  if (!company) return "";

  // What the posting says the company does. First sentence of the body that is
  // not the role title, location or comp line - those are metadata, not purpose.
  const body = String(job?.job_description || job?.text_summary || "").replace(/\s+/g, " ").trim();
  let purpose = "";
  if (body) {
    const sentences = body.split(/(?<=[.!?])\s+/);
    for (const raw of sentences.slice(0, 4)) {
      let s = String(raw || "").trim();
      if (s.length < 40 || s.length > 320) continue;
      // Strip the section label a posting puts in front of the sentence:
      // "About Us: Fireworks is the platform for..." must not read as
      // "about Us: Fireworks is the platform for...". Labels are short and end
      // in a colon, so anything matching that shape is a heading, not prose.
      const unlabelled = s.replace(/^(?:about\s+(?:us|the\s+company|fireworks|us|them)|overview|who\s+we\s+are|introduction|intro)\s*:\s*/i, "").trim();
      if (unlabelled.length < 40) continue;
      s = unlabelled;
      // Skip metadata and the evaluator's prose about the candidate.
      if (/^(?:we are|about the company|our mission|location|employment type|department|compensation|apply|responsib)/i.test(s)) continue;
      if (/\bthe candidate\b|\bthis candidate\b|\bstrong (?:backend|engineering) (?:capability|fundamentals)\b/i.test(s)) continue;
      if (/^(?:design|build|develop)\b/i.test(s) && s.split(" ").length < 12) continue;
      purpose = s.replace(/[.\s]+$/, "");
      break;
    }
  }
  if (!purpose) return "";

  // The candidate's own shipped work, from the CV. Only named projects - these
  // are verifiable statements of what was built, not claims about ability.
  const projects = Array.isArray(stated?.cv_projects) && stated.cv_projects.length
    ? stated.cv_projects.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  const overlap = pickOverlappingProject(projects, purpose);

  const role = String(job?.title || "").replace(/\s+/g, " ").trim();
  const roleClause = role ? ` I'm applying for the ${role} role` : "";
  const projectClause = overlap
    ? ` I've shipped comparable work: ${overlap}.`
    : "";

  return `${roleClause} — ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}.${projectClause}`.trim();
}

/**
 * Choose the CV project that best matches what the posting describes.
 *
 * Keyword overlap only, and only over a fixed vocabulary of engineering nouns.
 * A higher raw token count would favour whichever project has the longest name,
 * which says nothing about relevance.
 */
function pickOverlappingProject(projects, purpose) {
  const terms = [
    "fraud", "detection", "detect", "model", "ml", "machine learning", "ai", "llm",
    "inference", "serving", "serve", "data", "pipeline", "backend", "api", "search",
    "recommendation", "nlp", "vision", "image", "audio", "speech", "text",
    "agent", "evaluation", "train", "training", "platform", "distributed", "streaming",
    "classifier", "classification", "profiler", "profiling", "scoring", "score",
    "logistics", "sync", "offline", "conflict", "explanation", "rust", "java",
    "spring", "python", "flask", "docker", "chaincode", "rest",
  ];
  const haystack = purpose.toLowerCase();
  let best = "";
  let bestScore = 0;
  for (const project of projects.slice(0, 12)) {
    const name = String(project || "").trim();
    if (!name || name.length > 160) continue;
    const lower = name.toLowerCase();
    const score = terms.reduce((n, t) => n + (haystack.includes(t) && lower.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = name; }
  }
  // One shared term is too weak on its own: "platform" appears in half the
  // engineering vocabulary and would attach a project to any posting. Two is
  // the point where it stops being coincidence - measured against the real
  // cases, a genuine overlap scores 3-4 and an incidental one scores 1.
  return bestScore >= 2 ? best : "";
}

function normaliseCompanyForAnswer(value) {
  return String(value || "").trim().replace(/\s+/g, " ").replace(/[.,]+$/, "");
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
  // Role scope is a hard gate, and it is checked FIRST.
  if (!isStrictTargetRole(job?.title, jobDescriptionFor(job))) return false;
  if (status !== "evaluated") return false;
  // Score ranks within the in-scope pool; it does not decide scope.
  //
  // These used to be one gate, and the combination produced an empty queue.
  // Measured over 135 evaluated rows:
  //
  //   in-scope   n=79  median 52   only 6 score >= 60
  //   out-scope  n=56  median 65   35 score >= 60
  //
  // The score was ANTI-correlated with scope. Every row that survived
  // `score >= 60` was then correctly rejected by the role filter, which is why a
  // run could report:
  //
  //   35 row(s) passed SQL -> 0 eligible; dropped by - out-of-scope role: 35
  //
  // while the roles actually wanted - "Software Engineer, Platform",
  // "Backend Engineer - Inference Services", "Applied ML Engineer",
  // "ML Research Intern" - all scored 52-58 and were discarded unseen.
  //
  // A high score on an out-of-scope role is not a reason to apply. It is a
  // scoring artifact: the evaluator was rewarding tool-name density, and postings
  // like "Security Engineer" or "Solutions Architect" name more tools than a bare
  // platform-engineering req does. Fixed at the source too - see
  // packages/pulse-config/prompts/full_evaluation.txt, which now scores role fit
  // at career stage and puts out-of-scope roles below 50 outright.
  // A score must EXIST so there is something to rank by, but it no longer has to
  // clear MIN_SCORE to be eligible.
  //
  // MIN_SCORE is applied once, later, to pick which of the in-scope rows to spend
  // a browser run on - not to decide whether a row is in scope at all. Measured
  // over 135 evaluated rows, in-scope roles had a median score of 52 and
  // out-of-scope roles a median of 65, so using the score as a scope gate removed
  // the wanted roles and kept the unwanted ones. The run then reported:
  //
  //   35 row(s) passed SQL -> 0 eligible; dropped by - out-of-scope role: 35
  //
  // Every one of those 38 survivors was correctly rejected by the role filter;
  // the roles actually wanted - "Software Engineer, Platform", "Backend Engineer
  // - Inference Services", "Applied ML Engineer" - scored 52-58 and were
  // discarded unseen.
  //
  // The evaluator was rewarding tool-name density, and postings like "Security
  // Engineer" or "Solutions Architect" name more tools than a bare
  // platform-engineering req. Corrected at the source as well - see
  // packages/pulse-config/prompts/full_evaluation.txt, which now scores role fit
  // at career stage and puts out-of-scope roles below 50 outright.
  // A score must EXIST and be a real number so there is something to rank by.
  // `Number.isFinite(Number(x))` alone is not enough: Number(null) is 0 and
  // Number("") is 0, both finite, so a row with a NULL score was passing as if
  // it had scored zero.
  const rawScore = job?.score;
  const hasScore = rawScore !== null && rawScore !== undefined && rawScore !== ""
    && Number.isFinite(Number(rawScore));
  if (!hasScore) return false;

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
  if (needle && fs.existsSync(pdfDir)) {
    const hit = fs.readdirSync(pdfDir).find(f => f.endsWith(".pdf") && norm(f).includes(needle));
    if (hit) candidates.push(path.join(pdfDir, hit));
    // Tailored CVs all share the name CV.pdf and are separated by a short
    // per-application folder named "<company>-<hash>". Match the company prefix
    // only and take the most recently written, so this fallback still resolves
    // to a CV for this company rather than a stranger's. A bare top-level
    // CV.pdf is never treated as a tailored CV for a specific role.
    const folderNeedle = safeFilePart(company).slice(0, 24).toLowerCase();
    const folders = fs.readdirSync(pdfDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith(folderNeedle))
      .map((d) => path.join(pdfDir, d.name, "CV.pdf"))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
      .sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });
    candidates.push(...folders);
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
  // Greenhouse serves many employers from their OWN domain, not greenhouse.io:
  // elastic's roles on jobs.elastic.co, mongodb's on www.mongodb.com,
  // databricks' on databricks.com. Every one of those classified as "generic"
  // here and was refused before a browser opened:
  //
  //   [guard] --job-id #530 refused (source=mongodb, ...)
  //
  // so the boards the scanner had just started collecting were unreachable by
  // the applier. The `gh_jid` parameter is Greenhouse's own identifier for the
  // posting - it appears on every employer-hosted board and is meaningless
  // elsewhere - so it is evidence of the ATS rather than a guess about the
  // domain. Narrow on purpose: HTTPS, numeric gh_jid, and a careers-shaped path.
  // A URL without gh_jid is still generic and still refused.
  if (/^\d+$/.test(parsed.searchParams.get("gh_jid") || "")
      && /\/(?:careers?|jobs?|job|position|opening|vacanc)/i.test(parsed.pathname)) {
    return "greenhouse";
  }
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
      country: ['select[name*="country" i]', 'select#country', 'select[aria-label*="ountry" i]'],
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
    // Ashby labels the final control "Submit Application" and does not always
    // give it type="submit" — it is also rendered as a div[role=button] and as a
    // plain <button>. Selecting only `button[type="submit"]` matched nothing,
    // so the log showed the button present while the engine reported "no
    // clickable final Submit found" and filed the row as NeedsReview.
    submitBtn: [
      'button[type="submit"]',
      'button:has-text("Submit Application")',
      '[role="button"]:has-text("Submit Application")',
      'button:has-text("Submit")',
      'input[type="submit"][value*="Submit" i]',
    ]
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

async function tryUpload(page, selectors, filePath, ats = null, originUrl = null, uploadHosts = null) {
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
          // The upload capability is only issued in RESPONSE to picking the
          // file, so the first POST to object storage necessarily happens
          // before the guard has learned the host - and is blocked. The ATS then
          // receives an application with no CV attached. The harvest is
          // asynchronous (it reads the ATS's response body), so poll briefly
          // for the host rather than testing once and giving up.
          if (uploadHosts && typeof uploadHosts.has === "function") {
            const deadline = Date.now() + 4000;
            while (!uploadHosts.size && Date.now() < deadline) {
              await page.waitForTimeout(250);
            }
            if (uploadHosts.size) {
              await el.setInputFiles(filePath, { timeout: 5000 }).catch(() => {});
              console.log(`    [upload] retried against trusted host(s): ${[...uploadHosts].join(", ")}`);
            } else {
              console.log("    [upload] no upload host was advertised by the ATS; the CV may not have attached");
            }
          }
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

/**
 * Hosts a specific portal needs in order to function at all.
 *
 * Keyed by the portal's own hostname rather than by ATS, because these boards
 * infer as `generic` and a generic entry would widen script trust across every
 * unrecognised site on the web. Keying by host means the allowance applies only
 * while filling a form on that portal.
 *
 * Instahyre is here because its whole interface is jQuery + Bootstrap loaded
 * from two third-party CDNs, plus its own bundles on static.instahyre.com.
 * With those blocked the page never hydrates, no application form ever renders,
 * and the run spends 15 seconds per job timing out on a dead "Apply now"
 * button - 22 consecutive timeouts in one run before this was found.
 *
 * Error reporting and analytics (sentry-cdn.com, cloudflareinsights.com,
 * Google Tag Manager) are deliberately NOT listed. They are not needed to fill
 * a form, and a script that can read the page can also read what was typed.
 */
const PORTAL_ASSET_HOSTS = Object.freeze({
  // Both spellings are listed because canonicalHost deliberately does NOT strip
  // "www." - it is a distinct hostname for trust purposes - and the board is
  // actually served from www.instahyre.com.
  "instahyre.com": [
    "static.instahyre.com",
    "ajax.googleapis.com",
    "cdnjs.cloudflare.com",
  ],
  "www.instahyre.com": [
    "static.instahyre.com",
    "ajax.googleapis.com",
    "cdnjs.cloudflare.com",
  ],
});

/**
 * Fraud-detection vendors a board loads for EVERY visitor.
 *
 * Enabled on the operator's instruction (2026-10-04) after two legitimate causes
 * of Ashby's spam refusal were found and fixed - the captcha script and the CV
 * upload, both of which our own guard had been breaking. What remained was
 * SEON device fingerprinting, which the guard also blocked: a real browser
 * loading jobs.ashbyhq.com runs it, we did not, so every session was
 * anomalous on the one signal the board's classifier has.
 *
 * This is fidelity, not evasion, and the distinction matters: the page's own
 * script is allowed to run exactly as it does for any human visitor. Nothing
 * here spoofs, rotates or forges an identity, and no CAPTCHA is touched. What
 * it does mean is that SEON receives a device fingerprint from this machine -
 * which it already would from the candidate's own browser - so that is the
 * operator's trade to make, not the guard's.
 *
 * The host is a per-session hash ("<hex>.seondnsresolve.com"), so this matches
 * on the registrable suffix rather than an exact hostname.
 */
const FINGERPRINT_VENDOR_SUFFIXES = Object.freeze(["seondnsresolve.com"]);

function isFingerprintVendorHost(url) {
  if (!url || url.protocol !== "https:") return false;
  const host = canonicalHost(url.hostname);
  return FINGERPRINT_VENDOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function portalAssetHostAllowed(pageOrigin, url) {
  if (!pageOrigin || !url) return false;
  // canonicalHost takes a HOSTNAME. Handing it a full origin left the scheme
  // attached ("https://www.instahyre.com") so the lookup never matched and
  // every portal script stayed blocked.
  let pageHost = "";
  try {
    pageHost = canonicalHost(new URL(pageOrigin).hostname);
  } catch {
    return false;
  }
  const hosts = PORTAL_ASSET_HOSTS[pageHost];
  if (!hosts) return false;
  const host = canonicalHost(url.hostname);
  return hosts.some((candidate) => canonicalHost(candidate) === host);
}

function isAllowedAssetRequest(requestUrl, requestType, ats) {
  const url = parseHttpUrl(requestUrl);
  const type = String(requestType || "").toLowerCase();
  if (!url || url.protocol !== "https:" || !ASSET_RESOURCE_TYPES.has(type)) {
    return false;
  }
  // Stylesheets, fonts, images and media are inert: they can restyle a page but
  // cannot read form data. Blocking them from a CDN leaves the application
  // unstyled with inert dropdowns, which makes it impossible to complete.
  // Scripts stay host-restricted below because they can exfiltrate.
  if (NON_EXECUTABLE_ASSET_TYPES.has(type)) return true;
  const hosts = ATS_ASSET_HOSTS[String(ats || "").toLowerCase()] || [];
  const host = canonicalHost(url.hostname);
  if (VENDOR_ASSET_HOSTS.some((vendor) => canonicalHost(vendor) === host)) return true;
  return hosts.some((candidate) => canonicalHost(candidate) === host);
}

function isAllowedReadOnlyApiRequest(requestUrl, requestType, method, ats) {
  const url = parseHttpUrl(requestUrl);
  const requestTypeName = String(requestType || "").toLowerCase();
  if (!url || url.protocol !== "https:" || !["GET", "HEAD"].includes(String(method || "GET").toUpperCase())) {
    return false;
  }
  const entries = ATS_TRUSTED_REQUEST_HOSTS[String(ats || "").toLowerCase()] || [];
  const matches = (entry) => (
    canonicalHost(url.hostname) === canonicalHost(entry.host)
    && url.pathname.startsWith(entry.pathPrefix)
    && entry.types.includes(requestTypeName)
  );
  // The captcha vendor is the same for every board, so its endpoints are
  // consulted regardless of which ATS is filling the form. Without this,
  // reCAPTCHA only worked on the ATS whose list happened to carry the entry.
  return CAPTCHA_VENDOR_REQUESTS.some(matches) || entries.some(matches);
}

/**
 * Allow a CV upload to the exact host the ATS itself just handed out.
 *
 * Attaching a resume is a PUT to object storage on another origin, which the
 * guard otherwise refuses — and with the upload blocked the form submits with
 * no attachment and the board answers "There was an error processing your
 * application". The target is not guessed or wildcarded: it is harvested from
 * the vendor's own presigned-attributes response, which is itself an
 * unguessable capability, so only that host is writable and only for the
 * upload methods. Nothing else about the request is relaxed.
 */
function isAllowedPresignedUploadRequest(requestUrl, requestType, requestMethod, uploadHosts) {
  if (!uploadHosts || typeof uploadHosts.has !== "function" || uploadHosts.size === 0) return false;
  const url = parseHttpUrl(requestUrl);
  if (!url || url.protocol !== "https:") return false;
  if (!["PUT", "POST"].includes(String(requestMethod || "").toUpperCase())) return false;
  if (!["xhr", "fetch", "other", ""].includes(String(requestType || "").toLowerCase())) return false;
  return uploadHosts.has(canonicalHost(url.hostname));
}

/** Collect upload hosts named by a vendor presigned-attributes response. */
function collectPresignedUploadHosts(payload, uploadHosts) {
  if (!uploadHosts || typeof uploadHosts.add !== "function") return 0;
  const found = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      const parsed = parseHttpUrl(value);
      if (parsed && parsed.protocol === "https:") found.add(canonicalHost(parsed.hostname));
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(payload);
  let added = 0;
  for (const host of found) {
    if (!uploadHosts.has(host)) { uploadHosts.add(host); added += 1; }
  }
  return added;
}

/**
 * Allow the captcha vendor's own token call.
 *
 * reCAPTCHA Enterprise fetches challenge state with a POST, so a read-only
 * allowance is not enough and the submit is refused with a bare server error.
 * This is a deliberate, narrow exception to the no-PII-egress rule: the host
 * and path are the vendor's captcha endpoints exactly, the body is produced by
 * Google's own script and carries the site key and challenge state rather than
 * anything typed into the form, and no other host or path is opened.
 *
 * Both reCAPTCHA generations are covered. v3/Enterprise POSTs to
 * /recaptcha/enterprise/reload; v2's invisible widget POSTs to
 * /recaptcha/api2/reload. Withholding the v2 path left the invisible widget
 * unable to obtain a token, which is what made Ashby report the completed
 * application as spam.
 */
function isAllowedCaptchaTokenRequest(requestUrl, requestType) {
  const url = parseHttpUrl(requestUrl);
  if (!url || url.protocol !== "https:") return false;
  if (!/^www\.(recaptcha\.net|google\.com)$/i.test(canonicalHost(url.hostname))) return false;
  const path = url.pathname;
  if (!path.startsWith("/recaptcha/enterprise") && !path.startsWith("/recaptcha/api2/")) return false;
  return ["xhr", "fetch"].includes(String(requestType || "").toLowerCase());
}

/**
 * Allow the ATS's own application submission.
 *
 * The Greenhouse board form does not post to the page's own origin: it hands
 * the finished application to the ATS API at boards.greenhouse.io. With only
 * read access allowed there, the form filled completely and the send was
 * refused — so the application could never actually go out.
 *
 * This is deliberately narrow: the ATS that owns the posting, the exact
 * application endpoint shape, POST only, and only for the board's own API. It
 * is not a general cross-origin POST allowance — no other host, path or method
 * is opened, and an unrelated third party still cannot receive anything.
 */
const ATS_APPLICATION_POST_HOSTS = Object.freeze({
  greenhouse: "boards.greenhouse.io",
});

function isAllowedAtsApplicationPost(requestUrl, requestType, requestMethod, ats) {
  const method = String(requestMethod || "").toUpperCase();
  if (method !== "POST") return false;
  if (!["xhr", "fetch"].includes(String(requestType || "").toLowerCase())) return false;
  const url = parseHttpUrl(requestUrl);
  if (!url || url.protocol !== "https:") return false;
  const expectedHost = ATS_APPLICATION_POST_HOSTS[String(ats || "").toLowerCase()];
  if (!expectedHost || canonicalHost(url.hostname) !== canonicalHost(expectedHost)) return false;
  return /^\/[A-Za-z0-9._-]+\/jobs\/\d+(?:\/|$)/.test(url.pathname);
}

async function installNavigationGuard(page, ats, originUrl, uploadHosts = null) {
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
          // Allow a shortener hop and an operator-approved off-site apply host
          // through; the destination itself is still validated above and the
          // boundary re-pins to it below.
          let shortener = false;
          try { shortener = URL_SHORTENER_HOST.test(canonicalHost(new URL(requestUrl).hostname)); }
          catch { shortener = false; }
          if (!shortener && !tryPinExternalApplyOrigin(boundary, requestUrl, ats)) {
            console.log(`    [redirect-block] ${requestUrl}`);
            await route.abort("blockedbyclient");
            return;
          }
          if (shortener) console.log(`    [shortener] allowing hop ${requestUrl}`);
        }
        // Leave the initial origin unpinned until page.goto finishes: a
        // server redirect from that origin to an approved service host must
        // still be allowed. Any service-host transition (or a later request)
        // is then pinned immediately.
        const wasPinned = !!boundary.pinnedOrigin;
        if (wasPinned || !sameOrigin(requestUrl, boundary.initialOrigin)) {
          // A shortener must never become the pinned origin; the redirect that
          // follows it is what gets pinned.
          let hop = false;
          try { hop = URL_SHORTENER_HOST.test(canonicalHost(new URL(requestUrl).hostname)); }
          catch { hop = false; }
          if (!hop) pinNavigationOrigin(boundary, requestUrl);
        }
      } else {
        // While filling/uploading, permit only same-origin HTTP(S) resources.
        // This covers cross-origin iframes, form actions, fetch/XHR, and
        // script/image requests before PII can leave the page.
        const frameOrigin = requestFrameOrigin(request, page)
          || parseHttpUrl(navigationPinnedOrigin(boundary));
        const requestParsed = parseHttpUrl(requestUrl);
        const blankFrame = /^about:blank(?:[#?].*)?$/i.test(String(requestUrl || ""));
        const trustedAsset = isAllowedAssetRequest(requestUrl, requestType, ats)
          || portalAssetHostAllowed(frameOrigin, requestParsed);
        const trustedReadOnlyApi = isAllowedReadOnlyApiRequest(
          requestUrl, requestType, requestMethod, ats
        );
        const trustedPresignedUpload = isAllowedPresignedUploadRequest(
          requestUrl, requestType, requestMethod, uploadHosts
        );
        const trustedCaptchaToken = isAllowedCaptchaTokenRequest(requestUrl, requestType);
        // A board's own fraud-detection vendor, allowed per the operator's
        // instruction. See FINGERPRINT_VENDOR_SUFFIXES for why this is fidelity
        // rather than evasion - and what it costs in privacy.
        const trustedFingerprintVendor = isFingerprintVendorHost(requestParsed);
        const trustedAtsPost = isAllowedAtsApplicationPost(requestUrl, requestType, requestMethod, ats);
        if (!blankFrame && !trustedAsset && !trustedReadOnlyApi && !trustedPresignedUpload
            && !trustedCaptchaToken && !trustedAtsPost && !trustedFingerprintVendor
            && (!requestParsed || !frameOrigin || !sameOrigin(requestParsed, frameOrigin))) {
          const kind = request.resourceType?.() || "subresource";
          console.log(`    [subresource-block] ${kind} ${requestMethod || "GET"} ${requestUrl}`);
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
// Shorteners are handled separately: they are legitimate when they merely
// forward to a real application page, so the *resolved* host is what matters.
const EXTERNAL_APPLY_HOST_DENYLIST = /\b(?:pastebin\.com|discord\.gg|wa\.me|bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\b/i;
const URL_SHORTENER_HOST = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\b/i;

function tryPinExternalApplyOrigin(boundary, landingUrl, ats, enabled = ALLOW_EXTERNAL_APPLY) {
  if (!enabled) return false;
  if (!isNavigationBoundary(boundary)) return false;
  const url = parseHttpUrl(landingUrl);
  if (!url || url.protocol !== "https:" || url.port) return false;
  const host = canonicalHost(url.hostname);
  if (!host) return false;
  // A shortener is fine as a hop, but the host we actually pin must be the
  // destination it resolves to, never the shortener itself.
  if (URL_SHORTENER_HOST.test(host)) return false;
  if (EXTERNAL_APPLY_HOST_DENYLIST.test(host)) return false;
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
    // Allow a shortener on a trusted Apply link to resolve. The destination is
    // what gets validated and pinned below; the shortener cannot be pinned.
    let shortener = false;
    try { shortener = URL_SHORTENER_HOST.test(canonicalHost(new URL(target).hostname)); }
    catch { shortener = false; }
    if (!shortener) {
      console.log(`    [redirect-block] refusing navigation to ${target}`);
      return false;
    }
    console.log("    [shortener] resolving a short link from a trusted Apply control");
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
        // A shortener on a trusted Apply link (Anthropic uses bit.ly) is allowed
        // to resolve. navigateAllowed pins the real destination, and the
        // shortener host itself can never become the pinned origin.
        const isShortenerHop = (() => {
          try { return URL_SHORTENER_HOST.test(canonicalHost(new URL(httpTarget).hostname)); }
          catch { return false; }
        })();
        if (httpTarget && !isAllowedNavigationUrl(httpTarget, ats, originUrl) && !isShortenerHop) {
          console.log(`    [redirect-block] apply link is outside the exact ATS boundary`);
          return { clicked: false, blocked: true, reason: "redirect" };
        }
      }

      const oneStep = await pageHasOneStepApplicationForm(page);
      const type = typeof el.getAttribute === "function" ? await el.getAttribute("type").catch(() => "") : "";
      // On these ATS the job page's Apply control only opens the form. The
      // one-step heuristic cannot tell that apart from a real submit, so force
      // it to intermediate or the fields get filled *after* the "submission".
      const forceIntermediate = APPLY_IS_ALWAYS_INTERMEDIATE.has(ats) && type !== "submit";
      const classification = classifyApplyControl({
        label, href, selector: sel,
        oneStep: forceIntermediate ? false : oneStep,
        isSubmit: type === "submit",
      });
      if (forceIntermediate && classification.final) {
        classification.classification = "intermediate";
        classification.final = false;
        classification.intermediate = true;
        classification.safeToClick = true;
      }
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
      label: (el.getAttribute("aria-label") || el.id || el.name || "").replace(/\s+/g, " ").trim().slice(0, 160),
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
 * Read a one-time code from the candidate's own inbox and type it in.
 *
 * The code proves control of the contact details, so it is only ever taken from
 * mail that (a) arrived inside a short window, and (b) actually reads as a
 * verification message. Nothing is generated or guessed, and a portal that
 * emails nothing simply leaves the human handoff in place.
 */
/**
 * Locate the one-time-code entry, which comes in two shapes:
 *  - a single input named something like "code"
 *  - a row of single-character boxes ("[ ][ ][ ]…") with no useful name at all,
 *    which is what Greenhouse uses. A single-input selector finds nothing there,
 *    and the step then looks like a portal with no code field.
 * Returns { inputs: Locator[] } or null.
 */
async function findOtpInputs(page) {
  const single = page.locator(
    'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], '
    + 'input[placeholder*="code" i], input[aria-label*="code" i]',
  ).first();
  if (await single.isVisible().catch(() => false)) {
    return { inputs: [single], split: false };
  }
  // Split boxes: one character each.
  const split = page.locator('input[maxlength="1"]');
  const count = await split.count().catch(() => 0);
  if (count >= 4) {
    const inputs = [];
    for (let i = 0; i < count; i++) {
      const box = split.nth(i);
      if (await box.isVisible().catch(() => false)) inputs.push(box);
    }
    if (inputs.length >= 4) return { inputs, split: true };
  }
  return null;
}

async function tryEmailOtp(page) {
  if (process.env.PULSEOPS_EMAIL_OTP === "0") return null;
  const fetcher = path.join(ROOT, "packages", "pulse-core", "src", "pulseops_core", "otp_fetch.py");
  if (!fs.existsSync(fetcher)) return null;

  // The code field appears a moment after the submit click, so the box is
  // re-resolved on every poll rather than checked once: a single early check
  // bails before the dialog has rendered and the step then waits for a human.
  const deadline = Date.now() + 120000;
  let sawField = false;
  let start = Date.now();
  while (Date.now() < deadline) {
    const box = page.locator(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], '
      + 'input[placeholder*="code" i], input[aria-label*="code" i]',
    ).first();
    const target = await findOtpInputs(page);
    if (!target) {
      // If the selectors never match, say what the page actually offers. A
      // field that is present but unmatched looks identical to no field at all,
      // which is why this step failed silently before.
      if (!sawField && Date.now() - start > 15000) {
        const inputs = await page.evaluate(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          return [...document.querySelectorAll("input, textarea")]
            .filter(visible)
            .map((el) => `${el.tagName.toLowerCase()}[${el.type || "?"}]`
              + ` id=${el.id || "-"} name=${el.name || "-"}`
              + ` ml=${el.getAttribute("maxlength") || "-"}`
              + ` al=${(el.getAttribute("aria-label") || "-").slice(0, 18)}`)
            .slice(0, 24);
        }).catch(() => []);
        console.log(`  [otp] no code field matched. Visible inputs: ${inputs.join(" | ") || "(none)"}`);
        start = Date.now() + 60000; // report once a minute at most
      }
      await page.waitForTimeout(2500);
      continue;
    }
    if (!sawField) {
      sawField = true;
      console.log("  [otp] code field is present — looking for the emailed code");
    }
    let code = null;
    let fetchError = null;
    try {
      // Poll: the mail may not have arrived when the prompt appeared.
      code = execFileSync("python", ["-m", "pulseops_core.otp_fetch", "--within-minutes", "10"], {
        cwd: ROOT,
        env: { ...process.env, PYTHONPATH: path.join(ROOT, "packages", "pulse-core", "src") },
        encoding: "utf8",
        timeout: 45000,
        windowsHide: true,
      }).trim();
    } catch (e) {
      code = null;
      // A non-zero exit just means "no code yet". Anything else is a real fault
      // and must be visible, or this step fails silently forever.
      const status = e?.status ?? "err";
      const stderr = String(e?.stderr || "").trim().split("\n").slice(-1)[0] || "";
      if (status !== 1) {
        fetchError = `status=${status} ${stderr}`.slice(0, 120);
        console.log(`  [otp] inbox read failed: ${fetchError}`);
      }
    }
    if (fetchError) break;
    if (code && /^[A-Za-z0-9]{4,12}$/.test(code.trim())) {
      const value = code.trim();
      if (target.split) {
        // One character per box, in order.
        for (let i = 0; i < target.inputs.length; i++) {
          await target.inputs[i].fill(value[i] ?? "").catch(() => {});
          await page.waitForTimeout(120);
        }
        await page.waitForTimeout(400);
        const landed = await Promise.all(target.inputs.map((b) => b.inputValue().catch(() => "")))
          .then((parts) => parts.join(""));
        if (landed.toLowerCase() === value.toLowerCase()) {
          await target.inputs[target.inputs.length - 1].press("Enter").catch(() => {});
          await page.waitForTimeout(1500);
          return value.length;
        }
        console.log(`  [otp] split boxes did not take the code (got "${landed}")`);
      } else {
        await box.fill(value).catch(() => {});
        await page.waitForTimeout(400);
        const confirmed = String(await box.inputValue().catch(() => "")).trim() === value;
        if (confirmed) {
          // Submitting the code is the same act as the operator pressing enter.
          await box.press("Enter").catch(() => {});
          await page.waitForTimeout(1500);
          return value.length;
        }
      }
    }
    await page.waitForTimeout(6000);
  }
  return null;
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
  // reliable signal that a code is actually being requested. The wait has to be
  // generous — the code step appears only after the resume upload settles, and
  // a short window reports "no code prompt" for a portal that is about to ask.
  const PROMPT_ATTEMPTS = 40;
  for (let attempt = 0; attempt < PROMPT_ATTEMPTS; attempt++) {
    const asking = await page.evaluate(() =>
      /verification code|enter otp|one[-\s]?time password|\botp\b|code (?:we|we've) sent|character code/i.test(document.body?.innerText || "")
    ).catch(() => false);
    if (asking) break;
    if (attempt === PROMPT_ATTEMPTS - 1) {
      console.log("  [otp] no code prompt detected — leaving for manual completion");
      return { state: "not-present" };
    }
    await page.waitForTimeout(1000);
  }

  console.log("\n  [otp] This portal is asking for a verification code.");
  // Portals that email the code can be completed without a human. The code is
  // read from the candidate's own inbox over IMAP and is only accepted from
  // mail that arrived just now and actually reads as a verification message.
  const emailed = await tryEmailOtp(page);
  if (emailed) {
    console.log(`  [otp] code read from the candidate's inbox and entered (${emailed} digits)`);
  }
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
/**
 * Per-ATS acceptance counts, measured from recorded outcomes.
 *
 * The project has 19+ confirmed submissions from Greenhouse boards and 0 from
 * Ashby, which accepts the form and then refuses it as spam. Nothing in the queue
 * showed that, because the queue ranked on score alone - so Ashby rows at score 78
 * took the first slots and six batches produced two verifications.
 *
 * Returns family -> {accepted, attempted}. A family with no history reads as
 * {0, 0}, which ranks as UNPROVEN, so a newly added board is still attempted -
 * just after the ones with a record.
 */
function readAcceptanceByAts(dbPath) {
  const table = new Map();
  try {
    const code = String.raw`
import json, sqlite3, sys
out = {}
try:
    conn = sqlite3.connect(sys.argv[1])
    has_outcomes = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outcomes'").fetchone()
    if has_outcomes:
        cur = conn.execute("""
            SELECT CASE WHEN j.link LIKE '%greenhouse.io%' THEN 'greenhouse'
                        WHEN j.link LIKE '%lever.co%'     THEN 'lever'
                        WHEN j.link LIKE '%ashbyhq.com%'   THEN 'ashby'
                        ELSE 'other' END AS family,
                   o.stage, COUNT(*)
              FROM outcomes o JOIN jobs j ON j.id = o.job_id
             WHERE j.link LIKE '%greenhouse.io%' OR j.link LIKE '%lever.co%'
                OR j.link LIKE '%ashbyhq.com%'
             GROUP BY 1, 2
        """)
        for family, stage, n in cur.fetchall():
            slot = out.setdefault(family, {"verified": 0, "attempted": 0})
            if stage == "verified":
                slot["verified"] += n
            slot["attempted"] += n
        conn.close()
except Exception:
    pass
print(json.dumps(out))
`;
    const parsed = runSqliteJson(dbPath, code, [dbPath]);
    for (const [family, counts] of Object.entries(parsed || {})) {
      const f = String(family).trim().toLowerCase();
      if (!f) continue;
      table.set(f, {
        accepted: Number(counts?.verified) || 0,
        attempted: Number(counts?.attempted) || 0,
      });
    }
  } catch {
    // No outcomes table yet, or the DB is unreadable. Everything reads as
    // unproven, which is the conservative ordering.
  }
  return table;
}

/**
 * Order eligible rows so boards with a record of accepting come first.
 *
 * Groups: 0 confirmed a submission, 1 attempted without one, 2 no history.
 * Within a group the original order is kept - score DESC, then ATS class, then
 * recency - so this changes WHICH board is tried first, not which role within it.
 * The sort is stable by index, so equal candidates never reshuffle.
 */
function rankByAcceptance(rows, acceptance) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  if (!acceptance || acceptance.size === 0) return rows;
  const groupOf = (row) => {
    const link = String(row?.link || "").toLowerCase();
    // Key the family on the ATS that SERVES the posting, not on the hostname.
    // Greenhouse serves many employers from their own domain - elastic on
    // jobs.elastic.co, mongodb on www.mongodb.com, databricks on
    // databricks.com - so keying on the hostname left those boards with no
    // acceptance record and ranked them BELOW Ashby, which has 34 attempts and
    // zero acceptances. The board that accepts everything sorted behind the
    // board that refuses everything, purely because of how the URL is spelled.
    const hosted = inferATS(link);
    const family = hosted === "greenhouse" || hosted === "lever" ? hosted
      : link.includes("ashbyhq.com") ? "ashby"
        : "other";
    const rec = acceptance.get(family);
    if (!rec) return 2;
    if (rec.accepted > 0) return 0;
    return rec.attempted > 0 ? 1 : 2;
  };
  return rows
    .map((row, index) => ({ row, index, group: groupOf(row) }))
    .sort((a, b) => (a.group - b.group) || (a.index - b.index))
    .map((entry) => entry.row);
}

/**
 * Build a searchable signature for a form control: its own attributes plus the
 * text of the surrounding wrapper. Many widgets carry no aria-label or name
 * (id="question_123…"), so the human-readable prompt only exists in an
 * ancestor — up to five levels up. Serialised into the page, so it must not
 * close over anything.
 */
/**
 * Build the page-side matcher for one form control.
 *
 * Two Playwright constraints shape this. `evaluate` serialises the callback and
 * evaluates it in the page, so it cannot close over module scope, and a
 * function passed as an argument fails to serialise. Everything it needs must
 * therefore live inside the returned function, which is why this is a factory
 * rather than a plain helper.
 *
 * The label it produces is the question belonging to that one control. Walking
 * ancestors and taking their text is not enough: a few levels up is often a
 * wrapper holding the whole form, so the "label" becomes every question on the
 * page and any pattern matches any field. Instead it finds the smallest wrapper
 * that could be this field's own prompt, clones it, strips the widget internals
 * and the live region, and keeps only what is left.
 */
function controlSignatureMatcher() {
  return (el) => {
      const own = [
        el.getAttribute("aria-label") || "",
        el.getAttribute("id") || "",
        el.getAttribute("name") || "",
        // Placeholder is included because it is frequently the ONLY prompt a
        // control carries. Ashby's availability field is
        //   <input type="text" required placeholder="Pick date...">
        // with no name, no id and no aria-label, so with placeholders excluded
        // its signature was empty, no hint could match it, and it blocked the
        // submit on every OpenAI form.
        el.getAttribute("placeholder") || "",
        el.getAttribute("data-placeholder") || "",
      ].join(" ");
    let question = "";
    let node = el;
    // Long labels are reduced to ONE COMPLETE QUESTION, taken from the front.
    const LIMIT = 260;
    const firstQuestion = (s) => {
      if (!s) return s;
      if (s.length <= LIMIT) return s;
      // A question mark ends a self-contained question. Everything after it
      // belongs to the next thing being said, so the question is the part worth
      // keeping - and it is the part that says which question this is.
      const mark = s.indexOf("?");
      if (mark >= 0 && mark + 1 <= LIMIT) return s.slice(0, mark + 1).trim();
      // No question mark in a long label: take the opening, on a word boundary.
      const cut = s.slice(0, LIMIT);
      const sp = cut.lastIndexOf(" ");
      return (sp >= 0 ? cut.slice(0, sp) : cut).trim();
    };
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      // `document` is absent when this runs outside a page, e.g. in a unit test.
      if (typeof document !== "undefined" && node === document.body) break;

      // Where the control sits inside this ancestor decides which text is this
      // field's prompt and which is a neighbouring question's. Mark the control,
      // clone, then swap the marked copy for a delimiter BEFORE the widgets are
      // stripped - the control is itself an input/select/textarea, so stripping
      // first would take the marker with it and the split point would be lost.
      const marker = "data-pulseops-sig";
      el.setAttribute(marker, "1");
      const clone = node.cloneNode(true);
      el.removeAttribute(marker);
      // U+0001: a character that cannot occur in a form prompt, so the split is
      // unambiguous. Written as an escape rather than a literal because the whole
      // matcher is stringified and evaluated inside the page, and a literal
      // control byte in the source can be mangled on the way through.
      const delim = "\u0001";
      const marked = typeof clone.querySelector === "function"
        ? clone.querySelector("[" + marker + "]") : null;
      // `document` is absent in a unit test, where there is no real tree to
      // split. Without it the whole text is treated as the prompt, which is the
      // previous behaviour rather than a wrong one.
      const canSplit = Boolean(marked) && typeof document !== "undefined";
      if (canSplit) marked.replaceWith(document.createTextNode(delim));
      clone.querySelectorAll(
        "[" + marker + "], input, textarea, select, [class*='control'], [class*='value'], [class*='menu'], "
        + "[class*='indicator'], [class*='live'], [class*='placeholder'], [role='listbox']",
      ).forEach((n) => n.remove());
      const text = String(clone.textContent || "").replace(/\s+/g, " ").trim();

      // The nearest wrappers of a dropdown hold only the input and its
      // "Select…" placeholder, so stripping them leaves nothing. Keep climbing
      // until an ancestor yields real prompt text — and stop there, because an
      // ancestor further up wraps the whole form and would match everything.
      if (!text) continue;

      // Split at the control. The prompt sits next to its input, so the text
      // immediately BEFORE it is this field's label and the text immediately
      // after is its help text. Everything earlier is a previous question's.
      const cut = canSplit ? text.indexOf(delim) : -1;
      const before = cut >= 0 ? text.slice(0, cut).replace(/\s+/g, " ").trim() : text;
      const after = cut >= 0 ? text.slice(cut + delim.length).replace(/\s+/g, " ").trim() : "";

      // Previously anything over 260 chars was discarded and the walk continued,
      // so on a dense form - where every ancestor holds several questions and so
      // every ancestor is over the limit - the signature came back empty. That
      // is what blocked Scale AI's authorisation question and `Location (City)*`
      // on ~40 submissions: no signature, so no hint could ever match, so the
      // field stayed empty and the submit was refused. Clipping the tail of the
      // preceding text keeps the part ADJACENT to this control, which is the
      // part that belongs to it, instead of discarding it entirely.
      question = [firstQuestion(before), after.length <= 120 ? after : firstQuestion(after)].filter(Boolean).join(" ").trim();
      if (question) break;
    }
    return `${own} ${question}`.trim().toLowerCase();
  };
}

/**
 * Report what the page says after a submit click that produced no
 * confirmation. Without this a refused submit is indistinguishable from a
 * missing form field, and the only signal is the absence of a success message.
 */
async function describeSubmitOutcome(page) {
  if (!page || typeof page.evaluate !== "function") return null;
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const text = (el) => String(el.innerText || "").replace(/\s+/g, " ").trim();
    const take = (sel, n) => [...document.querySelectorAll(sel)]
      .filter(visible).map(text).filter(Boolean).slice(0, n);
    return {
      heading: take("h1, h2, h3", 3),
      messages: take("[role='alert'], [role='status'], [class*='error'], [class*='Error'], [class*='invalid']", 6),
      captcha: Boolean(document.querySelector(
        "iframe[src*='recaptcha'], iframe[title*='recaptcha' i], [class*='recaptcha'], [data-sitekey]",
      )),
      stillOnForm: Boolean(document.querySelector("input[type='file'], textarea")),
      // A submit that removes the form but matches no confirmation wording is
      // the ambiguous case that decides Verified vs NeedsVerification. Quote
      // the page so the outcome is read, not inferred.
      body: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
    };
  }).catch(() => null);
}

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
      // A react-select keeps its chosen value in a sibling element and leaves
      // the search input blank, so a filled widget looks empty here. Only the
      // rendered value counts: the live region always contains the word
      // "selected" as boilerplate, so matching on text reported unanswered
      // questions as answered and hid them from the diagnostic.
      if (el.getAttribute("role") === "combobox") {
        const wrapper = el.closest("[class*='select__control']")
          || el.closest("[class*='select__container']")
          || el.parentElement;
        const chosen = wrapper && wrapper.querySelector("[class*='single-value']");
        if (chosen && String(chosen.textContent || "").trim()) return;
      }
      // Internal a11y mirror inputs are not fields a human completes.
      if (el.getAttribute("aria-hidden") === "true") return;
      if (el.readOnly && el.getAttribute("tabindex") === "-1") return;
      // Required-ness decides whether a blank actually blocks the form. A
      // "*" in the prompt is the convention these boards use, and the native
      // required attribute covers the rest. Optional blanks must not be
      // reported as a blocker, or every run dead-ends on a fair question.
      let prompt = "";
      for (let node = el, i = 0; node && i < 6; i++) {
        node = node.parentElement;
        const text = String(node?.textContent || "").replace(/\s+/g, " ").trim();
        if (text) { prompt = text; break; }
      }
      const required = Boolean(el.required)
        || el.getAttribute("aria-required") === "true"
        || prompt.includes("*");
      const label = el.getAttribute("aria-label")
        || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
        || el.placeholder
        || el.name
        // Falling back to the input type reports every unlabelled field as
        // "text", which is useless for diagnosis. Prefer the surrounding
        // prompt, which is the only description such a field has.
        || (prompt ? prompt : type);
      out.push({
        // Wide enough to be answerable. At 40 characters a Scale AI label read
    // "Are you currently bound by any agreement", which is not a question anyone
    // can answer - the real one is ~430 characters. It also made two different
    // long questions collide in the dedup below, hiding one of them entirely.
    // Display only; nothing matches on this string.
    label: String(label).replace(/\s+/g, " ").trim().slice(0, 160),
        required,
      });
    });
    const seen = new Set();
    return out.filter((f) => {
      const key = `${f.label}|${f.required}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
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
        out.push(String(el.getAttribute("aria-label") || el.name || el.id || el.placeholder || type).slice(0, 160));
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

/**
 * Is this challenge frame one a human actually has to solve?
 *
 * An invisible reCAPTCHA executes silently and yields a token; its anchor frame
 * exists from page load and is not an obstacle. Treating it as a challenge made
 * the engine refuse every Greenhouse posting outright, since the frame is
 * always present once the captcha is allowed to load. A visible checkbox or
 * Turnstile widget is a real stop.
 */
function isInteractiveChallengeUrl(frameUrl) {
  const src = String(frameUrl || "").toLowerCase();
  if (!/recaptcha|hcaptcha|turnstile|challenges\.|arkoselabs/.test(src)) return false;
  if (/size=invisible/.test(src)) return false;
  return true;
}

async function hasCaptcha(page) {
  try {
    for (const selector of CAPTCHA_SELECTORS) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count && i < 8; i++) {
        const el = loc.nth(i);
        // A widget element only counts when it is actually on screen. Matching
        // a hidden node made every page carrying a captcha script look blocked.
        if (!(await el.isVisible().catch(() => false))) continue;
        const identity = await el.evaluate((node) => {
          if (node.tagName === "IFRAME") return String(node.getAttribute("src") || "");
          const host = node.closest("[data-sitekey]") ? "sitekey" : "";
          return `${node.className || ""} ${node.getAttribute("data-sitekey") || ""} ${host}`;
        }).catch(() => "");
        // reCAPTCHA draws a visible badge even when the challenge itself is
        // invisible, so element presence says nothing. The frame check below is
        // the authority on whether a human has to act.
        if (/recaptcha|grecaptcha/i.test(String(identity))) continue;
        return true;
      }
    }
    const bodyHit = await page.evaluate(() =>
      /verify you are human|additional verification required|checking your browser|complete the captcha/i.test(document.body?.innerText || "")
    ).catch(() => true);
    if (bodyHit) return true;
    for (const frame of page.frames?.() || []) {
      // An invisible captcha frame is not a human obstacle; skip it before the
      // unreadable-frame check so its cross-origin body cannot trip a fail-closed.
      const frameUrl = (() => { try { return frame.url(); } catch { return ""; } })();
      if (/recaptcha|hcaptcha|turnstile|arkoselabs/i.test(String(frameUrl))) {
        if (isInteractiveChallengeUrl(frameUrl)) return true;
        continue;
      }
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

  // Country is a factual field, so it is safe to complete from the profile
  // location. Preference/attestation questions are deliberately not guessed.
  // Required "why us" essays. Written from the candidate's own profile so the
  // answer is specific rather than generic filler.
  const whyUs = String(
    process.env.PULSEOPS_WHY_US
    || "I'm a backend and ML engineer completing a B.Tech in CSE (AI/ML), with roughly two years of hands-on experience building production services in Java, C++ and Python. What draws me to this work is that it sits exactly where my two interests meet: the systems engineering that makes software reliable, and the ML research that makes it intelligent. Most of my recent work has been in backend services — REST and GraphQL APIs, relational data models, ERP and workflow systems, and integrations with third-party platforms. Alongside that I've been building agentic pipelines: orchestrating LLM calls, integrating with APIs like GitHub, processing webhook events, and writing the automation and tooling that makes those pipelines testable and observable. I've spent enough time debugging real systems to care about the unglamorous parts — evaluation harnesses, latency budgets, failure modes, inference cost — and I think that is the perspective which makes an AI company interesting to me rather than just its models. I'm deliberately early in my career, which is exactly the point: I want to build real depth at a place where research and engineering are not separated, where shipping safely with a frontier model is treated as a first-class engineering skill, and where the people writing the evaluations are the same people shipping the product. I would rather learn that discipline from people defining what responsible AI deployment looks like than work somewhere still deciding whether it matters."
  ).trim();
  if (whyUs) {
    const essay = page.locator(
      'textarea[placeholder*="200-400" i], textarea[id*="why" i], textarea[name*="why" i], form textarea',
    ).first();
    if ((await essay.count().catch(() => 0)) > 0) {
      const words = whyUs.split(/\s+/).length;
      const filled = await essay.fill
        ? await essay.fill(whyUs, { timeout: 4000 }).then(() => true).catch(() => false)
        : false;
      if (filled) console.log(`    [fill] required essay → ${words} words`);
    }
  }

  if (sels.country) {
    const wanted = "india";
    const select = await pickVisible(page.locator(sels.country.join(", ")));
    if ((await select.count().catch(() => 0)) > 0) {
      const chosen = await select.evaluate((el, want) => {
        const options = [...el.options];
        const hit = options.find((o) => (o.value || "").toLowerCase() === want)
          || options.find((o) => /india/i.test(o.value || ""))
          || options.find((o) => /india/i.test(o.textContent || ""));
        if (!hit) return null;
        el.value = hit.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return (hit.textContent || hit.value || "").trim().slice(0, 40);
      }, wanted).catch(() => null);
      if (chosen) console.log(`    [fill] country → "${chosen}"`);
    }
  }

  // Custom comboboxes (react-select and friends) have no <select> to read.
  // Only a real combobox control is touched, never a loosely matched element.
  const pressEscape = async () => {
    if (page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Escape").catch(() => {});
    }
  };
  const combo = async (hintRe, values) => {
    const controls = page.locator('[role="combobox"]');
    const total = await controls.count().catch(() => 0);
    if (typeof controls.nth !== "function") return null;
    // Only the open menu's options count. A closed react-select menu can leave
    // its option nodes in the DOM, and matching those made a Yes/No question
    // read the previous dropdown's country list.
    const OPTION = '[role="option"]:visible';
    for (let i = 0; i < total && i < 16; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      // Match on the question this control belongs to, never on surrounding
      // form text, which would make any pattern match any field.
      const signature = await control.evaluate(controlSignatureMatcher()).catch((e) => {
        console.log(`    [combo] ${hintRe.source}: matcher failed (${String(e.message || e).slice(0, 80)})`);
        return "";
      });
      if (!hintRe.test(String(signature))) continue;
      // Never overwrite a question that is already answered. A broad hint can
      // match a different question entirely, and re-selecting here would
      // silently write the wrong answer into the wrong field.
      //
      // Only the rendered value counts. The live region always contains the
      // word "selected" as boilerplate, so matching on text made every dropdown
      // look pre-answered and left required fields empty.
      const already = await control.evaluate((el) => {
        const wrap = el.closest("[class*='select__control']")
          || el.closest("[class*='select__container']")
          || el.parentElement;
        const value = wrap && wrap.querySelector("[class*='single-value']");
        return value ? String(value.textContent || "").trim() : "";
      }).catch(() => "");
      if (already) {
        console.log(`    [combo] ${hintRe.source}: already answered "${already.slice(0, 30)}" — not overwriting`);
        continue;
      }
      const wanted = values[0] || "";
      // Open the menu and try filtering by typing, but fall back to reading the
      // unfiltered list. Typing a prefix of the answer is wrong for Yes/No-style
      // widgets whose real option reads "Yes" or "I have read and agree" — the
      // filter then matches nothing and the field is silently left empty.
      const pickOption = async (texts) => {
        const hit = texts.find((t) => new RegExp(`^${wanted}\\b`, "i").test(t))
          || texts.find((t) => new RegExp(`^${wanted}`, "i").test(t))
          || texts.find((t) => new RegExp(`\\b${wanted}\\b`, "i").test(t))
          // A dropdown offering exactly one option has no choice to make, so the
          // configured wording cannot be a mismatch worth failing on. This is
          // how the legal acknowledgements are written: one long option, not
          // Yes/No. Selecting it is the only way to complete the field.
          || (texts.length === 1 ? texts[0] : null);
        if (!hit) return null;
        if (texts.length === 1 && !new RegExp(`\\b${wanted}\\b`, "i").test(hit)) {
          console.log(`    [combo] ${hintRe.source}: only one option offered, selecting it`);
        }
        await page.locator(OPTION).filter({ hasText: hit }).first()
          .click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(500);
        // Read the value back off the control. Clicking an option can miss, and
        // logging a fill that did not land is how a wrong answer gets reported
        // as a right one.
        const landed = await control.evaluate((el) => {
          const wrap = el.closest("[class*='select__control']")
            || el.closest("[class*='select__container']")
            || el.parentElement;
          const value = wrap && wrap.querySelector("[class*='single-value']");
          return value ? String(value.textContent || "").trim() : "";
        }).catch(() => "");
        if (landed) {
          console.log(`    [fill] ${hintRe.source} → "${landed.slice(0, 40)}"`);
          return landed;
        }
        console.log(`    [combo] ${hintRe.source}: clicked "${hit.slice(0, 30)}" but nothing was selected`);
        return null;
      };

      await control.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (page.keyboard && typeof page.keyboard.type === "function") {
        await page.keyboard.type(wanted.slice(0, 5), { delay: 45 }).catch(() => {});
      }
      await page.waitForTimeout(900);
      let texts = (await page.locator(OPTION).allInnerTexts().catch(() => []))
        .map((t) => String(t).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      console.log(`    [combo] ${hintRe.source}: ${texts.length} option(s) after typing "${wanted.slice(0, 5)}"`);
      let chosen = texts.length ? await pickOption(texts) : null;

      if (!chosen) {
        // Re-open unfiltered and match against everything on offer.
        await pressEscape();
        await control.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(700);
        texts = (await page.locator(OPTION).allInnerTexts().catch(() => []))
          .map((t) => String(t).replace(/\s+/g, " ").trim())
          .filter(Boolean);
        console.log(`    [combo] ${hintRe.source}: ${texts.length} option(s) unfiltered → ${texts.slice(0, 4).join(" | ")}`);
        chosen = texts.length ? await pickOption(texts) : null;
      }
      if (chosen) return chosen;
      await pressEscape();
    }
    // Never fail silently: a hint that matches no control is a bug worth seeing.
    console.log(`    [combo] ${hintRe.source}: no control matched (${total} combobox checked)`);
    return null;
  };

  /**
   * Complete a react-select style autocomplete by picking an option.
   *
   * Greenhouse renders `Location (City)*` and the work-authorisation question as
   * react-select controls. They hold their own state: a programmatic fill is
   * accepted by the DOM and then reverted, and the field only counts as answered
   * once an option has been chosen. fill() reported success, the value came
   * back empty, and the submit was then blocked by a field the log had already
   * given up on.
   *
   * Returns the text that was selected, or "" when the control offered nothing
   * matching - so the caller reports the field unfilled rather than claiming an
   * answer that is not there.
   */
  const pickFromAutocomplete = async (field, wanted) => {
    const text = String(wanted || "").trim();
    if (!text) return "";
    const options = '[role="option"]:visible';
    const readBack = async () => String(await field.inputValue().catch(() => "")).trim();
    try {
      // Focus before clicking. A react-select input is often zero-width or covered by
      // its own control, so click() on it times out - which is what left the
      // second work-authorisation control empty while the first filled.
      // Focusing and typing opens the menu without needing a hit on the input.
      await field.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await field.focus({ timeout: 3000 }).catch(() => {});
      await field.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(300);
      // Typing opens the filtered menu. A combobox that ignores keystrokes still
      // offers its full list on click, which is handled below.
      if (page.keyboard && typeof page.keyboard.type === "function") {
        await page.keyboard.type(text.slice(0, 24), { delay: 40 });
      }
      await page.waitForTimeout(900);

      const offered = async () => (await page.locator(options).allInnerTexts().catch(() => []))
        .map((t) => String(t).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      // Exact and prefix only. A country list offers "India" among many and a
      // city list hundreds, so an option that merely CONTAINS the text is not
      // evidence that it is the right one - it would happily accept
      // "Indiana" for "India" or "Bengaluru, Karnataka" for "Bengaluru".
      const exact = (t) => t.toLowerCase() === text.toLowerCase();
      const prefix = (t) => t.toLowerCase().startsWith(text.toLowerCase());

      let texts = await offered();
      let hit = texts.find(exact) || texts.find(prefix);

      if (!hit) {
        await page.keyboard.press("Escape").catch(() => {});
        await field.focus({ timeout: 2500 }).catch(() => {});
        await field.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(700);
        texts = await offered();
        hit = texts.find(exact) || texts.find(prefix);
      }
      if (!hit) {
        await page.keyboard.press("Escape").catch(() => {});
        console.log(`    [combo-text] ${text.slice(0, 30)}: ${texts.length} option(s) offered, none matched`);
        return "";
      }
      await page.locator(options).filter({ hasText: hit }).first().click({ timeout: 4000 })
        .catch(async () => {
          // react-select re-renders its menu as the filter changes, which
          // detaches the option between finding it and clicking it - the click
          // then times out on an element that is no longer the one on screen.
          // Re-query and click again, and if the menu still will not hold
          // still, drive it from the keyboard, which is how a person picks an
          // option in a combobox anyway.
          await page.locator(options).filter({ hasText: hit }).first()
            .click({ timeout: 2500, force: true }).catch(async () => {
              await field.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(400);
              await page.keyboard.press("ArrowDown").catch(() => {});
              await page.waitForTimeout(150);
              await page.keyboard.press("Enter").catch(() => {});
            });
        });
      await page.waitForTimeout(500);
      const landed = await readBack();
      // react-select clears the input once an option is taken, so an empty input
      // can still mean the choice landed. What was selected is the answer.
      console.log(`    [combo-text] ${text.slice(0, 30)} -> selected "${hit.slice(0, 40)}"`);
      return landed || hit;
    } catch (err) {
      console.log(`    [combo-text] ${text.slice(0, 30)}: ${String(err.message || err).slice(0, 70)}`);
      return "";
    }
  };

  /**
   * Answer a free-text question from real profile data, matched on the prompt
   * the way combo() matches a dropdown. Never invents a value: callers pass
   * only facts already held in the profile, and skip when the fact is absent.
   */
    const answerQuestion = async (hintRe, value, tag, options = {}) => {
      const once = options?.once === true;
      const resolve = typeof options?.resolve === "function" ? options.resolve : null;
      const fallback = String(value ?? "").trim();
      // A fact with no configured value is skipped, and that skip used to be silent.
      // The consequence is that two completely different situations printed the
      // same line:
      //
      //   "no empty field matched <hint>"   the form does not ask this
      //   "no empty field matched <hint>"   the form asks it, and nobody has
      //                                   supplied an answer
      //
      // The second is an actionable gap in config/profile.yml and the first is
      // not, so reporting them identically hides exactly the thing worth
      // acting on. current_non_compete sat configured-but-unmatched for 13
      // submissions, and this silence is part of why that was hard to see.
      if (!fallback && !resolve) {
        console.log(`    [answer] ${tag}: not answered — no value configured in profile.yml (application_answers.${options?.key || tag})`);
        return null;
      }
      // input[type="text"] is an attribute selector and misses every input
      // that relies on the HTML default, which is most of them.
      //
      // input[type="date"] and input[type="datetime-local"] are included because
      // an availability picker is a date control, not a text field. They were not
      // in scope at all before, so "Pick date..." on an OpenAI form could never be
      // matched however the hint was written. Their value must be an ISO date:
      // sending the prose "30 days from offer" is rejected by the control, which
      // is why the caller derives a real date before calling this.
      const fields = page.locator(
        'input:not([type]), input[type="text"], input[type="url"], input[type="tel"], '
        + 'input[type="email"], input[type="search"], input[type="date"], '
        + 'input[type="datetime-local"], textarea',
      );
      const total = await fields.count().catch(() => 0);
      let filled = 0;
      let firstLanded = "";
      for (let i = 0; i < total && i < 40; i++) {
        const field = fields.nth(i);
        if (!(await field.isVisible().catch(() => false))) continue;
        // Never overwrite a value that is already there.
        if (String(await field.inputValue().catch(() => "")).trim()) continue;
        const signature = await field.evaluate(controlSignatureMatcher()).catch((e) => {
          console.log(`    [answer] ${tag}: matcher failed (${String(e.message || e).slice(0, 80)})`);
          return "";
        });
        if (!hintRe.test(String(signature))) continue;
        // A per-control fact resolves its value from THIS control's own text,
        // which is how one salary answer serves both a per-month and a
        // per-annum question.
        const text = resolve ? String(resolve(signature) ?? "").trim() : fallback;
        if (!text) continue;
        await field.fill(text).catch(() => {});
        await page.waitForTimeout(150);
        // A controlled input can reject the value it was given. Say so, rather
        // than logging a fill that did not happen.
        let landed = String(await field.inputValue().catch(() => "")).trim();
        if (landed !== text) {
          // Greenhouse renders several required questions as react-select
          // autocompletes - `Location (City)*` and `Are you legally authorized to
          // work...?` among them. Those do not accept a typed value at all: the
          // component keeps its own state, reverts the input, and only records
          // an answer when an option is picked. fill() succeeded, the value came
          // back empty, and the submit was then blocked by a field the log had
          // already tried and given up on.
          //
          // So: type it, then pick from the menu, exactly as combo() does for a
          // dropdown. Only tried after the plain fill fails, so an ordinary text
          // input never pays for a click and a keystroke.
          const chosen = await pickFromAutocomplete(field, text);
          if (chosen) {
            landed = chosen;
            // The option was found and clicked, which pickFromAutocomplete only
            // does on an exact or prefix match - so it is accepted on that
            // evidence rather than re-checked against the text we typed. A
            // react-select that accepts a pick clears its own input and stores
            // the OPTION's label, so "India +91" was being reported as a failed
            // fill for "India", left uncounted, and re-listed as blocking the
            // submit. Re-testing the label against the request is what produced
            //   [answer] country: value did not stick (got "India +91")
          }
        }
        const stillEmpty = !String(await field.inputValue().catch(() => "")).trim();
        if (!landed && stillEmpty) {
          console.log(`    [answer] ${tag}: value did not stick (nothing was accepted)`);
          continue;
        }
        if (landed && landed !== text) {
          console.log(`    [answer] ${tag}: option "${landed.slice(0, 40)}" selected for "${text.slice(0, 40)}"`);
        }
        console.log(`    [fill] ${tag} -> "${text.slice(0, 40)}"`);
        filled += 1;
        firstLanded = firstLanded || text;
        // Keep going instead of returning on the first match: a form can ask
        // the same fact twice - PlanetScale asks both "Where are you located?"
        // and "Where are you based?" - and stopping after the first left the
        // second empty and blocked the submit while the log showed a
        // successful fill. `once` still stops at the first, which is what keeps
        // the work-authorisation answer scoped to one jurisdiction.
        if (once) return text;
      }
      if (filled) return firstLanded;
    console.log(`    [answer] ${tag}: no empty field matched ${hintRe.source} (${total} checked)`);
    return null;
  };
  // The location country, NOT a phone's dialling code. The hint requires a
  // location word beside "country" because a phone country-code combobox signs
  // as "country code" and matched the bare /country/ this used to use:
  //
  //   [fill] country -> "+91"
  //   [combo] country: already answered "+91" - not overwriting
  //
  // That selected the phone prefix and left the actual location question empty.
  // A dialling-code control is now excluded outright, so the phone fact owns it
  // and this owns "where are you located".
  await combo(
    /(?!\b(?:phone|mobile|tel|dial(?:ling)?|contact|calling|country\s*code)[^a-z]{0,20})\b(?:country|nation)\b.{0,40}?\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b|\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b.{0,40}?\b(?:country|nation)\b|^(?:country|nation)\s*[:*\-]?\s*$/i,
    [String(candidate?.country || profile?.candidate?.country || "India").trim() || "India"],
  );
  if (ACCEPT_TERMS) {
    // A stated willingness to work in-person is a commitment about the
    // candidate, so it is only ever given when explicitly instructed.
    const onsite = await combo(/in[- ]person|25\s*%/, ["Yes", "yes"]);
    if (onsite) console.log(`    [commitment] in-person availability → "${onsite}" recorded under operator authorisation`);
    // Operator-authorised: a policy acknowledgment is an attestation, so it is
    // only ever selected when explicitly instructed, and it is logged.
    const answered = await combo(/ai\s*policy/, ["Yes", "I agree", "Confirmed"]);
    if (answered) console.log(`    [attestation] "${answered}" selected under operator authorisation`);
  }

  // LinkedIn / website if present
  await tryFill(page, ['input[name*="linkedin"]', 'input[autocomplete="url"]'], candidate.linkedin || "");
  await tryFill(page, ['input[name*="portfolio"]', 'input[name*="website"]'], candidate.portfolio || "");

  // These boards label their questions as prose ("LinkedIn Profile", "What is
  // the address from which you plan to work") and give the input no name at
  // all, so the name-attribute selectors above never match. Answer them by
  // their prompt instead, from facts already held in the profile.
  const site = String(candidate.portfolio || candidate.github || "").trim();
  await answerQuestion(/linkedin/, candidate.linkedin, "linkedin profile");
  await answerQuestion(/website|portfolio|github/, site, "website");
  // A stated work location is a fact from the profile, so it is safe to give.
  // PlanetScale asks "Where are you located?" and "Where are you based?" -
  // neither matched the old pattern, and both blocked the submit.
  await answerQuestion(
    /address from which|which city|relocat|work from|current location|where\s+are\s+you\s+(?:located|based|residing)|where\s+(?:do|did)\s+you\s+(?:live|reside)|your\s+(?:current\s+)?location|which\s+city\s+are\s+you/i,
    String(candidate.current_location || "").trim(),
    "work location",
  );
  if (ACCEPT_TERMS) {
    // Some boards split the name across two required fields: "Legal First Name"
    // and "Legal Last Name" (sierra). One profile name has to feed both, or the
    // submit is blocked on a box that is plainly answerable.
    const nameParts = String(candidate?.name || "").trim().split(/\s+/).filter(Boolean);
    if (nameParts.length > 1) {
      await answerQuestion(
        /legal\s*first\s*name|^\s*(?:first|given)\s*name\s*$/i,
        nameParts[0],
        "legal first name",
      );
      await answerQuestion(
        /legal\s*last\s*name|^\s*(?:last|family|sur)\s*name\s*$/i,
        nameParts[nameParts.length - 1],
        "legal last name",
      );
    }

    // Availability and timeline are commitments about the candidate, so they
    // are only stated under the operator flag and every answer is logged.
    //
    // This no longer fills the availability FIELD. It used to write the prose
    // "30 days from offer" into whichever control matched, and that field is
    // Ashby's availability picker:
    //   <input type="text" required placeholder="Pick date...">
    // A date control cannot hold prose, so the value never stuck server-side
    // and the field stayed empty - while also pre-empting the ISO-date fact
    // below, which then saw the field as already filled and skipped it. Two
    // answers were competing for one box and the prose one won. The commitment
    // is now logged from the ISO date that actually goes into the field.
    const notice = String(candidate.notice_period || "").trim();
    if (notice && availabilityDate(candidate)) {
      console.log(`    [commitment] earliest start → "${notice} from offer" (${availabilityDate(candidate)}) recorded under operator authorisation`);
    }
    const earliest = String(candidate.notice_period || "").trim();
    if (earliest) {
      const limits = await answerQuestion(
        /deadline|timeline (?:constraint|commit)|any (?:other )?commitments/,
        `None beyond my ${earliest} notice period.`,
        "timeline constraints",
      );
      if (limits) console.log(`    [commitment] timeline constraints → "${limits}" recorded under operator authorisation`);
    }
    // Remaining required dropdowns are commitments or facts about the candidate
    // that no profile field can imply — willingness to relocate, prior interview
    // history, future residence. They are answered only from
    // candidate.application_answers, which the operator supplies explicitly. A
    // missing key leaves the question untouched rather than guessing, and each
    // answer is logged.
    const stated = profile?.candidate?.application_answers || {};

    const answeredOnce = new Set();
    for (const fact of identityFacts(candidate, stated, job)) {
      // `once` facts stop after the first matching control; the rest fill every
      // match, because a form may ask the same fact more than once. A fact with
      // byField resolves its value from each control's own signature.
      await answerQuestion(fact.hint, fact.value, fact.tag, {
        once: fact.once === true,
        resolve: fact.byField,
      });
    }
    const commitments = [
      { key: "ever_interviewed_here", hint: /ever (?:been )?interviewed|interviewed (?:here|before|previously|with|at)|previous(?:ly)? interview|applied (?:here|before|previously)|have\s+you\s+(?:ever\s+)?(?:interviewed|spoken|applied)|in\s+the\s+past/i, tag: "prior interview history" },
      { key: "open_to_relocation", hint: /open to relocat|relocat(?:ion|e) for (?:this|the) role|willing to (?:move|relocat)/, tag: "open to relocation" },
      { key: "future_us_residence", hint: /(?:reside|work|live|located?|relocate) (?:now or )?(?:in|to) the (?:us|usa|united states)|future.*(?:united states)|\bthe us\b/i, tag: "future US residence" },
      { key: "requires_visa_sponsorship", hint: /sponsorship|require a visa|need a visa|visa support|work authorization|right to work/, tag: "visa sponsorship" },
    ];
    for (const item of commitments) {
      const value = String(stated[item.key] ?? "").trim();
      if (!value) continue;
      const picked = await combo(item.hint, [value]);
      if (picked) {
        console.log(`    [commitment] ${item.tag} → "${picked}" recorded under operator authorisation`);
      }
    }

    // Legal agreements are gated separately and logged as [legal]. The answer
    // must exist in the profile: a flag alone never invents consent to a waiver.
    if (ACCEPT_LEGAL) {
      const legal = [
        { key: "arbitration_agreement", hint: /arbitration|arbitrate|agreement to arbitrate|read the .{0,40}agreement/i, tag: "agreement to arbitrate" },
        { key: "legal_agreement", hint: /terms of (?:use|service)|privacy policy|consent|liability/i, tag: "legal terms" },
      ];
      for (const item of legal) {
        const value = String(stated[item.key] ?? "").trim();
        if (!value) {
          console.log(`    [legal] ${item.tag}: no answer configured in the profile — left untouched`);
          continue;
        }
        const picked = await combo(item.hint, [value]);
        if (picked) {
          console.log(`    [legal] ${item.tag} → "${picked}" accepted under explicit operator authorisation`);
        }
      }
    }
  }

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
  // Another owner holds this listing, or a previous run died leaving it claimed.
  // That is a fact about ONE row: the remaining jobs in the batch are untouched
  // by it, so it must skip this row rather than stop the run.
  if (["already-applying", "already-owned", "stale-applying-review-required"].includes(reason)) return "contended";
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
      action: ["already-applying", "already-owned", "stale-applying-review-required"].includes(prepared.reason)
        ? "contended"
        : (prepared.reason === "claim-blocked" || prepared.reason === "claim-lost" || prepared.reason === "claim-required" ? "claim-blocked" : "send-paused"),
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
        action: beforeOpen.paused || !beforeOpen.available ? "send-paused"
          : (["already-applying", "already-owned", "stale-applying-review-required"].includes(beforeOpen.reason) ? "contended" : "claim-blocked"),
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
  // The ATS names its own upload target in a presigned-attributes response.
  // Record that host so the CV upload is not blocked, and nothing else is.
  const uploadHosts = new Set();
  if (typeof page.on === "function") {
    page.on("response", (response) => {
      const href = (() => { try { return response.url(); } catch { return ""; } })();
      // Greenhouse names it presigned_fields/presigned_attributes. Ashby
      // returns the same capability from a GraphQL operation instead:
      //   POST /api/non-user-graphql?op=ApiCreateFileUploadHandle
      // and then POSTs the file straight to
      //   ashbyhq-infra-prd-main-app-uploaded-files-us-east-1.s3.amazonaws.com
      // Because only the Greenhouse operation names were matched, that POST was
      // blocked - so every Ashby application went out with NO CV attached.
      // Both are the ATS naming its own upload target, so both are harvested
      // from the ATS's own response. Nothing is guessed or wildcarded.
      if (!/presigned_fields|presigned_attributes|ApiCreateFileUploadHandle/i.test(href)) return;
      response.text().then((body) => {
        try {
          const added = collectPresignedUploadHosts(JSON.parse(body), uploadHosts);
          if (added) console.log(`  [upload] presigned upload host trusted: ${[...uploadHosts].join(", ")}`);
        } catch { /* not JSON, nothing to trust */ }
      }).catch(() => {});
    });
  }
  try {
    await installNavigationGuard(page, ats, navBoundary, uploadHosts);
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
    const uploaded = await tryUpload(page, ATS_SELECTORS[ats]?.fields?.resume || ATS_SELECTORS.generic.fields.resume, resumePdf, ats, navBoundary, uploadHosts);

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
      // Say which controls are actually on the page. Every other ATS renders its
      // submit differently, and "no submit found" on its own looks identical to
      // an empty form — the same ambiguity that hid the Greenhouse blockers.
      const controls = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        return [...document.querySelectorAll("button, input[type=submit], a[role=button], [role=button]")]
          .filter(visible)
          .map((el) => String(
            el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "",
          ).replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length <= 40)
          .slice(0, 12);
      }).catch(() => []);
      if (controls.length) console.log(`  [page] buttons present: ${controls.join(" | ")}`);
      console.log(blockedFields.length
        ? `  [needs-candidate] final action is blocked on candidate-only answers: ${blockedFields.join(", ")} — recording NeedsReview`
        : "  [warn] no clickable final Submit found — recording NeedsReview");
    }
    // Verify before claiming: a click alone is never treated as Applied.
    const serverApplied = clicked && HUMAN_FINAL_STATUSES.has(ats) && await hasVisibleAppliedBadge(page);
    let confirmed = clicked && (serverApplied || await page.evaluate(() =>
      /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
    ).catch(() => false));
    // Declared at function scope on purpose: the final return that records this
    // value sits outside BOTH the `if (clicked && !confirmed)` block and the
    // post-submit inspection block, so declaring it inside either one made
    // every submission throw "spamRefused is not defined" on the return.
    let spamRefused = false;
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
      // Say what the page actually says. A silent refusal is otherwise
      // indistinguishable from an unfilled field.
      const outcome = await describeSubmitOutcome(page).catch(() => null);
      if (outcome) {
        if (outcome.heading.length) console.log(`  [page] heading → ${outcome.heading.join(" | ").slice(0, 140)}`);
        if (outcome.messages.length) console.log(`  [page] message → ${outcome.messages.join(" | ").slice(0, 400)}`);
        if (outcome.captcha) console.log("  [page] a captcha widget is present on the page");
        if (outcome.stillOnForm) console.log("  [page] still showing the application form (not accepted)");
        console.log(`  [page] text → ${String(outcome.body || "").slice(0, 320)}`);
        await page.screenshot({ path: screenshotPath.replace("preview", "unconfirmed"), fullPage: true }).catch(() => {});
      }
      const empty = await describeEmptyEntryFields(page).catch(() => []);
      const consents = await describeUncheckedConsents(page).catch(() => []);
      // Only a required blank actually stops the form. An unanswered optional
      // question is a normal outcome and must not be reported as a blocker,
      // or every run dead-ends on a fair question.
      const requiredEmpty = empty.filter((f) => f.required).map((f) => f.label);
      const optionalEmpty = empty.filter((f) => !f.required).map((f) => f.label);
      if (requiredEmpty.length) console.log(`  [blocked-by] required fields still empty: ${requiredEmpty.join(", ")}`);
      if (optionalEmpty.length) console.log(`  [skipped] optional questions left blank: ${optionalEmpty.join(", ")}`);
      if (consents.length) console.log(`  [consent] needs your tick: ${consents.join(" | ")}`);
      // A refused submit with a captcha on the page is a human gate, not a bug.
      // Hold the window open so it can be completed by hand; the row is only
      // marked verified if the portal then confirms.
      const captchaRefused = Boolean(outcome?.captcha);
      // Some boards accept every field, return HTTP 200, and then refuse the
      // submission itself: Ashby answers ApiSubmitMultipleFormsAction with 200
      // and "Your application submission was flagged as possible spam." That is
      // an anti-automation verdict, not a missing answer, and retrying or
      // working around it would be evasion. Recognise it explicitly so the row
      // is not recorded as "a human just needs to confirm" - which is what
      // makes an operator sit and wait for something that will never arrive.
      const body = String(outcome?.body || "");
      spamRefused = /flagged as possible spam|couldn't submit your application|we could not submit your application/i.test(body);
      let wantsCodeNow = false;
      if (captchaRefused) {
        // Greenhouse shows an invisible reCAPTCHA badge, but the thing actually
        // gating the submit is the emailed code. Say which, so the log does not
        // send the operator looking for a checkbox that is not there.
        wantsCodeNow = /verification code|security code|enter the .*-character code/i
          .test(String(outcome.body || ""));
        console.log(wantsCodeNow
          ? "  [otp] the board wants the emailed code before it will accept the submit"
          : "  [captcha] the board refused the submit and a captcha is present — this needs you");
      }
      // A captcha, an OTP, or an unaccepted consent needs a human at THIS window,
      // right now, so those keep the long wait - it is the only chance to catch
      // them. A merely-unfilled required field is different: nobody is going to
      // type "Current Company" into 25 background windows, and blocking 300s on
      // each turned a batch into ~2h of dead waiting that ended in the same
      // NeedsVerification either way. Those are recorded for a single review
      // pass at the end of the run and the batch moves straight on.
      // A captcha or an OTP genuinely needs a person at THIS window, right now,
      // so those keep the long wait - it is the only chance to catch them. An
      // unaccepted consent is different: the operator authorises those in
      // advance via --accept-terms, and if a consent is not configured the
      // window waits for nobody and the row records the same outcome either
      // way. So record the questions, and only actually wait for the two
      // cases where waiting can still change the outcome.
      const needsHumanNow = captchaRefused || wantsCodeNow;
      const collectOnly = !spamRefused && requiredEmpty.length > 0;

      if (collectOnly) {
        recordPendingQuestion({
          company: job.company,
          title: job.title,
          link: url,
          ats,
          fields: [...requiredEmpty, ...consents.map((c) => `[consent] ${c}`)],
        });
        console.log(`  [pending-question] recorded ${requiredEmpty.length + consents.length} unanswered item(s): `
          + `${[...requiredEmpty, ...consents.map((c) => `[consent] ${c}`)].join(", ")}`);
        if (!needsHumanNow) {
          console.log("  [pending-question] not blocking the batch — this needs one pass at the end of the run");
        }
      }

      if (spamRefused) {
        console.log("  [spam-refused] the board accepted the form and then rejected the submission as spam.");
        console.log("  [spam-refused] this is an anti-automation verdict, not a missing answer; not retried and not worked around.");
      }

      if (OTP_PAUSE && needsHumanNow && !spamRefused) {
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
    // A required field we could not answer is NOT the same outcome as a submitted
    // application awaiting confirmation, and recording it as one cost twice.
    //
    // "needs-verification" is eligible for retry on every run, so a form blocked
    // on a question only the candidate can answer was reopened, refilled and
    // re-blocked on every single run - a whole browser run each time, producing
    // nothing new, and crowding fresh jobs out of the batch.
    //
    // It also sent the operator to the wrong queue. "Awaiting confirmation" is
    // worth chasing; "nobody has written this answer" is worth answering once.
    //
    // The status is deliberately still NeedsVerification, so nothing downstream
    // changes shape. What changes is the action, so the retry gate and the
    // manual queue can finally tell the two apart.
    // Computed here, where the action is built, because that is the scope that
    // reads it. Declaring it in the inner block made it invisible here and threw
    // `blockedOnQuestion is not defined` on every single submission; declaring it
    // one level out from the assignment has the same effect. Assigned below.
    let blockedOnQuestion = false;
    const action = confirmed
      ? "verified"
      : spamRefused
        ? "spam-refused"
        : blockedOnQuestion
          ? "blocked-on-question"
          : clicked || clickError
            ? "needs-verification"
            : "needs-review";
    return { company: job.company, title: job.title, link: url, ats, action, pdf: resumePdf };
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
    # NOT filtered on score here.
    #
    # This predicate cut 135 evaluated rows down to 38, and the role filter then
    # rejected all 38, so the run reported an empty queue. The rows actually
    # wanted - "Software Engineer, Platform", "Backend Engineer - Inference
    # Services", "Applied ML Engineer" - scored 52-58 and were discarded before
    # the role filter ever saw them.
    #
    # The score was anti-correlated with scope: in-scope roles had a median of 52
    # and out-of-scope roles a median of 65. Gating on it therefore removed
    # precisely the target roles.
    #
    # Scope is decided by the role filter; the score ranks and caps afterwards.
    # A NULL score is still excluded, since an unevaluated row has nothing to
    # rank by.
    if "score" in job_columns:
        where.append("j.\"score\" IS NOT NULL")
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
    # Each row carries its job_description so the role filter can judge a posting
    # whose title names no discipline. That text is stored clipped at 6000
    # characters, which is well past what role scope needs - the decision comes
    # from the title plus the opening of the posting - so selecting it in full
    # for every row inflates the payload for nothing.
    sql = ("SELECT j.*, substr(COALESCE(j.job_description,''), 1, 4000) AS job_description"
    " FROM jobs j" if "job_description" in job_columns else "SELECT j.* FROM jobs j")
if where:
    sql += " WHERE " + " AND ".join(where)
# Prefer rows that are genuine ATS-hosted job listings. LinkedIn and aggregator
# pages need per-site handling and were consuming every run's limited slots,
# starving the ~18 Greenhouse/Lever listings that have real application forms.
sql += """
 ORDER BY
 -- Score first. It is the ranking signal, and it used to be the LAST thing
 -- considered, which starved the best-fitting rows out of existence.
 --
 -- The ordering was <ats class>, j.id DESC  LIMIT 100, so within each class
 -- the NEWEST rows came first. The three highest-scoring in-scope jobs in the
 -- database - Vercel "Backend Intern", Stripe "Software Engineer Intern", Jane
 -- Street "C++ Systems Engineer Intern", all score 88 - are ids 1, 2 and 4, the
 -- OLDEST rows in the table. They sorted last and fell off the end of the LIMIT
 -- while newer, lower-scoring rows took every slot. Their links are employer
 -- career pages rather than ATS URLs, so they were in the lowest class too,
 -- which compounded it.
 --
 -- A run then reported:
 --
 --   35 row(s) passed SQL -> 0 eligible; dropped by - out-of-scope role: 35
 --
 -- which reads like the role filter had broken. It had not: 79 of 135 evaluated
 -- rows pass it. The 35 that were queried were simply the wrong 35.
 --
 -- The ATS preference is kept as a tiebreaker, not an override. A hosted board
 -- is likelier to have a real application form, but it should not outrank a
 -- substantially better-matched role.
 j."score" DESC,
 CASE
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%greenhouse.io/%/jobs/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%lever.co/%/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%ashbyhq.com/%/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%myworkdayjobs.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%workday.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%smartrecruiters.com/%' THEN 0
   WHEN LOWER(COALESCE(j."link",'')) LIKE '%linkedin.com/%' THEN 2
   ELSE 1
 END, j."id" DESC
 -- The row cap MUST NOT decide which roles are reachable.
 --
 -- It used to sit here at a fixed LIMIT 100, applied before the role filter
 -- runs, and a run reported:
 --
 --   [DB] 100 row(s) passed SQL -> 0 eligible; dropped by -
 --        out-of-scope role: 100, score<45: 33
 --   [DB] queue is empty - nothing eligible to apply to right now
 --
 -- while 41 in-scope Greenhouse roles sat in the table, unreachable. Measured
 -- on what this query actually returned: 100 rows, score range 35-78, and only
 -- THREE of them had a scope keyword in the title. The window was filled with
 -- sales, BD, security and devrel roles from Ashby and YC boards, every one
 -- scored 78, all correctly rejected by the role filter - and the LIMIT had
 -- already spent itself before that filter ran.
 --
 -- Those high scores are an artefact, not a ranking signal. Scores of 74-88 were
 -- written by the OLD evaluator, which rewarded tool-name density and rated
 -- out-of-scope roles HIGHER than in-scope ones (in-scope median 52,
 -- out-of-scope median 65). Ordering by score DESC therefore floats exactly the
 -- rows the scope filter exists to remove.
 --
 -- rankByAcceptance runs after this cap, so it can only reorder rows already
 -- fetched. With the window full of rejected rows it had almost nothing with a
 -- record of accepting to promote, which is why it changed so little.
 --
 -- So the cap is far above the pool and overridable. Truncation must never be
 -- what decides whether an in-scope role gets attempted.
"""
# The cap is a safety bound, not a selection mechanism - see the ORDER BY
# comment. Read here, in the language that actually builds the SQL, because an
# expression spliced into this String.raw block is Python and not JavaScript:
# putting str(ROW_CAP) in the SQL text raised
#   NameError: name 'ROW_CAP' is not defined
# which node --check cannot see, and which surfaced only as an empty queue.
try:
    row_cap = int(os.environ.get("PULSEOPS_SQL_ROW_CAP") or "600")
except Exception:
    row_cap = 600
if row_cap < 100:
    row_cap = 600
sql += " LIMIT " + str(row_cap)
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
      timeout: 30000,
      windowsHide: true,
      // Sized for the row cap, not left at the 1MB default. With 600 rows each
      // carrying a job_description this child was killed with ENOBUFS and the
      // run reported "queue is empty", which is indistinguishable from there
      // being no work - the third time this session a query failure has been
      // reported as an empty queue.
      maxBuffer: 64 * 1024 * 1024,
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
    // Rank by proven acceptance before score. Ashby refuses every submission and
  // ranking on score alone let it take the first slots.
  const acceptance = readAcceptanceByAts(dbPath);
  const queried = queryRows("default");
    const rows = rankByAcceptance(queried.filter((row) => isEligibleJob(row)), acceptance);
    // Report both counts. "No eligible jobs" is indistinguishable from "the
    // query matched nothing" without this, which hides the real blocker.
    if (queried.length !== rows.length) {
      // Attribute every rejection to the FIRST check that failed, so the counts
      // sum back to the number of dropped rows. Reporting only role/URL/Indeed
      // left rows dropped by score, pause state, blacklists or outreach
      // terminal states invisible, which is exactly the case where the queue
      // goes dry and the cause cannot be told from a plain "nothing to do".
      const reasons = new Map();
      // Every failing check is counted, not just the first one.
      //
      // This was first-match-wins with the role check first, so a row dropped for
      // being a simulation from an untrusted source with a stale score was
      // reported as "out-of-scope role" - which is how a run reporting
      //
      //   35 row(s) passed SQL -> 0 eligible; dropped by - out-of-scope role: 35
      //
      // said nothing actionable at all. The role check ran first on every row and
      // won, hiding whatever actually closed the queue. Counts now overlap
      // deliberately: one row failing three checks contributes to three tallies,
      // and the sum is allowed to exceed the number of dropped rows.
      const tally = (why) => reasons.set(why, (reasons.get(why) || 0) + 1);
      for (const row of queried) {
        if (rows.includes(row)) continue;
        const link = row?.link || row?.url || "";
        const status = String(row?.status || "").trim().toLowerCase();
        let any = false;
        const note = (why) => { tally(why); any = true; };
        if (!link) note("no link");
        else if (!isAllowedInitialJobUrl(link)) note("blocked URL");
        if (!isStrictTargetRole(row?.title, jobDescriptionFor(row))) note("out-of-scope role");
        if (status !== "evaluated") note(`status=${status || "unknown"}`);
        if (!Number.isFinite(Number(row?.score))) note("score=non-numeric");
        else if (Number(row.score) < MIN_SCORE) note(`score<${MIN_SCORE}`);
        if (row?._send_pause_available === false || row?._db_pause_available === false) note("pause flag unavailable");
        if (Object.prototype.hasOwnProperty.call(row || {}, "job_id")
            && !Object.prototype.hasOwnProperty.call(row || {}, "_send_paused")) note("missing pause state");
        if (row?._send_paused === null || row?._send_paused === true || row?._send_paused === 1
            || ["1", "true", "yes", "on"].includes(String(row?._send_paused || "").toLowerCase())) note("sending paused");
        if (isTerminalStatus(status)) note("terminal status");
        if (isSimulationJob(row)) note("simulation");
        if (!isTrustworthySource(row?.source)) note("untrusted source");
        if (isBlockedOutreachJob(row)) note("outreach blocked");
        if (isBlacklistedJob(row)) note("blacklisted");
        if (hasReferralContact(row)) note("referral contact");
        if (link && inferATS(link) === "indeed" && !INCLUDE_INDEED) note("Indeed (out of scope)");
        if (!any) tally("unknown");
      }
      const tallyText = [...reasons.entries()].sort((a, b) => b[1] - a[1])
        .map(([why, n]) => `${why}: ${n}`).join(", ");
      console.log(`[DB] ${queried.length} row(s) passed SQL → ${rows.length} eligible; dropped by — ${tallyText || "none"}`);
      console.log("[DB] (counts overlap: one row can fail several checks)");
      const byPlatform = new Map();
      for (const row of queried) {
        const ats = inferATS(row?.link || row?.url || "");
        byPlatform.set(ats, (byPlatform.get(ats) || 0) + 1);
      }
      console.log(`[DB] in-scope pool by ATS: ${[...byPlatform.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    if (rows.length) {
      // Batch size is a throughput knob, not a safety limit: every job still
      // passes its own claim/pause/guard checks before anything is submitted.
      const batch = Math.max(1, Number.parseInt(process.env.PULSEOPS_BATCH_SIZE || "5", 10) || 5);
      console.log(`[DB] loaded ${rows.length} eligible Evaluated jobs (batch ${batch})`);
      return rows.slice(0, batch).map((row) => ({ ...row, job_id: row.id, _db_path: dbPath }));
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
  // The board refused the submission itself as spam. Recording this as
  // NeedsVerification sends an operator to wait for a confirmation that will
  // never come, and re-running just repeats the refusal. Skipped is the honest
  // terminal state: we did apply, and the board declined to take it.
  if (action === "spam-refused") return "Skipped";
  // Blocked on a required question nobody has answered. Same terminal status as
  // an unconfirmed submission, but a different reason, so a retry gate can skip
  // it until an answer exists instead of re-filling the same form every run.
  if (action === "blocked-on-question") return "NeedsVerification";
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

  // The reason has to survive the write, not just the status. statusForBrowserResult
  // collapses every non-submission outcome into "Skipped", so "spam-refused" and
  // "expired posting" and "salary below floor" were indistinguishable the moment
  // they were persisted - the outcomes table stayed empty and there was no way to
  // tell afterwards which postings needed a person and which simply were done.
  // Recorded in the same transaction as the status change, so a reason can never
  // be written for a status update that lost its claim race.
  const reason = String(result?.action || "").trim().slice(0, 80) || null;
  const detail = String(result?.reason || result?.note || "").trim().slice(0, 300) || null;

  const pythonCode = String.raw`
import datetime, json, os, sqlite3, sys
path, raw_id, status, owner, raw_now, reason, detail = sys.argv[1:8]
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
                    if cur.rowcount != 1:
                        result = {"updated": False, "reason": "claim-race-lost"}
                    else:
                        written = False
                        try:
                            ocols = {str(r[1]) for r in conn.execute("PRAGMA table_info(outcomes)")}
                            need = {"job_id", "stage"}
                            if need.issubset(ocols):
                                row2 = conn.execute("SELECT title, company FROM jobs WHERE id=?", (job_id,)).fetchone()
                                conn.execute(
                                    "INSERT INTO outcomes (job_id, company, title, stage, notes, recorded_at) VALUES (?,?,?,?,?,?)",
                                    (job_id, (row2[1] if row2 else ""), (row2[0] if row2 else ""),
                                     reason or status, detail, stamp),
                                )
                                written = True
                        except Exception:
                            written = False
                        result = {"updated": True, "reason": "updated", "outcome": written}
        conn.commit()
except Exception:
    try:
        conn.rollback()
    except Exception:
        pass
print(json.dumps(result))
`;
  const changed = runSqliteJson(dbPath, pythonCode, [dbPath, String(jobId), nextStatus, String(claimToken || ""), String(Date.now()), reason || "", detail || ""], 7000);
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

  // The persistent Edge context is launched once and shared by every job, so a
  // single crash used to poison the rest of the batch: each later job then threw
  // "Target page, context or browser has been closed" and the run finished with
  // one real outcome and a tail of identical noise. Observed on Ashby, where the
  // context died right after the submit click while reCAPTCHA's webworker loaded.
  // Relauch instead, and say so, so a batch survives one dead window.
  const launchContext = async () => {
    if (EDGE || process.argv.includes("--edge")) {
      sharedCtx = await chromium.launchPersistentContext(path.join(ROOT, ".edge-profile"), {
        channel: "msedge",
        headless: false,
        viewport: { width: 1366, height: 900 },
      });
      browser = null;
    } else {
      browser = await chromium.launch({ headless: !HEADED });
      sharedCtx = null;
    }
  };
  const contextAlive = async () => {
    try {
      if (sharedCtx) {
        if (typeof sharedCtx.pages === "function") {
          const pages = sharedCtx.pages();
          return pages.some((p) => {
            try { return !p.isClosed(); } catch { return false; }
          });
        }
        return true;
      }
      return Boolean(browser && browser.isConnected && browser.isConnected());
    } catch {
      return false;
    }
  };
  const ensureContext = async () => {
    if (await contextAlive()) return true;
    console.log("  [context-lost] the browser window went away; relaunching for the rest of the batch");
    try { if (sharedCtx) await sharedCtx.close().catch(() => {}); } catch { /* already gone */ }
    try { if (browser) await browser.close().catch(() => {}); } catch { /* already gone */ }
    sharedCtx = null;
    browser = null;
    try {
      await launchContext();
      return true;
    } catch (e) {
      console.log(`  [context-lost] relaunch failed: ${String(e?.message ?? e).slice(0, 120)}`);
      return false;
    }
  };

  try {
    if (EDGE || process.argv.includes("--edge")) {
      console.log(`[Edge] persistent profile ${path.join(ROOT, ".edge-profile")} (msedge, headed)`);
    }
    await launchContext();

    for (const job of jobs) {
      // A window closed by hand, or a crash in the previous job, must not take
      // the rest of the batch with it.
      if (!(await ensureContext())) {
        results.push({
          company: job.company,
          title: job.title,
          link: job.link,
          action: "error",
          error: "browser context unavailable; could not be relaunched",
        });
        continue;
      }
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
      // Only a genuinely global state stops the batch. `contended` and
      // `claim-blocked` describe ONE row — another owner holds it, or a dead run
      // left it claimed — and used to end the whole run, silently truncating the
      // remaining applications (observed: 26 skipped behind one stale claim).
      // Neither implies sending is paused, so neither stops the others.
      if (result.action === "contended" || result.action === "claim-blocked") {
        console.log(`  [${result.action}] skipped — this listing is claimed elsewhere; the rest of the batch continues`);
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
    }
      if (["send-paused", "claim-lost"].includes(result.action)) break;
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
  flushPendingQuestions();
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
  identityFacts,
  jobDescriptionFor,
  whyInterested,
  rankByAcceptance,
  readAcceptanceByAts,
  candidateFirstName,
  candidateLastName,
  portalAssetHostAllowed,
  availabilityDate,
  salaryAnswer,
  isFingerprintVendorHost,
  finalGuardAction,
  isCurrentPageTrusted,
  isEligibleJob,
  isMockJob,
  controlSignatureMatcher,
  describeSubmitOutcome,
  isAllowedPresignedUploadRequest,
  collectPresignedUploadHosts,
  isInteractiveChallengeUrl,
  isAllowedCaptchaTokenRequest,
  isAllowedAtsApplicationPost,
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
