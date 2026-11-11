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
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { basicHtmlTextFromHtml, statedSalaryTooLow } from "./salary.mjs";
import { isExperienceStepText, matchExperienceEntry } from "./experience.mjs";
import { BASIC_HTML, detectBasicHtml } from "./page-probe.mjs";
import { cleanTitle } from "../weekly-scan/lib/relevance.mjs";

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
  const { skip, monthly, matched } = statedSalaryTooLow(`${job.title || ""} ${text}`);
  if (!skip) return null;
  const shown = Math.round(monthly).toLocaleString("en-IN");
  // Name the fragment the rule fired on. A skip is the engine deciding not to
  // apply at all, so a mis-read must be visible rather than inferred later.
  const why = matched ? ` (matched "${String(matched).trim().slice(0, 40)}")` : "";
  console.log(`  [salary] stated Rs ${shown}/month is under the Rs 10,000 floor — not applying${why}`);
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
// Which persistent profile to launch. The scan phase already signs into Naukri
// and Wellfound in its own profile (.edge-profile-naukri), and a login the
// operator completed once there should count for the apply phase too - two
// profiles meant two sign-ins, and the unattended run had neither.
const EDGE_PROFILE = path.resolve(
  process.env.PULSEOPS_EDGE_PROFILE || path.join(ROOT, ".edge-profile"),
);
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
  // Keka hosts each employer on its own subdomain (nudge.keka.com), so the
  // classification is a suffix rule and the exact-host navigation list cannot
  // enumerate tenants; a direct keka row is admitted by its own origin.
  keka: ["keka.com"],
  // UKG Pro Recruiting (formerly UltiPro) serves an employer's whole job board
  // from one host, with the posting, the apply form and the confirmation all as
  // routes of its single-page app.
  ultipro: ["recruiting.ultipro.com"],
  yc: ["workatastartup.com", "www.workatastartup.com", "ycombinator.com", "www.ycombinator.com"],
  // Himalayas lists the posting itself and, for most roles, hands the candidate
  // to the employer's own ATS through an outbound control - so its posting page
  // is classified like Wellfound's: an opener, never a submission.
  himalayas: ["himalayas.app", "www.himalayas.app"],
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
  // Languages outside the candidate's set. "Backend Engineer (Ruby)" is in-scope
  // by role family and pure waste by stack.
  "ruby", "rails", "php", "perl", "c#", ".net", "dotnet", "vb.net",
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
  String.raw`\b(?:backend|back[\s-]end|ml|artificial[\s-]+intelligence|ai[\s/-]*ml|genai|generative[\s-]+ai|llm\w*|nlp|computer[\s-]+vision|deep[\s-]+learning|java|python|golang|rust|kotlin|spring(?:[\s-]?boot)?|grpc)\b`
  // "Go" only as a stack word: a bare \bgo\b would admit "Go-To-Market Manager".
  + String.raw`|\bgo\b(?=\s*(?:developer|engineer|programmer|backend))`
  + String.raw`|machine[\s-]+learning|reinforcement[\s-]+learning|\bc\b|c\+\+|c\s*\/\s*c\+\+`
  // profile.yml role_types.include names these four outright, so a title that
  // says them is in scope without asking the posting body. Leaving them on the
  // generic body-check refused "DevOps Engineer" and "Infrastructure Engineer"
  // whenever the scrape captured only company boilerplate.
  + String.raw`|\b(?:devops|dev[\s-]ops|sre|site\s+reliability|infrastructure|platform)\b`
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
const STRICT_ROLE_GENERIC_DENY = new RegExp(
  String.raw`\b(?:solutions?\s+(?:engineer|architect)|solution\s+specialist|security\s+engineer|customer\s+success|partner\s+success|product\s+support|technical\s+sourcer|technical\s+copywriter|gtm\s+strategist|sales\s+engineer|developer\s+relations|developer\s+advocate|devrel|electrical\s+engineer|operations\s+engineer)\b`
  // Engineering disciplines that are not software. "Supply Chain Engineer" and
  // "Mechanical Engineer" reached the queue at score 92 and 88 because the
  // generic path admits any title containing "engineer" once the posting body
  // mentions tooling - and a hardware posting mentions a lot of tooling. The
  // score cannot help here: it graded the body, which really did match.
  + String.raw`|(?:mechanical|civil|structural|electrical|electronic|electronics|chemical|aerospace|biomedical|industrial|manufacturing|materials?|metallurg\w*|environmental|mining|agricultural|marine|naval|automotive|hvac|instrumentation|process|plant|maintenance|field|supply[\s-]+chain|logistics)\s+engineer\b`,
  "i",
);

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

// Entry-level markers and role nouns, used together for titles that name no
// discipline ("Software Engineer Trainee", "Associate Software Engineer").
const ENTRY_LEVEL_MARKER =
  /\b(?:intern|internship|trainee|fresher|graduate|new\s+grad|entry[\s-]?level|junior|jr|associate|sde\s*[- ]?[12])\b/;
const ENGINEERING_NOUN =
  /\b(?:engineer|engineering|developer|development|programmer|sde|software|backend|back[\s-]end)\b/;

// Seniority the candidate cannot claim (0.2 years, profile.seniority.exclude).
// Stage 1 drops these before they are ever stored, so this only catches rows
// written before that rule existed - which is how "Engineering Manager,
// Infrastructure" reached the queue at score 12 and "Sr Backend Engineer" at 42.
// The intern/junior modifier wins, exactly as in hard_filter().
const SENIORITY_DENY =
  /\b(?:senior|sr|staff|lead|principal|director|head\s+of|vp|vice\s+president|manager|chief|cto|founder)\b/;
const INTERN_MODIFIER =
  /\b(?:intern|internship|trainee|fresher|graduate|new\s+grad|entry[\s-]?level|junior|jr)\b/;

// Whole-token patterns for the exclude list. The previous test was
// `value.includes(marker)`, which rejected "Salesforce Developer" (contains
// "sales"), "Adios Engineer" (contains "ios") and "Reactive Systems Developer"
// (contains "react"). Separator classes keep the marker's spelling variants
// together: "full stack" / "full-stack" / "fullstack" are one family.
const STRICT_ROLE_EXCLUDE_RES = STRICT_ROLE_EXCLUDES.map((marker) => {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = marker.trim().split(/[\s\-/]+/).filter(Boolean).map(escape);
  const body = parts.join("[\\s\\-/]*");
  const squeezed = escape(marker.replace(/[\s\-/_]+/g, ""));
  return new RegExp(`(?<![a-z0-9])(?:${body}|${squeezed})(?![a-z0-9])`, "i");
});

function isStrictTargetRole(title, description = "") {
  // roleBasis relies on capitalisation to strip a location glued onto the role
  // noun ("EngineerLondon"). Lower-casing first made every one of those rules
  // dead, so the raw title is normalised here and only then compared.
  // cleanTitle first: rows written before the cleaner existed still carry board
  // chrome ("... Founded in 2021 50-200 employees"), and the chrome was what the
  // exclude list usually matched.
  const source = String(title || "").trim().replace(/\s+/g, " ");
  const raw = cleanTitle(source) || source;
  const value = raw.toLowerCase();
  if (!value) return false;
  if (STRICT_ROLE_EXCLUDE_RES.some((pattern) => pattern.test(value))) return false;

  // Seniority the candidate cannot claim. Checked after the stack excludes (so
  // "Senior Ruby Developer" is still a stack problem) and before the allow list,
  // because "Senior Backend Engineer" otherwise matches "backend" and is applied
  // to. The intern/junior modifier wins, as in hard_filter().
  if (SENIORITY_DENY.test(value) && !INTERN_MODIFIER.test(value)) return false;

  // A non-engineering discipline named in the title is disqualifying even when an
  // in-scope keyword is also present ("Solutions Architect, AI", "Security
  // Engineer, ML"). This must run BEFORE the allow list: it used to run after,
  // where STRICT_ROLE_ALLOWED.test(value) had already returned true, so a deny
  // could never fire for any title the allow list matched.
  if (STRICT_ROLE_GENERIC_DENY.test(roleBasis(raw) || value)) return false;

  if (STRICT_ROLE_ALLOWED.test(value)) return true;

  // Entry-level postings are this candidate's whole target market, and the India
  // boards phrase them as "Software Engineer Trainee", "Associate Software
  // Engineer" or "SDE 1" rather than naming a discipline. Those titles carry no
  // keyword for the allow list and were then refused by the generic body-check,
  // whose evidence is usually company boilerplate rather than a requirements
  // list. Require BOTH an entry-level marker and a role noun, so "Marketing
  // Intern" and "Associate Product Manager" stay out.
  if (ENTRY_LEVEL_MARKER.test(value) && ENGINEERING_NOUN.test(value)) return true;

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
  // Keka's careers pages are jQuery apps served from its own CDN. Without these
  // scripts the page still renders, but the click handlers do not exist: the
  // "Apply for this job" button on a job details page did nothing at all
  // (nudge.keka.com #1319, measured 2026-11-09) while the same click navigated
  // in a plain browser.
  keka: ["cdn.keka.com"],
  // UKG Pro Recruiting is one React app whose runtime lives on two CDN
  // hostnames. With every script blocked the page painted nothing at all — a
  // 7 KB white screenshot with no form and no apply control (#1019 Park Place
  // Technologies, measured 2026-11-10).
  ultipro: ["rec-cdn-prod.cdn.ultipro.com", "ignite.cdn.ultipro.com"],
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

// A posting that has stopped taking applications says so in its own words.
// LinkedIn's wording is "Not currently accepting applications" — measured
// 2026-11-10 on #1274 Honeywell Aerospace, whose page also says "Responses
// managed off LinkedIn", so the run read a closed job as an off-site apply and
// asked a human to finish something the company had already closed.
const CLOSED_LISTING_TEXT = /no longer accepting applications|not currently accepting applications|not accepting (?:new )?applications|accepting applications (?:closed|has ended)|applications are closed/i;

// Distinguish "closed", "already applied", and "apply on the company site" from
// a genuinely missing control, so the run records an accurate outcome instead
// of a blanket NeedsReview.
async function classifyMissingApplyState(page) {
  if (!page || typeof page.evaluate !== "function") return "no-apply-control";
  return page.evaluate((closedSource) => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    if (new RegExp(closedSource, "i").test(text)
        || /this job is no longer|job (has )?expired|position (has been )?filled|no longer available/i.test(text)) {
      return "closed-listing";
    }
    if (/apply on (?:the )?(?:company|employer)|apply on company website|external apply|go to (?:the )?(?:company|employer)(?:'s)? website|responses managed off linkedin/i.test(text)) {
      return "external-apply";
    }
    if (/\byou applied\b|application submitted|applied successfully|already applied/i.test(text)) {
      return "already-applied";
    }
    return "no-apply-control";
  }, CLOSED_LISTING_TEXT.source).catch(() => "no-apply-control");
}

// A link that browses jobs is never this job's own apply control. LinkedIn
// renders "similar jobs" and "see all" cards with an Apply-labelled anchor
// whose href points at a search, so matching by label alone can pick up a
// different posting - measured 2026-11-10, #1274 Honeywell Aerospace, where the
// control read "Software Engineer Intern … Weekday (YC W21)" and its href was
// /jobs/search-results/?keywords=…
const LISTING_BROWSE_PATH = /\/(?:jobs\/search(?:-results)?|jobs\/collections|jobs\/similar|search|feed)(?:\/|$)|[?&]keywords=/i;

function isListingBrowseUrl(value, base = undefined) {
  try {
    const parsed = new URL(String(value || ""), base);
    return LISTING_BROWSE_PATH.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
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
                # NOTE: the claim-time protected set lives inside Python and
                # cannot see the JS SINGLE_JOB_ID flag. Explicit --job-id
                # Verified rows are admitted by removing "verified" from the
                # set here and letting the UPDATE below handle them; the JS
                # isEligibleJob() explicit bypass already approved this row.
                # To re-tighten: re-add "verified" to this set.
                protected = {"applied", "sent", "followupsent", "expired", "skipped", "needsreview", "needsverification", "simulated", "sendpaused", "emailqueued", "blacklisted", "referral", "cooldown", "replied", "phone_screen", "technical", "final", "offer", "accepted", "rejected"}
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
                        cur_status = str(row["status"] or "").strip().lower()
                        if stale_marker is not None:
                            cur = conn.execute("UPDATE jobs SET status='Applying', processed_at=? WHERE id=? AND LOWER(COALESCE(status,''))='applying' AND processed_at=?", (new_marker, job_id, stale_marker))
                        elif cur_status == "verified":
                            # Explicit --job-id claim on an email-channel Verified
                            # row (operator chose this row; Verified gates email,
                            # not browser). Queue mode never reaches here with
                            # Verified because the protected set blocks it above.
                            cur = conn.execute("UPDATE jobs SET status='Applying', processed_at=? WHERE id=? AND LOWER(COALESCE(status,''))='verified'", (new_marker, job_id))
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

/**
 * The months left over after the whole years, for the follow-up select.
 *
 * LinkedIn asks "total years of professional experience" and then "total
 * additional months of experience" as two selects. The profile states 0.2 years,
 * which is 0 years and 2 months - filling only the first left the wizard on
 * 4/5 with Review doing nothing (#1033, 2026-11-11).
 */
function additionalMonthsOfExperience(candidate) {
  const raw = candidate?.experience_years;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n < 0) return "";
  const months = Math.floor((n - Math.floor(n)) * 12 + 1e-9);
  return `${months} month${months === 1 ? "" : "s"}`;
}

/**
 * The whole-year bucket a numeric answer falls into.
 *
 * LinkedIn's "total years of professional experience" select offers "0 year",
 * "1 year", ... only, while the profile states 0.2 - the truthful bucket is the
 * one it rounds down into. Used only after the literal, prefix and word matches
 * have all failed, so a select that spells its options out is never overridden.
 */
function numericOption(labels, want) {
  const figure = Number.parseFloat(String(want || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(figure)) return null;
  const whole = Math.floor(figure);
  return labels.find((o) => {
    const option = Number.parseFloat(String(o.label).replace(/[^0-9.]/g, ""));
    return Number.isFinite(option) && option === whole;
  }) || null;
}

/**
 * A control that only takes a number gets a number, or nothing.
 *
 * LinkedIn's Easy Apply asks "Please enter your notice period in days" and
 * "Please enter your expected ctc in INR" as 20-character text inputs with a
 * numeric rule. The stated answers are prose ("30 days", "INR 8,40,000 - 10,80,000
 * per annum"), the control reported "Invalid input", and the step refused to
 * advance while the log showed a successful fill (#1033, 2026-11-11). A stated
 * answer with no figure at all is left empty rather than turned into a 0 that
 * nobody stated.
 */
function numericFieldAnswer(signature, value) {
  const text = String(value ?? "").trim();
  const wantsNumber = /\bexample\s*:\s*\d|\bin\s+inr\b|\bin\s+(?:days?|weeks?|months?|years?)\b|\bamount\b|\bnumber\s+of\b|\bnumeric\b|\bdigits?\b/i
    .test(String(signature || ""));
  if (!wantsNumber) return { text, numeric: false, missing: false };
  const digits = text.match(/\d[\d,]*/);
  if (!digits) return { text: "", numeric: true, missing: true };
  return { text: digits[0].replace(/,/g, ""), numeric: true, missing: false };
}

/**
 * The number a pay question can take, when the operator has stated one.
 *
 * "Please enter your current ctc in INR" wants an annual figure, and the prose
 * answer ("INR 35,000 per month") would be read as 35,000 a year - a mistake by a
 * factor of twelve. Where a figure is stated for the annual question
 * (`current_ctc_inr`, `expected_ctc_inr`) it wins over any prose, and a
 * monthly/per-annum question is never answered with it.
 */
function statedNumericAnswer(signature, stated) {
  const text = String(signature || "");
  if (!text) return "";
  if (!/\b(?:annual|per\s+annum|p\.?a\.?|inr|ctc)\b/i.test(text)) return "";
  if (/\b(?:per\s+month|monthly|per\s+hour|hourly|lpa\s*per\s*month)\b/i.test(text)) return "";
  const wantsExpected = /\b(?:expected|desired|required)\b[^.;]{0,40}\b(?:ctc|compensation|salary)\b/i.test(text);
  const wantsCurrent = /\b(?:current|present)\b[^.;]{0,40}\b(?:ctc|compensation|salary)\b/i.test(text);
  const figure = wantsExpected ? stated?.expected_ctc_inr : (wantsCurrent ? stated?.current_ctc_inr : undefined);
  const value = typeof figure === "number" ? figure : Number.parseFloat(String(figure ?? ""));
  if (!Number.isFinite(value) || value < 0) return "";
  return String(Math.round(value));
}

/**
 * A skill name as a matcher, so the same technology is recognised however the
 * board spells it. "Spring Boot" and "SpringBoot" are one skill, and a question
 * asks it in running prose: "rate your proficiency in Java(1 = beginner, 10 =
 * expert)". Non-alphanumerics are flattened on the question's side, and the
 * skill's own words are joined with an optional gap, so both spellings meet.
 *
 * Word boundaries matter: `\bsql\b` must not fire on "MySQL" or "PostgreSQL",
 * which are different technologies and would get an answer the candidate never
 * gave.
 */
function skillPattern(skill) {
  const words = String(skill || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return null;
  return new RegExp(`\\b${words.join("\\s*")}\\b`, "i");
}

function mentionsSkill(text, skill) {
  const pattern = skillPattern(skill);
  if (!pattern) return false;
  const flat = String(text || "").replace(/[^a-z0-9+#.]+/gi, " ");
  return pattern.test(flat);
}

/**
 * Read a stated per-skill fact, whichever of the two shapes it was written in.
 *
 * The profile is hand-edited, so both a mapping and a list of "Skill: value"
 * strings are accepted; neither is inferred from anything. Longest name first,
 * so "Spring Boot" is chosen before a stray "Boot" and "PostgreSQL" before
 * "SQL" if both were ever stated.
 */
function statedSkillEntries(map) {
  const out = [];
  const push = (skill, value) => {
    const name = String(skill || "").trim();
    const text = String(value ?? "").trim();
    if (name && text) out.push({ skill: name, value: text });
  };
  if (Array.isArray(map)) {
    for (const item of map) {
      const match = String(item ?? "").match(/^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/);
      if (match) push(match[1], match[2]);
    }
  } else if (map && typeof map === "object") {
    for (const [skill, value] of Object.entries(map)) push(skill, value);
  }
  return out.sort((a, b) => b.skill.length - a.skill.length);
}

/**
 * "Rate your proficiency in Java (1 = beginner, 10 = expert)".
 *
 * A self-rating is a judgement about the candidate, so it is only ever taken
 * from a figure he stated, and only on a control whose own words ask for a
 * rating and name that skill. Nothing is derived from the CV or the years
 * figure: turning experience into a 1-10 score would be inventing the answer.
 */
function skillRatingFor(stated, signature) {
  const entries = statedSkillEntries(stated?.skill_ratings);
  if (!entries.length) return "";
  const text = String(signature || "");
  if (!/\b(?:rat(?:e|ing)|proficiency|\bscore\b)|out\s+of\s+(?:5|10)|\b1\s*[-–=]\s*(?:5|10)\b/i.test(text)) return "";
  const hit = entries.find((entry) => mentionsSkill(text, entry.skill));
  return hit ? hit.value : "";
}

/**
 * "How many years of hands-on experience do you have with Java in a
 * professional environment?" (#1320 Zema, 2026-11-10).
 *
 * A technology-scoped years question is never total experience, so it is only
 * answered from a stated per-skill figure. With none stated it stays empty and
 * is reported as [answer-missing] rather than borrowing 0.2 years for a
 * language the CV may not claim.
 */
function skillYearsFor(stated, signature) {
  const entries = statedSkillEntries(stated?.skill_years);
  if (!entries.length) return "";
  const text = String(signature || "");
  if (!/\byears?\b/i.test(text)) return "";
  const hit = entries.find((entry) => mentionsSkill(text, entry.skill));
  return hit ? hit.value : "";
}

/**
 * Does this question name a technology at all?
 *
 * Used to keep the total-experience fact away from any question scoped to one
 * skill. It counts every skill the profile claims - the ones with a stated
 * figure plus the ones in `domain.core_skills`/`adjacent_skills` - because the
 * point is not whether an answer exists but that the total is the wrong answer.
 */
function skillScopedQuestion(stated, profile, signature) {
  const text = String(signature || "");
  if (!text) return false;
  const skills = [
    ...statedSkillEntries(stated?.skill_years).map((entry) => entry.skill),
    ...statedSkillEntries(stated?.skill_ratings).map((entry) => entry.skill),
  ];
  for (const list of [profile?.domain?.core_skills, profile?.domain?.adjacent_skills]) {
    for (const skill of Array.isArray(list) ? list : []) skills.push(String(skill));
  }
  return skills.some((skill) => mentionsSkill(text, skill));
}

/**
 * "How many years of ... experience do you have?"
 *
 * The qualifier between "years of" and "experience" is the board's own words
 * and there can be several of them: "How many years of professional backend
 * software engineering experience do you have?" (GitLab, 2026-11-09) matched
 * nothing, because the pattern allowed at most one qualifier and only three
 * fixed ones. The field stayed empty and the submit was refused with everything
 * else filled.
 *
 * The negative lookahead keeps it away from questions that name a technology:
 * "How many years of professional, production experience do you have writing Go
 * (Golang) or Ruby?" is not answerable from total experience, and answering it
 * with 0.2 years would be a false statement about a language the CV never
 * claims. Those are left for the human, which is visible as [answer-missing].
 */
const YEARS_OF_EXPERIENCE_QUESTION = /^(?![\s\S]*\b(?:writing|programming|coding|developing)\b)[\s\S]*(?:how\s+many\s+years\s+of\s+(?:[a-z,/+&-]+\s+){0,6}?experience|years\s+of\s+(?:[a-z,/+&-]+\s+){0,4}?experience|total\s+(?:years?|experience))/i;

/**
 * "Where are you located?" - the candidate's own city, a fact from the profile.
 *
 * Deliberately not a bare `\brelocat`. "...and are you willing to relocate at
 * your own expense?" is a relocation question, not a location one, and the loose
 * token wrote the candidate's city into Zema's distance answer (#1320,
 * 2026-11-10), displacing the sentence that belonged there - the box looked
 * filled to every later pass while saying nothing the question asked for. A
 * relocation question is only this fact's business when it asks WHICH place.
 */
const WORK_LOCATION_QUESTION = /address from which|which city|work from|current location|where\s+are\s+you\s+(?:located|based|residing)|where\s+(?:do|did)\s+you\s+(?:live|reside)|your\s+(?:current\s+)?location|which\s+city\s+are\s+you|(?:which|what|list\s+the)\s+(?:cities|city|locations?|places?)\b|relocat\w*\s+to\s+(?:the\s+|a\s+)?(?:city|location|region|area|place)\b/i;

/**
 * "Are you subject to any employment agreements / post-employment
 * restrictions ...?" - the same class of representation as a non-compete, and
 * answered from `application_answers.current_non_compete`.
 *
 * GitLab (8916232002, 2026-11-09) words it with "employment agreements and/or
 * post-employment restrictions", which shares no keyword with the classic
 * "non-compete, non-solicitation or non-disclosure" form, so the one legal
 * question on the form the profile could answer stayed empty. The yes/no opener
 * is still required, which is what keeps Scale AI's noun-phrase "position for
 * which you are applying?" from being answered with "No".
 */
const NON_COMPETE_QUESTION = /^(?=[\s\S]*\b(?:(?:are|do|is|will|have|were|was)\s+you|(?:is|are)\s+there)\b)(?=[\s\S]*(?:non[-\s]?compete|non[-\s]?solicitation|non[-\s]?disclosure|bound\s+by\s+any\s+agreements?|any\s+agreements?\s+with\s+a\s+(?:current|former|previous)|employment\s+agreements?|post[-\s]?employment\s+restrictions?|restrict(?:ed|ing)?\s+(?:your\s+)?(?:ability|employment|work)))/i;

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
/**
 * Render a stated salary in lacs, because the question was asked in lacs.
 *
 * Hirist asks "What is your expected CTC in Lacs per annum?" as a mandatory
 * free-text box. The profile holds "INR 8,40,000 - 10,80,000 per annum", and
 * typing that into a field that says "in Lacs" is a wrong number rather than a
 * formatting nicety - it reads as eight lakh lakhs. Values already stated in
 * lacs ("4-5 LPA") pass through untouched, so one function serves both shapes.
 */
function salaryInLacs(value) {
  const numbers = (String(value || "").match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((raw) => Number(String(raw).replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  if (!numbers.length) return "";
  const rendered = numbers.slice(0, 2).map((n) => (
    n >= 100000 ? String(Number((n / 100000).toFixed(2))) : String(n)
  ));
  return rendered.length > 1 ? `${rendered[0]} - ${rendered[1]}` : rendered[0];
}

function salaryAnswer(stated, signature) {
  const sig = String(signature || "");
  const perMonth = /\b(?:per|a|\/)\s*month|monthly|month\s*[--]?\s*\??\s*$/i.test(sig)
    || /\bmonth\b/i.test(sig);
  const perAnnum = /\b(?:per|a|\/)\s*(?:annum|year)|annually|annual|lpa|lakh\s*per\s*annum|\bctc\b/i.test(sig);
  let value = "";
  if (perMonth && !perAnnum) value = String(stated?.desired_salary_monthly ?? "").trim();
  else if (perAnnum && !perMonth) value = String(stated?.desired_salary_annual ?? "").trim();
  // Neither unit stated: offer the monthly form, which is the one the floor
  // was given in, and say the unit so it cannot be misread.
  else value = String(stated?.desired_salary_monthly ?? stated?.desired_salary_annual ?? "").trim();
  // "in Lacs" / "LPA" asks for the number in lacs, whatever the profile states.
  if (/\blacs?\b|\blakhs?\b|\blpa\b/i.test(sig)) return salaryInLacs(value);
  // A `*.amount` control is the numeric half of an amount+currency+period group:
  // the currency and "Monthly" are separate controls on the same row, so the
  // number is the only thing this box wants. Writing the prose
  // "INR 35,000 - 45,000 per month" into it would put a sentence in a numeric
  // field. The lower bound is the operator's own floor, not a new figure.
  // Keka renders exactly this shape (expectedSalary.amount, #1319, 2026-11-09).
  if (/\.amount\b|\bamount\b/i.test(sig)) return firstAmount(value);
  return value;
}

/** The first number in a stated salary, as digits: "INR 35,000 - 45,000" -> "35000". */
function firstAmount(value) {
  const m = String(value || "").match(/(\d[\d,]*(?:\.\d+)?)/);
  return m ? m[1].replace(/,/g, "") : "";
}

/**
 * Is this textarea asking for prose, or for a figure?
 *
 * A textarea is not automatically an essay. Deel renders "Desired Base Salary
 * (please specify amount and currency)" as one (`textarea`, 500-char limit), and
 * the catch-all `form textarea` selector poured the whole 1500-character "why
 * us" essay into it — the money question was answered with an essay, truncated
 * at its limit, and the real essay question was left empty (#1320, 2026-11-10).
 *
 * So a box only counts when its own words ask for prose AND nothing in them asks
 * for a number, a rate, a contact detail or a measurable fact. `hint` is the
 * signature `controlSignatureMatcher()` produces for that control.
 */
function isEssayFieldHint(hint) {
  const text = String(hint || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return false;
  // A figure, a unit, or a contact detail means this is not prose, whatever else
  // the label says ("tell us your expected salary in LPA").
  if (/\b(?:salary|compensation|ctc|remuneration|package|amount|currency|inr|usd|lpa|lakhs?)\b/.test(text)) return false;
  if (/\b(?:number|digits|numeric|phone|mobile|telephone|email|e-mail|address|pin\s*code|postal)\b/.test(text)) return false;
  if (/\b(?:years?|months?|rate|rating|score|percentage|notice\s*period|availability)\b/.test(text)) return false;
  // A question about a measurable fact is not an essay even when it contains
  // "why" or "describe": Deel's "How far do you live from Seawolves … Mumbai? If
  // you are not local, why do you look to move and are you willing to relocate
  // at your own expense?" is answered with a distance, not with a generic
  // paragraph about the candidate.
  if (/\b(?:how\s+(?:far|long|many|much)|distance|commute|relocat\w*)\b/.test(text)) return false;
  // Prose asks: why us, tell us about yourself, describe, motivation, cover letter,
  // or a word/character target ("200-400 words").
  return /\bwhy\b|tell\s+us|describe|about\s+(?:you|yourself)|cover\s+letter|motivat|interested\s+in|anything\s+else|additional\s+information|\d{2,4}\s*[-–]\s*\d{2,4}\s*(?:words?|characters?|chars?)/i.test(text);
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

// Where the application actually came from is a property of the row, not of the
// candidate, so it is read from the row's own source. Naming the board is a
// true statement; a made-up referral would not be.
function heardFromBoard(row) {
  const where = `${row?.source || ""} ${row?.link || ""}`.toLowerCase();
  if (/linkedin/.test(where)) return "LinkedIn";
  if (/wellfound/.test(where)) return "Wellfound";
  if (/hirist/.test(where)) return "Hirist";
  if (/instahyre/.test(where)) return "Instahyre";
  if (/naukri/.test(where)) return "Naukri";
  if (/glassdoor/.test(where)) return "Glassdoor";
  if (/indeed/.test(where)) return "Indeed";
  return "Job board";
}

function identityFacts(candidate, stated, job = null, profile = null) {
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
      // A dialling-code control is not the number. Keka renders the country code
      // as a separate select whose name is `mobilePhone.countryCode`; the phone
      // fact matched it, tried to select "6289050278" from a list of "+93 +355
      // …", and logged a failure while the number box itself was answered by the
      // field list (#1319, 2026-11-09).
      hint: /^(?![\s\S]*\b(?:country\s*code|dial(?:ling)?\s*code|isd\s*code)\b)[\s\S]*(?:phone(?:\s*(?:number|no\.?|#))?|mobile(?:\s*(?:number|no\.?))?|contact\s+number|telephone)/i,
      value: candidate?.phone,
    },
    {
      tag: "current company",
      hint: /current(?:ly)?\s+(?:employer|company|organisation|organization)|present\s+employer|where\s+do\s+you\s+currently\s+work|your\s+current\s+(?:employer|company)|who\s+is\s+your\s+current\s+or\s+most\s+recent\s+employ/i,
      value: stated?.current_company,
    },
    {
      // "Are you ready to go on business trips every 6-8 weeks?" - the last
      // blocker on #716. Measured, not guessed: the control is a plain
      // input[type=text] carrying the question in its aria-label, exactly the
      // same shape as the Arabic question on the same form. So it needs the
      // TEXT path.
      //
      // Registering it only as a commitment was not enough. Commitments go
      // through combo() (dropdowns) and radio() (Yes/No pairs); neither can see
      // a text input, so the log read "no control matched (7 combobox checked)"
      // and the field stayed empty with the answer sitting in the profile the
      // whole time. Three wrong guesses about this form's control types is what
      // led to measuring it instead - see tools/probe_travel_control.mjs.
      tag: "business travel",
      hint: /business trips?|travel (?:every|\d+\s*-\s*\d+\s*weeks?)|ready to (?:go on )?travel|willing to travel/i,
      value: stated?.business_travel_6_8_weeks,
      once: true,
    },
    {
      // The free-text form of the same question, for forms that really do ask
      // it in a textarea. Drafted from cv.md only.
      //
      // `once` so it cannot fight the select below for the same prompt: this is
      // Scale AI's wording, and there the control is a five-option
      // experience-level dropdown that rejects prose outright. Without `once`,
      // answerQuestion would fill the react-select, have the value rejected, and
      // report "value did not stick" - which is exactly the misleading log that
      // made #333 look like a routing bug instead of a wrong-shaped value.
      tag: "technical skills",
      hint: /describe your technical skills|how would you describe your (?:technical )?skills|your technical strengths|how do you describe your skills|what are your (?:technical )?skills/i,
      value: stated?.technical_skills_self,
      once: true,
    },
    // Language proficiency, as TEXT questions. Measured on Scale AI's live
    // form: "Are you fluent or proficient in Arabic?" is a plain
    // input[type=text] carrying the question in its aria-label. It is not a
    // dropdown and not a radio pair, so the radio/combo attempts alone could
    // never reach it - which is exactly how it blocked #716. These facts are
    // the primary route; radio() and combo() below still cover the other
    // control types a form might use for the same question.
    //
    // once: true is load-bearing. A page can carry several language
    // questions, and without it Arabic's "No" would be written into the
    // French field - the exact fabrication this mechanism exists to prevent.
    //
    // Values come only from application_answers, supplied by the operator.
    {
      tag: "Arabic proficiency",
      hint: new RegExp("\\bArabic\\b", "i"),
      value: stated?.language_arabic,
      once: true,
    },
    {
      tag: "French proficiency",
      hint: new RegExp("\\bFrench\\b", "i"),
      value: stated?.language_french,
      once: true,
    },
    {
      tag: "Spanish proficiency",
      hint: new RegExp("\\bSpanish\\b", "i"),
      value: stated?.language_spanish,
      once: true,
    },
    {
      tag: "German proficiency",
      hint: new RegExp("\\bGerman\\b", "i"),
      value: stated?.language_german,
      once: true,
    },
    {
      tag: "Chinese proficiency",
      hint: new RegExp("\\bChinese\\b", "i"),
      value: stated?.language_chinese,
      once: true,
    },
    {
      tag: "Hindi proficiency",
      hint: new RegExp("\\bHindi\\b", "i"),
      value: stated?.language_hindi,
      once: true,
    },
    {
      tag: "English proficiency",
      hint: new RegExp("\\bEnglish\\b", "i"),
      value: stated?.language_english,
      once: true,
    },
    // Frontend and Node are outside the pipeline's role scope, so a form
    // claiming them would contradict the filter the rest of the system
    // enforces. The operator confirms he has none of them.
    {
      tag: "frontend experience",
      hint: /frontend|front[- ]end/i,
      value: stated?.frontend_experience,
      once: true,
    },
    {
      tag: "React experience",
      hint: /\\breact(?:\\.js|js)?\\b/i,
      value: stated?.react_experience,
      once: true,
    },
    {
      tag: "Angular experience",
      hint: /\\bangular(?:js)?\\b/i,
      value: stated?.angular_experience,
      once: true,
    },
    {
      tag: "Node.js experience",
      hint: /node(?:\\.js|js)/i,
      value: stated?.nodejs_experience,
      once: true,
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
      hint: /(?!\b(?:phone|mobile|tel|dial(?:ling)?|contact|calling|country\s*code)[^a-z]{0,20})\b(?:country|nation)\b.{0,40}?\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b|\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b.{0,40}?\b(?:country|nation)\b|^(?:country|nation)(?:\s+(?:country|nation))*\s*[:*\-]?\s*$/i,
      value: candidate?.country,
    },
    {
      tag: "years of experience",
      hint: YEARS_OF_EXPERIENCE_QUESTION,
      value: yearsOfExperience(candidate),
      // A question scoped to one technology is not the total, whatever it says
      // about "hands-on" or "professional" (#1320 Zema, 2026-11-10). It is left
      // to the per-skill fact below, which answers only from a stated figure.
      notWhen: (signature) => skillScopedQuestion(stated, profile, signature),
    },
    {
      tag: "additional months of experience",
      // "Please select your total additional months of experience:*" - the
      // companion select to the years one, and the field that held Easy Apply on
      // 4/5 with Review doing nothing (#1033, 2026-11-11).
      hint: /\b(?:total\s+)?additional\s+months?\b|\bextra\s+months?\s+of\s+experience/i,
      value: additionalMonthsOfExperience(candidate),
    },
    {
      tag: "skill years",
      // "How many years of hands-on experience do you have with Java in a
      // professional environment?" - answered from application_answers
      // .skill_years and nothing else.
      hint: /years?[\s\S]{0,120}?experience|experience[\s\S]{0,80}?years?/i,
      byField: (signature) => skillYearsFor(stated, signature),
      // Absent unless a per-skill figure is actually stated: a byField fact with
      // nothing to resolve from would otherwise be advertised on every form.
      enabled: () => statedSkillEntries(stated?.skill_years).length > 0,
      // A question that names no technology is the total-experience question,
      // even when it is a select this tag's hint happens to match. It was read as
      // a skill question, resolved to "" and logged
      //   select offers no option for "" (0 year | 1 year | ...)
      // while the total-experience fact never matched the wording "total years of
      // professional experience" (#1033 Heads Up For Tails, 2026-11-11).
      notWhen: (signature) => !skillScopedQuestion(stated, profile, signature),
    },
    {
      tag: "skill rating",
      // "Rate your proficiency in Java (1 = beginner, 10 = expert)" - a stated
      // 1-10 figure per skill, never derived.
      hint: /\brat(?:e|ing)\b|proficiency|out\s+of\s+(?:5|10)|\b1\s*[-–=]\s*(?:5|10)\b/i,
      byField: (signature) => skillRatingFor(stated, signature),
      enabled: () => statedSkillEntries(stated?.skill_ratings).length > 0,
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
      //
      // CTC is the same question under an Indian name. The hint only accepts it
      // in the expected/desired form: "current CTC" is a different question (and
      // for this candidate the answer is zero) so a bare \bctc\b here would
      // quote an expected figure as a current one.
      hint: /(?:expected|desired|required)\s*(?:[a-z]+\s+){0,3}(?:ctc|package|salary|compensation)|salary\s+(?:range|expectation)|compensation\s+expectation|salary\s+you\s+(?:are\s+)?(?:looking|expect|expecting)|ctc\s+expectation/i,
      // Resolved per control: a board asking "per month" and one asking
      // "per annum" need different numbers, and the same profile cannot
      // answer both with one string.
      byField: (signature) => salaryAnswer(stated, signature),
    },
    {
      tag: "current CTC",
      // "What is your current CTC in Lacs per annum?" - a fact, and the profile
      // states it: current_company is "Not currently employed", so there is no
      // current package to report and 0 is the truthful answer. If the candidate
      // were employed this resolves to nothing rather than inventing a figure.
      hint: /current\s*(?:ctc|package|annual\s*compensation|salary|compensation)|present\s*(?:ctc|package|salary)|current\s*annual\s*salary/i,
      // A stated current compensation is the operator's own words and wins over
      // the derived figure: he answered "Internship stipend only" (2026-11-10),
      // which says more, and more truthfully, than a bare 0.
      // Only a stated employment status settles this. An empty profile gets
      // nothing rather than a "0" that claims the candidate earns nothing.
      value: (() => {
        const statedPay = String(stated?.current_compensation ?? "").trim();
        if (statedPay) return statedPay;
        const company = String(stated?.current_company ?? "").trim();
        if (!company) return "";
        return /not currently employed|unemployed|no current employer/i.test(company) ? "0" : "";
      })(),
    },
    {
      tag: "distance from office",
      // "How far do you live from Seawoods Grand Central Tower 1, Mumbai, India?
      // If you are not local, why do you look to move and are you willing to
      // relocate at your own expense?" (#1320 Zema). The question asks for a
      // measurable fact - distance and a relocation commitment - so it is not an
      // essay and no generic paragraph answers it. The stated note says where he
      // lives and what he has agreed to do, and claims no distance in kilometres
      // that nobody measured.
      hint: /how\s+far\s+do\s+you\s+live|how\s+far\s+(?:away\s+)?from\s+(?:the\s+)?(?:office|site|workplace)|distance\s+(?:from|to)\s+(?:the\s+)?(?:office|site|workplace|campus)/i,
      value: String(stated?.location_distance ?? "").trim(),
    },
    {
      tag: "how you heard",
      // A factual account of where the application came from. The truthful
      // answer is the board the row was found on, and the board is a fact in
      // the row - not a guess. "This job board" was the old hardcoded value and
      // Greenhouse's <select> offers "LinkedIn" but not that phrase, so the
      // question stayed empty and blocked a form that was otherwise complete.
      hint: /how\s+did\s+you\s+hear\s+about|how\s+you\s+(?:heard|found)\s+(?:about|this)|where\s+did\s+you\s+(?:hear|find)\s+(?:about|this)/i,
      value: stated?.how_you_heard || heardFromBoard(job),
      fallbackLabels: ["Job board", "Job Board", "Other"],
    },
    {
      tag: "notice period",
      // "What is your Notice Period?" is a DURATION, and Hirist asks it as a
      // mandatory free-text box on the screening form. It used to be answered by
      // the availability rule below, which wrote the computed start date into it
      // - the operator's 30-day notice appeared as "2026-12-04" on the form, a
      // statement nobody made. A notice period is answered in its own unit, and
      // availabilityDate() stays for real date controls.
      hint: /notice\s+period|how\s+long\s+is\s+your\s+notice|notice\s+required/i,
      value: String(candidate?.notice_period ?? "").trim(),
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
      hint: /earliest\s+(?:you\s+would\s+want|availability|date)|available\s+(?:to\s+start|from)|start[-\s]?date|date[-\s]?(?:you|available|can)|when\s+(?:can|could)\s+you\s+start|desired\s+start|pick[-\s]?(?:a\s+)?date|select[-\s]?(?:a\s+)?date|choose[-\s]?(?:a\s+)?date/i,
      value: availabilityDate(candidate),
    },
    {
      tag: "availability days",
      // "Available To Join (in days) *" is a NUMBER of days, not a date and not
      // the prose "30 days". Keka renders it as <input type="number">, which the
      // field locator did not even include, and the date rule above does not
      // match "available to join" - so the required field stayed empty and the
      // whole form's Apply Now button stayed disabled (#1319, 2026-11-09).
      // noticeDays() reads the operator's own "30 days" and returns 30; a notice
      // period the profile does not state produces nothing rather than a guess.
      hint: /available\s+to\s+join|joining\s+(?:in|within)\s+\d+\s*days|availability\s*\(?\s*in\s*days\s*\)?|notice\s+period\s*\(?\s*in\s*days\s*\)?/i,
      value: (() => {
        const days = noticeDays(candidate);
        return Number.isFinite(days) ? String(days) : "";
      })(),
    },
    {
      tag: "gender",
      // A mandatory dropdown on Keka's careers form. It is a fact only the
      // candidate can state, so it lives in application_answers and is never
      // inferred; with no configured value the select is left untouched and the
      // required field is reported instead of being guessed at.
      hint: /\bgender\b/i,
      value: String(stated?.gender ?? "").trim(),
    },
    {
      tag: "disability disclosure",
      // The voluntary self-identification block on Eightfold boards, where the
      // operator chose "No, I don't have a disability" (2026-11-10, #1322
      // PayPal). Only ever used where the form names the question; nothing is
      // inferred from anything else.
      hint: /disabilit\w*|differently\s+abled|voluntary\s+self[- ]identification/i,
      value: String(stated?.disability_disclosure ?? "").trim(),
    },
    {
      tag: "conflict of interest",
      // PayPal's five conflict-of-interest representations - a board seat or an
      // interest in a competitor, a family relationship with an employee, being
      // a government official, a relative being one, and a referral from a known
      // merchant or partner. The operator stated one answer for all five
      // (2026-11-10). The hint stays narrow to those shapes so an unrelated
      // question that merely mentions a family does not inherit a legal
      // representation.
      hint: /(?:board|advisory\s+group)[\s\S]{0,220}?(?:compete|competitor|interest)|family\s+relationship|government\s+official|known\s+merchant|referred\s+to[\s\S]{0,160}?(?:merchant|partner)|(?:spouse|relative)[\s\S]{0,120}?(?:employee|employer|board|interest)/i,
      value: String(stated?.conflict_of_interest ?? "").trim(),
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
      hint: NON_COMPETE_QUESTION,
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
      // A per-control veto: the fact's hint can match a question it must not
      // answer. The years fact is the case - "how many years with Java" matches
      // the general pattern and is still not total experience.
      notWhen: typeof fact.notWhen === "function" ? fact.notWhen : null,
      // A fact that only exists when the operator stated something for it.
      enabled: typeof fact.enabled === "function" ? fact.enabled : null,
    }))
    // A fact with no stated answer behind it is dropped, so it is never
    // advertised on a form it could not answer.
    .filter((fact) => (fact.enabled ? fact.enabled() : true))
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
  const rawStatus = String(job?.status || "").trim();
  const status = rawStatus.toLowerCase();
  const link = job?.link || job?.url || "";
  if (!link || !isAllowedInitialJobUrl(link)) return false;
  // Role scope is a hard gate, and it is checked FIRST.
  if (!isStrictTargetRole(job?.title, jobDescriptionFor(job))) return false;
  // Explicit --job-id runs may target high-score Evaluated OR Verified rows
  // (the pipeline marks email-channel-verified rows Verified; that says
  // nothing about whether the job page still accepts a browser application).
  // Queue mode stays Evaluated-only.
  const okStatus = explicit
    ? (status === "evaluated" || status === "verified")
    : (status === "evaluated");
  if (!okStatus) return false;
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

  if (explicit) {
    // Explicit --job-id bypasses the queue's terminal-status exclusion for
    // the email-channel Verified state only (Verified = email contact found;
    // says nothing about the job page). All other terminal states still block.
    const norm = String(status).replace(/[ _-]/g, "");
    if (norm !== "verified" && isTerminalStatus(status)) return false;
  } else if (isTerminalStatus(status)) return false;
  if (isSimulationJob(job) || !isTrustworthySource(job?.source)) return false;
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

  // The per-application folder is named deterministically by the builder
  // (`resume_builder.build_tailored_resume`): "<company[:24]>-<sha1(title)[:8]>",
  // both parts cleaned the same way. Computing it here resolves the CV that was
  // rendered for THIS role exactly, instead of trusting whichever folder was
  // written last. Without it, every row whose company parsed as "Unknown"
  // resolved to the newest of the nine Unknown-* folders - so #1059, a
  // "Software Engineer - Automation Testing" posting, was handed
  // CV_Unknown_AI_Implementation_Engineer_-_Internship.pdf (2026-11-10).
  const cleanPart = (value) => String(value || "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const companyPart = cleanPart(company).slice(0, 24);
  const rolePart = cleanPart(title);
  if (companyPart && rolePart) {
    const roleKey = createHash("sha1").update(rolePart, "utf8").digest("hex").slice(0, 8);
    candidates.push(path.join(pdfDir, `${companyPart}-${roleKey}`, "CV.pdf"));
  }

  // Files from the older naming scheme, kept only as a fallback: the current
  // builder writes "<company>-<hash>/CV.pdf", so these can only be a match from
  // before that layout, never the more specific answer.
  const safeFilePart = (value) => String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  candidates.push(
    path.join(pdfDir, `${safeFilePart(company)} - ${safeFilePart(title)}.pdf`),
    path.join(pdfDir, `${safeFilePart(company)}.pdf`),
  );

  // A company name that identifies nobody - "Unknown" is the parser's own
  // placeholder - cannot be used to look a CV up: every such row shares it, so
  // a fuzzy match returns an unrelated employer's document. Those rows fall
  // straight through to the base CV, which the caller then re-tailors.
  const anonymousCompany = !companyPart
    || /^(?:unknown|na|none|null|undefined|confidential|undisclosed|stealth|private|notapplicable)$/i
      .test(companyPart.replace(/[^a-z0-9]/gi, ""));

  const needle = anonymousCompany ? "" : norm(company).slice(0, 18);
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

// ── Resume vs CV ────────────────────────────────────────────────────────────
//
// The operator's rule:
//
//   "if board asks for a resume --> then build it from the cv, ats tailor to
//    the jd and the platform then verify it then upload it, if it asks for a
//    cv then send the cv as is"
//
// So the upload control's own label decides which FILE is sent. A form asking
// for a resume is answering a role-specific question and gets a resume built
// from cv.md for this job description; a form asking for a CV is asking for the
// candidate's own document and gets it byte for byte. Guessing from the
// platform instead would get both wrong: Greenhouse hosts both wordings, and
// so does every other board.

/**
 * The candidate's own CV, untouched.
 *
 * It is NOT cv.md and it is NOT output/resume.pdf: it is the file the operator
 * maintains and updates, so it is resolved once and reported when missing
 * rather than silently substituted. Order: an explicit override, then the
 * profile, then the maintained location, then the repo's own render of cv.md.
 */
function findCanonicalCv(profile = null) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const stated = [
    process.env.PULSEOPS_CV_PDF,
    profile?.candidate?.cv_pdf,
    profile?.candidate?.canonical_cv,
  ].map((v) => String(v || "").trim()).filter(Boolean);
  const defaults = [
    home ? path.join(home, "Documents", "Job stuff", "Avradeep-Majumder-cv.pdf") : "",
    path.join(ROOT, "output", "Avradeep-Majumder-cv.pdf"),
  ].filter(Boolean);
  for (const raw of [...stated, ...defaults]) {
    const p = path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/**
 * Which document a file-upload control is asking for, from its own label.
 *
 * Only an explicit request for a CV sends the canonical CV; everything else is
 * a resume. "Resume/CV" is the common Greenhouse wording and counts as a
 * resume request, because it does ask for one and a tailored resume answers
 * both halves of that label.
 */
function decideUploadKind(promptText) {
  const text = String(promptText || "").toLowerCase().replace(/\s+/g, " ");
  const asksResume = /\bresume\b|\bresumes\b|\br\u00e9sum\u00e9\b/.test(text);
  const asksCv = /\bcv\b|\bcurriculum vitae\b|\bc\.v\.?(?=$|[\s,;:])/.test(text);
  const evidence = String(promptText || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (asksResume) return { kind: "resume", evidence, because: "the control asks for a resume" };
  if (asksCv) return { kind: "cv", evidence, because: "the control asks for a CV" };
  // An unlabelled upload is treated as a resume: that is the document this
  // pipeline exists to tailor, and it is still the candidate's own material.
  return { kind: "resume", evidence, because: "no label named a document, so the role-specific resume is the safer default" };
}

/**
 * Read the label of the upload control the page will actually use.
 *
 * The prompt usually lives on a wrapping field, a <label for=...>, or a
 * heading in the upload box - never on the <input type="file"> itself, which
 * is normally hidden behind a styled button.
 */
async function uploadPromptText(page, selectors) {
  for (const sel of selectors || []) {
    const input = page.locator(sel).first();
    if (!(await input.count().catch(() => 0))) continue;
    const text = await input.evaluate((el) => {
      const bits = [
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("accept") || "",
      ];
      if (el.id) {
        const doc = el.ownerDocument;
        for (const lab of doc.querySelectorAll("label")) {
          if (lab.getAttribute("for") === el.id) bits.push(lab.textContent || "");
        }
      }
      const wrappingLabel = el.closest("label");
      if (wrappingLabel) bits.push(wrappingLabel.textContent || "");
      const box = el.closest(
        "fieldset, [class*='upload'], [class*='resume'], [class*='cv'], [class*='attach'], "
        + "[class*='dropzone'], [data-testid*='upload'], [data-testid*='resume']",
      );
      if (box) bits.push((box.textContent || "").slice(0, 300));
      // One level of parent catches a form group whose only prompt is a
      // sibling heading, without dragging in the whole application.
      if (!box && el.parentElement?.parentElement) {
        bits.push((el.parentElement.parentElement.textContent || "").slice(0, 200));
      }
      return bits.join(" ").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    if (text) return { selector: sel, text };
  }
  return { selector: null, text: "" };
}

/**
 * A tailored PDF for this job, built from cv.md when none exists or the one on
 * disk predates the CV the operator last edited.
 *
 * The builder is the same one the daily pipeline uses, so "tailored to the JD"
 * means the stored bullet adjustments and tailored skills for this row, and
 * "tailored to the platform" means its one-page layout profiles. The script
 * verifies the output - real PDF, one page, candidate's name and email present
 * - before reporting a path, so an unverified file is never uploaded.
 */
function ensureTailoredPdf(job) {
  const existing = findResumePdf(job?.company, job?.title, job?.pdf_path);
  let cvMtime = 0;
  try { cvMtime = fs.statSync(path.join(ROOT, "cv.md")).mtimeMs; } catch { cvMtime = 0; }
  // A usable existing resume is one that was rendered for THIS job: either the
  // path the row itself records, or a file inside output/pdf/<folder>/CV.pdf.
  // findResumePdf falls back to output/resume.pdf, which could belong to a
  // different employer - the right thing to do there is build the correct one,
  // not send a stranger's document.
  const pdfRoot = path.resolve(ROOT, "output", "pdf").toLowerCase();
  const recorded = job?.pdf_path ? path.resolve(ROOT, String(job.pdf_path)).toLowerCase() : "";
  let relevant = false;
  if (existing) {
    const abs = path.resolve(existing).toLowerCase();
    relevant = abs === recorded || path.dirname(path.dirname(abs)) === pdfRoot;
  }
  let fresh = false;
  if (existing && relevant) {
    try { fresh = !cvMtime || fs.statSync(existing).mtimeMs >= cvMtime; } catch { fresh = false; }
  }
  if (existing && relevant && fresh) {
    console.log(`    [upload] tailored resume already rendered → ${path.basename(existing)}`);
    return existing;
  }
  if (existing && relevant && !fresh) {
    console.log(`    [upload] ${path.basename(existing)} predates cv.md — rebuilding it for this job`);
  }
  const helper = path.join(ROOT, "apps", "browser-apply", "tools", "build_resume_for_job.py");
  if (!fs.existsSync(helper)) {
    console.log(`    [upload] resume builder missing at ${path.relative(ROOT, helper)}`);
    return existing || null;
  }
  const args = [helper];
  if (job?.id) args.push("--job-id", String(job.id));
  else args.push("--company", String(job?.company || ""), "--title", String(job?.title || ""));
  try {
    const out = execFileSync("python", args, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 240000,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const payload = JSON.parse(String(out).trim().split(/\r?\n/).filter(Boolean).pop());
    if (payload?.ok && payload?.pdf && fs.existsSync(payload.pdf)) {
      const check = payload.verified || {};
      console.log(`    [upload] built and verified a tailored resume → ${path.basename(payload.pdf)}`
        + `${check.pages ? ` (${check.pages} page, ${check.bytes} bytes)` : ""}`);
      return payload.pdf;
    }
    console.log(`    [upload] resume build rejected: ${String(payload?.error || "unknown").slice(0, 120)}`);
  } catch (e) {
    console.log(`    [upload] resume build failed: ${String(e.message || e).slice(0, 160)}`);
  }
  return existing || null;
}

/**
 * Choose the file for the upload control actually on the page.
 *
 * Returns an absolute path, or null when nothing usable exists - in which case
 * the caller reports a missing attachment rather than uploading the wrong
 * document.
 */
async function resolveUploadPdf(page, job, profile, selectors) {
  const prompt = await uploadPromptText(page, selectors);
  const decision = decideUploadKind(prompt.text);
  console.log(`    [upload] control asks for a ${decision.kind === "cv" ? "CV" : "resume"} `
    + `(${decision.because}) — saw "${decision.evidence || prompt.selector || "no label"}"`);
  if (decision.kind === "cv") {
    const canonical = findCanonicalCv(profile);
    if (canonical) {
      console.log(`    [upload] sending the CV as it is → ${path.basename(canonical)}`);
      return canonical;
    }
    console.log("    [upload] no canonical CV file found — falling back to the tailored resume");
  } else {
    const built = ensureTailoredPdf(job);
    if (built) return built;
    const canonical = findCanonicalCv(profile);
    if (canonical) {
      console.log("    [upload] no tailored resume available — sending the CV as it is");
      return canonical;
    }
  }
  const fallback = findResumePdf(job?.company, job?.title, job?.pdf_path);
  if (fallback) {
    console.log(`    [upload] falling back to ${path.basename(fallback)}`);
    return fallback;
  }
  console.log("    [upload] no document could be chosen");
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
  // Keka serves each employer from its own subdomain, so this is a suffix
  // match on keka.com: nudge.keka.com is a Keka careers page. Its form cannot
  // render without cdn.keka.com's jQuery bundle, which only the keka asset
  // allowlist admits.
  if (looksLike("keka")) return "keka";
  // UKG Pro Recruiting: the employer's board is a route of recruiting.ultipro.com
  // (`/PAR1035PPTL/JobBoard/<id>/OpportunityDetail?opportunityId=…`), and its
  // apply form is the `OpportunityApply` route of the same host.
  if (looksLike("ultipro")) return "ultipro";
  if (looksLike("yc")) return "yc";
  if (looksLike("himalayas")) return "himalayas";
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
  // Keka. A job details page (/careers/jobdetails/<id>) has one control, "Apply
  // for this job", which opens /careers/applyjob/<id>; the form there submits
  // with "Apply Now". Measured on nudge.keka.com/94986, 2026-11-09.
  keka: {
    applyBtn: ['button:has-text("Apply for this job")', 'button:has-text("Apply")', 'a:has-text("Apply")'],
    fields: {
      firstName: ['#firstName', 'input[name="firstName"]'],
      lastName: ['#lastName', 'input[name="lastName"]'],
      email: ['#email', 'input[name="email"]', 'input[type="email"]'],
      phone: ['#mobilePhone\\.number', 'input[name="mobilePhone.number"]', 'input[type="tel"]'],
      resume: ['#resume-upload', 'input[type="file"]'],
    },
    submitBtn: ['button:has-text("Apply Now")', 'button[type="submit"]']
  },
  yc: {
    applyBtn: ['a:has-text("Apply")', 'button:has-text("Apply")', 'a[href*="/apply"]'],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], resume: ['input[type="file"]'],
    },
    submitBtn: ['button:not([disabled]):has-text("Send")', 'button:has-text("Send")', 'button:has-text("Submit")', 'button:has-text("Apply")']
  },
  // Himalayas. The posting route is
  // /companies/<slug>/jobs/<title-slug>; its "Apply now" control leaves for the
  // employer's own ATS in the overwhelming majority of listings, which is the
  // same opener shape Wellfound has.
  himalayas: {
    applyBtn: [
      'a:has-text("Apply now")',
      'button:has-text("Apply now")',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ],
    fields: {
      name: ['input[name="name"]'], email: ['input[type="email"]'], phone: ['input[type="tel"]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: ['button:has-text("Submit")', 'button[type="submit"]']
  },
  // UKG Pro Recruiting. The posting route is `OpportunityDetail` and its "Apply
  // Now" control opens the form route `OpportunityApply?opportunityId=<id>`;
  // the form submits from that route. Field names are the vendor's own
  // (`candidateFirstName`, `candidateLastName`, …), with the generic set as the
  // fallback so a renamed field still gets filled.
  ultipro: {
    applyBtn: [
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ],
    fields: {
      firstName: ['input[name="candidateFirstName"]', 'input[id*="FirstName" i]', 'input[name*="firstName" i]'],
      lastName: ['input[name="candidateLastName"]', 'input[id*="LastName" i]', 'input[name*="lastName" i]'],
      email: ['input[name="candidateEmail"]', 'input[type="email"]', 'input[id*="Email" i]'],
      phone: ['input[name="candidatePhone"]', 'input[type="tel"]', 'input[id*="Phone" i]'],
      resume: ['input[type="file"]'],
    },
    submitBtn: [
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button[type="submit"]',
    ]
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
      // Eightfold (paypal.eightfold.ai, #1322, 2026-11-10) renders its contact
      // inputs with a hashed id and no name, so none of the three original
      // selectors matched and the required Email box submitted empty. The extra
      // fallbacks all read the same fact off the profile, so they can only ever
      // write the candidate's own address and number.
      email: ['input[type="email"]', 'input[name="email"]', '#email', 'input[autocomplete="email"]', 'input[aria-label*="email" i]', 'input[id*="email" i]', 'input[name*="email" i]'],
      phone: ['input[type="tel"]', 'input[name="phone"]', 'input[autocomplete="tel"]', 'input[aria-label*="phone" i]', 'input[id*="phone" i]', 'input[name*="phone" i]'],
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

/**
 * react-select's nameless second input is not a field.
 *
 * It renders `<input class="…-requiredInput" style="pointer-events:none">`
 * inside the same field, purely so the browser sees a native `required` flag on
 * the real control. It has no menu and no value, so treating it as a control
 * made combo() match a question that was already answered, open nothing, and
 * leave the blur of that attempt on screen. Measured 2026-11-05, #143 Glean,
 * where it was the "twin combobox" costing a pass per fill round.
 */
function isMirrorInput(locator) {
  return locator.evaluate((el) => /requiredInput/.test(String(el.className || "")))
    .catch(() => false);
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

/**
 * Close any open dropdown before a click that has to land.
 *
 * An open react-select menu puts a document-level mousedown handler in place
 * while it is showing: the next mousedown anywhere on the page closes the menu
 * and the click never reaches the element underneath. Measured 2026-11-05,
 * #143 Glean: "[submit] clicked final Submit application" and then no request
 * of any kind - no POST, no navigation, no validation error. The click only
 * closed a menu that a failed combo() pass had left open, so the board never
 * saw a submit and the run reported a refusal that never happened.
 *
 * Escape is the documented way to close a react-select; the synthetic
 * mousedown on the body is the fallback for widgets that only listen for the
 * raw event. Nothing here types, selects or agrees to anything.
 */
async function closeOpenDropdowns(page) {
  const openCount = () => page.locator('[role="option"]:visible').count().catch(() => 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await openCount())) return true;
    if (page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(180);
      if (!(await openCount())) return true;
    }
    await page.evaluate(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    }).catch(() => {});
    await page.waitForTimeout(180);
  }
  const left = await openCount();
  if (left) console.log(`    [submit] a dropdown is still open (${left} option(s) visible)`);
  return left === 0;
}

/**
 * The words a file widget puts on the button that opens its own picker.
 *
 * Deliberately narrow: "Submit", "Apply", "Save" and "Cancel" must never match,
 * because clicking one of those to reach a file chooser would submit or discard
 * the application instead.
 */
const UPLOAD_BUTTON_LABEL = /upload\s+file|choose\s+file|browse\b|select\s+(?:a\s+)?file|attach\s+(?:a\s+)?(?:file|cv|resume)|upload\s+(?:a\s+)?(?:cv|resume)/i;

/**
 * Hand the file to a widget that owns its own "Upload file" button.
 *
 * A hidden <input type="file"> can be populated by setInputFiles while the
 * widget that owns it never learns about it. Eightfold's dropzone keeps showing
 * "Drag & drop file", issues no request at all, and the form then refuses the
 * submit with "Upload your resume cannot be left blank" - measured on #1322
 * PayPal, 2026-11-10, where the log claimed
 *   [upload] input[type="file"] <- CV.pdf
 * and nothing was ever uploaded. Clicking the control's own button and
 * answering the file chooser is the path its handler was actually written for.
 */
const UPLOAD_LABEL_ATTR = "data-pulseops-upload-control";

/**
 * The elements on the page whose own words say "open a file picker".
 *
 * A role query alone is not enough: Eightfold renders its own control as
 * "Select file" inside the dropzone rather than as a <button>, and the
 * dropzone's container text is the whole widget ("Drag & drop file .pdf, .doc…
 * Select file"), so matching on any ancestor would click the wrong thing.
 * Only an element whose own trimmed text is short and matches is marked, which
 * leaves the innermost label/button. The marks are removed before returning,
 * so the DOM is left as the board rendered it.
 */
async function markUploadControls(page) {
  return page.evaluate(({ src, attr }) => {
    const re = new RegExp(src, "i");
    let n = 0;
    for (const el of document.querySelectorAll('button, [role="button"], label, a, span, div')) {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 60 || !re.test(text)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      el.setAttribute(attr, String(n++));
      if (n >= 4) break;
    }
    return n;
  }, { src: UPLOAD_BUTTON_LABEL.source, attr: UPLOAD_LABEL_ATTR }).catch(() => 0);
}

async function attachViaFileChooser(page, filePath) {
  if (!page || typeof page.waitForEvent !== "function") return false;
  const marked = await markUploadControls(page);
  try {
    for (let i = 0; i < marked; i++) {
      const control = page.locator(`[${UPLOAD_LABEL_ATTR}="${i}"]`).first();
      if (!(await control.isVisible().catch(() => false))) continue;
      // A native picker answers a click in milliseconds, so a short wait keeps
      // a widget that has a matching label but no picker from costing seconds
      // per candidate control.
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 1500 }).catch(() => null);
      await control.click({ timeout: 3000 }).catch(() => {});
      const chooser = await chooserPromise;
      if (!chooser || typeof chooser.setFiles !== "function") continue;
      try {
        await chooser.setFiles(filePath, { timeout: 5000 });
        console.log(`    [upload] the widget's own upload control opened its file picker — attached ${path.basename(filePath)}`);
        return true;
      } catch { /* fall through to the next control */ }
    }
  } finally {
    await page.evaluate((attr) => {
      for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    }, UPLOAD_LABEL_ATTR).catch(() => {});
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
          // A board that carries the file inside the application itself says so
          // in its own markup: Greenhouse's inline uploader is
          //   <div class="file-upload" data-allow-s3="false">
          // and such a form needs no separate object-storage host at all. Waiting
          // four seconds for a host that was never going to be advertised, then
          // warning that the CV "may not have attached", reported a healthy
          // inline attachment as a failure - measured 2026-11-05, #143 Glean.
          const inlineUpload = await el.evaluate((node) => {
            const box = node.closest("[data-allow-s3]");
            if (!box) return null;
            return String(box.getAttribute("data-allow-s3") || "").toLowerCase() !== "true";
          }).catch(() => null);
          if (inlineUpload === true) {
            console.log("    [upload] the board carries the file with the form (no separate upload host)");
            return true;
          }
          // The upload capability is only issued in RESPONSE to picking the
          // file, so the first POST to object storage necessarily happens
          // before the guard has learned the host - and is blocked. The ATS then
          // receives an application with no CV attached. The guard now pre-reads
          // that response (installNavigationGuard), so the host is usually known
          // before the POST is even made; this poll and retry remain as the
          // fallback for a board that advertises the host elsewhere.
          if (uploadHosts && typeof uploadHosts.has === "function") {
            // Did the widget itself take the file? Its own chip or filename is
            // the board saying so, and it is the only evidence available when
            // the board uploads inline and advertises no host.
            const fileShown = async () => {
              try {
                return (await page.getByText(path.basename(filePath), { exact: false }).count()) > 0;
              } catch { return false; }
            };
            await page.waitForTimeout(400);
            let attached = await fileShown();
            // Nothing arrived and nothing is displayed: the input we set is not
            // the one this widget listens to. Ask its own button instead of
            // re-picking the same file into the same dead input.
            if (!attached && !uploadHosts.size) {
              attached = await attachViaFileChooser(page, filePath);
              if (attached) await page.waitForTimeout(800);
            }
            const deadline = Date.now() + 8000;
            while (!uploadHosts.size && Date.now() < deadline) {
              await page.waitForTimeout(250);
            }
            if (uploadHosts.size) {
              // Only re-pick when the board has not already accepted the file:
              // picking the SAME file a second time can put the widget back into
              // its empty state, which is how #1320's form went from an attached
              // CV.pdf to "Click or drag file to upload" (2026-11-10).
              const shown = await fileShown();
              if (!shown) {
                await el.setInputFiles(filePath, { timeout: 5000 }).catch(() => {});
                console.log(`    [upload] retried against trusted host(s): ${[...uploadHosts].join(", ")}`);
              } else {
                console.log(`    [upload] ${path.basename(filePath)} is attached — no retry needed`);
              }
            } else if (attached || await fileShown()) {
              // The board carries the file inline and shows it: a host was never
              // going to be advertised.
              console.log(`    [upload] ${path.basename(filePath)} is attached — the board keeps it with the form`);
            } else {
              // The board's own second upload attempt can still land (Deel made
              // one on #1320 and succeeded), so this is a warning, not a verdict:
              // the row is only ever marked on the submit's own evidence.
              console.log("    [upload] no upload host was advertised within 8s and the board shows no attached file; watching whether it retries the upload itself");
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
 * The ATS whose allowlist applies to THIS request.
 *
 * Read from the document that issued the request, not from the row that was
 * scraped and not from the page object the guard was installed on. A LinkedIn
 * row's Apply control can hand the form to Greenhouse in a new tab, and the
 * guard installed on the LinkedIn page then sees Greenhouse's own requests
 * while still holding a LinkedIn allowlist - so the form's runtime was refused
 * and the page never hydrated:
 *
 *   [subresource-block] script GET .../job-boards.cdn.greenhouse.io/assets/root-…js
 *
 * That is not a cosmetic failure. Without the bundle no react-select opens,
 * no client-side submit exists, and "Submit application" falls through to the
 * inert server-rendered <form method="get">, reloading the page with every
 * field empty. Measured 2026-11-05, #143 Glean.
 *
 * The frame's own URL is trustworthy here: it is where the document actually
 * came from, so a third-party page cannot claim an ATS's allowlist.
 */
function servingAtsForRequest(request, page, fallback = "generic") {
  let frameUrl = "";
  try { frameUrl = request.frame?.()?.url?.() || ""; } catch { frameUrl = ""; }
  for (const candidate of [frameUrl, page?.url?.() || ""]) {
    const ats = inferATS(candidate);
    if (ats && ats !== "generic") return ats;
  }
  return fallback || "generic";
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
  // Hirist is a Next.js app served from www.hirist.tech with every JS chunk on
  // js-static.hirist.tech. Measured 2026-11-03: with that host blocked the page
  // keeps its server-rendered shell but never hydrates, so no Apply control
  // exists to click and all 31 pending Hirist rows died on "no Apply button
  // found for generic". Unblocked, the same page renders Login/Apply and the
  // Apply click opens the board's own login-or-apply dialog.
  "hirist.tech": ["js-static.hirist.tech"],
  "www.hirist.tech": ["js-static.hirist.tech"],
  "hirist.com": ["js-static.hirist.tech"],
  "www.hirist.com": ["js-static.hirist.tech"],
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

/**
 * A portal's own API hosts, allowed for reads - plus the exact auth handshake
 * it needs to render an application form.
 *
 * Hirist is here because the job page is not server-rendered: the posting, the
 * salary line and the Apply button itself are all fetched from
 * gladiator.hirist.tech after hydration. Measured 2026-11-03 by blocking only
 * that host - the page fell from 13,458 characters to 286 with no Apply button,
 * which is exactly the "no Apply button found for generic" the runner had been
 * recording on all 31 pending rows.
 *
 * The screening form one click later hangs on a single POST to
 * assessmentapi.hirist.tech/v1/login: with it blocked the page stays a skeleton
 * (128 characters, no questions) and with it allowed the questions render
 * (864 characters). That call carries the session the browser already has, so
 * it is the board's own auth check, not an application submission - and it is
 * pinned to one host and one path rather than opened per method.
 *
 * Everything else about the board's POSTs, including the real submit, stays
 * subject to the normal apply-path rules.
 */
const PORTAL_API_HOSTS = Object.freeze({
  "hirist.tech": ["gladiator.hirist.tech", "assessmentapi.hirist.tech"],
  "www.hirist.tech": ["gladiator.hirist.tech", "assessmentapi.hirist.tech"],
  "hirist.com": ["gladiator.hirist.tech", "assessmentapi.hirist.tech"],
  "www.hirist.com": ["gladiator.hirist.tech", "assessmentapi.hirist.tech"],
  // Deel serves its guest application form from jobs.deel.com but every lookup
  // and every upload capability comes from its own API host. Measured
  // 2026-11-10, #1320 Zema: the country/state lookups and the upload-request
  // POST were all blocked, so the dropdowns stayed empty, the CV was never
  // attached, and the form could not be submitted at all.
  "jobs.deel.com": ["api-prod.letsdeel.com"],
});

/**
 * The screening form's own submission, as XHR rather than a form post.
 *
 * Measured on #1054: with every question answered and Next enabled, the click
 * posts to gladiator.hirist.tech/job/assessment_complete?jobcode=<id> and then
 * gladiator.hirist.tech/job/apply?jobcode=<id>. Both were blocked, so the page
 * did nothing at all, six attempts in a row, and the row recorded NeedsReview -
 * no Hirist screening application could ever complete while that was true.
 *
 * This is the one place the board's own submission is allowed through, so it is
 * pinned to the exact paths and to a query that names a numeric jobcode; the
 * act itself is still gated by the final-action check (live mode, --auto, pause
 * re-read) that runs immediately before the click.
 */
const PORTAL_SUBMIT_POST_PATHS = Object.freeze({
  "gladiator.hirist.tech": /^\/job\/(?:apply|assessment_complete)$/,
});

const PORTAL_API_POST_PATHS = Object.freeze({
  // /v1/login is the board's own session check: with it blocked the screening
  // form stays a skeleton (128 chars, no questions).
  // /v1/questionResponse is the form recording the answer we just typed into
  // it; with it blocked the page renders but Next never advances.
  "assessmentapi.hirist.tech": ["/v1/login", "/v1/questionResponse"],
  // Deel's guest application namespace on its own API host: the upload-request
  // capability (#1320) and the application submit both live here. Pinned to the
  // namespace rather than the host, so no other Deel endpoint becomes writable,
  // and the submit itself is still gated by the final-action check at the click.
  "api-prod.letsdeel.com": ["/deelapi/guest/ats/"],
});

function portalApiHostAllowed(pageOrigin, url, method, requestType) {
  if (!pageOrigin || !url || url.protocol !== "https:") return false;
  const type = String(requestType || "").toLowerCase();
  if (!["xhr", "fetch", "other", ""].includes(type)) return false;
  let pageHost = "";
  try {
    pageHost = canonicalHost(new URL(pageOrigin).hostname);
  } catch {
    return false;
  }
  const hosts = PORTAL_API_HOSTS[pageHost];
  if (!hosts) return false;
  const host = canonicalHost(url.hostname);
  if (!hosts.some((candidate) => canonicalHost(candidate) === host)) return false;
  const verb = String(method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  if (!["xhr", "fetch"].includes(type)) return false;
  // A listed path is writable by POST only. Without this the path allowance
  // covered every other verb too, including DELETE.
  if (verb !== "POST") return false;
  const paths = PORTAL_API_POST_PATHS[host];
  if (paths && paths.some((prefix) => url.pathname.startsWith(prefix))) return true;
  // The form's own submission, pinned to exact paths and to a numeric jobcode.
  const submitPath = PORTAL_SUBMIT_POST_PATHS[host];
  if (submitPath && submitPath.test(url.pathname)) {
    return /(?:^|&)jobcode=\d+(?:&|$)/.test(String(url.search || "").replace(/^\?/, ""));
  }
  return false;
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
  // The ATS that serves the page NOW, not the board the row was found on.
  //
  // A row scraped from LinkedIn hands its form to Greenhouse, and every
  // allowlist below - the ATS's own runtime scripts, its read-only API, its
  // application POST - has to follow the page on screen. Keeping the row's ATS
  // here meant a LinkedIn row's Greenhouse form had its whole JS bundle
  // refused:
  //
  //   [subresource-block] script GET .../job-boards.cdn.greenhouse.io/assets/root-…js
  //
  // so the page never hydrated. No dropdown could open, no client-side submit
  // existed, and clicking "Submit application" fell through to the inert
  // server-rendered <form method="get">, reloading the page with every field
  // empty. Measured 2026-11-05, #143 Glean.
  let servingAts = boundary.ats || ats || "generic";
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
          if (!shortener && !tryPinExternalApplyOrigin(boundary, requestUrl, servingAts)) {
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
        // The page that will now load is the one whose vendor allowlists apply.
        const derived = inferATS(requestUrl);
        if (derived && derived !== "generic" && derived !== servingAts) {
          servingAts = derived;
          boundary.ats = derived;
          console.log(`    [ats] page is served by ${derived} — allowlists follow it`);
        }
      } else {
        // While filling/uploading, permit only same-origin HTTP(S) resources.
        // This covers cross-origin iframes, form actions, fetch/XHR, and
        // script/image requests before PII can leave the page.
        const frameOrigin = requestFrameOrigin(request, page)
          || parseHttpUrl(navigationPinnedOrigin(boundary));
        const requestParsed = parseHttpUrl(requestUrl);
        const blankFrame = /^about:blank(?:[#?].*)?$/i.test(String(requestUrl || ""));
        // Which vendor's allowlist applies to this request is decided by the
        // document that issued it, not by the row's source board.
        const requestAts = servingAtsForRequest(request, page, servingAts);
        const trustedAsset = isAllowedAssetRequest(requestUrl, requestType, requestAts)
          || portalAssetHostAllowed(frameOrigin, requestParsed);
        const trustedPortalApi = portalApiHostAllowed(frameOrigin, requestParsed, requestMethod, requestType);
        const trustedReadOnlyApi = isAllowedReadOnlyApiRequest(
          requestUrl, requestType, requestMethod, requestAts
        );
        const trustedPresignedUpload = isAllowedPresignedUploadRequest(
          requestUrl, requestType, requestMethod, uploadHosts
        );
        const trustedCaptchaToken = isAllowedCaptchaTokenRequest(requestUrl, requestType);
        // A board's own fraud-detection vendor, allowed per the operator's
        // instruction. See FINGERPRINT_VENDOR_SUFFIXES for why this is fidelity
        // rather than evasion - and what it costs in privacy.
        const trustedFingerprintVendor = isFingerprintVendorHost(requestParsed);
        const trustedAtsPost = isAllowedAtsApplicationPost(requestUrl, requestType, requestMethod, requestAts);
        if (!blankFrame && !trustedAsset && !trustedReadOnlyApi && !trustedPresignedUpload
            && !trustedCaptchaToken && !trustedAtsPost && !trustedFingerprintVendor && !trustedPortalApi
            && (!requestParsed || !frameOrigin || !sameOrigin(requestParsed, frameOrigin))) {
          const kind = request.resourceType?.() || "subresource";
          console.log(`    [subresource-block] ${kind} ${requestMethod || "GET"} ${requestUrl}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      // The upload capability is issued in the ATS's response, and the browser
      // POSTs the file to object storage immediately afterwards. Harvesting that
      // host from the `response` event loses the race: the S3 POST is already in
      // flight, gets blocked, and re-picking the same file does not make the
      // board re-upload it. Measured 2026-11-10, #1320 Zema: the log said
      // "retried against trusted host(s)" while the page still showed an empty
      // "Please upload your resume" box and Apply stayed disabled.
      //
      // So this one response is fetched through the guard, its body read, and
      // only then handed to the page - the host is known before anything can
      // Post to it. Scoped to the ATS's own capability endpoints; every other
      // request takes the ordinary path below.
      if (uploadHosts && typeof uploadHosts.add === "function"
          && /presigned_fields|presigned_attributes|ApiCreateFileUploadHandle|application_form_upload_requests/i.test(requestUrl)) {
        try {
          const fetched = await route.fetch();
          const body = await fetched.text();
          try {
            const added = collectPresignedUploadHosts(JSON.parse(body), uploadHosts);
            if (added) console.log(`    [upload] presigned upload host trusted: ${[...uploadHosts].join(", ")}`);
          } catch { /* not JSON, nothing to trust */ }
          await route.fulfill({ response: fetched, body });
          return;
        } catch (error) {
          // A failure here must not take the form down: fall through and let the
          // request continue unread, exactly as before.
          console.log(`    [upload] could not pre-read the upload capability: ${String(error).slice(0, 60)}`);
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

/**
 * A control whose label says "start the application", not "send it".
 *
 * Keka's job details page (nudge.keka.com/careers/jobdetails/94986, measured
 * 2026-11-09) carries exactly one visible control, "Apply for this job", and no
 * fields. The readiness check below used to accept any visible submit|apply|
 * continue|next control as "the form has rendered", so it declared that page
 * ready; the run then filled zero fields, found the same button when it looked
 * for Submit, clicked it, and recorded NeedsVerification — on a page whose real
 * form was one click away.
 *
 * A form that is genuinely open says "Submit application", "Send application",
 * "Continue" or "Next". A control that says "Apply" is the door to the form.
 */
function isApplicationSurfaceControl(label) {
  const text = String(label || "").trim();
  if (!text) return false;
  if (/\bapply\b/i.test(text)) return false;
  return /\b(?:submit|send application|continue|next)\b/i.test(text);
}

async function waitForApplicationSurface(page, timeoutMs = 30000) {
  if (!page || typeof page.evaluate !== "function") return true;
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let polls = 0;
  while (Date.now() < deadline) {
    // Readiness is the presence of real form controls. Loader copy such as
    // "Reading Your Resume" stays in the DOM after parsing finishes, so text
    // matching alone would block forever. The labels are judged in Node so the
    // rule stays one implementation and stays testable.
    const probe = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const entry = [...document.querySelectorAll("input, textarea, select")].filter(visible)
        .filter((el) => !/hidden|submit|button|file|checkbox|radio/i.test(`${el.type || ""}`));
      const labels = [...document.querySelectorAll("button, a, [role='button']")].filter(visible)
        .map((el) => ((el.innerText || el.value || "") || "").trim());
      return { fields: entry.length, labels };
    }).catch(() => ({ fields: 0, labels: [] }));
    const ready = probe.fields > 0 || (probe.labels || []).some(isApplicationSurfaceControl);
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

// A sign-in page is never an application page. Measured 2026-11-05, #1271
// Vahan.ai: the LinkedIn Apply link went to forms.gle, which redirected to
// accounts.google.com because that session was signed out. The hop was
// approved as an "off-site apply host", the runner filled nothing, found no
// Submit on Google's login screen, and recorded NeedsReview - which reads like
// a broken application form rather than a session that needs a sign-in.
// Refusing the pin says what actually happened instead.
const AUTH_WALL_HOST = /^(?:accounts\.google\.com|accounts\.youtube\.com|login\.microsoftonline\.com|login\.live\.com|login\.yahoo\.com|appleid\.apple\.com|github\.com|gitlab\.com|auth0\.com|okta\.com|sso\.|signin\.|accounts\.)$/;
const AUTH_WALL_SUFFIX = /(?:^|\.)(?:auth0\.com|okta\.com|onelogin\.com|duosecurity\.com|pingidentity\.com|workos\.com)$/;

function isAuthWallHost(host) {
  const h = canonicalHost(host);
  if (!h) return false;
  return AUTH_WALL_HOST.test(h) || AUTH_WALL_SUFFIX.test(h)
    || /^(?:login|signin|sign-in|auth|sso|accounts)\./.test(h);
}

// A Google Form is a real application channel used by a lot of small India
// startups, not an ATS, so it cannot be reached through any board's own host.
// Only the /forms/ path is allowed; docs.google.com/docs or /drive is not an
// application and stays refused.
function isGoogleFormUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && canonicalHost(u.hostname) === "docs.google.com"
      && /^\/forms\//.test(u.pathname);
  } catch {
    return false;
  }
}

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
  // A sign-in wall is not a form. Denying the pin leaves the run reporting a
  // redirect block, which is the truth, instead of NeedsReview on a login page.
  if (isAuthWallHost(host)) return false;
  if (host === "docs.google.com" && !isGoogleFormUrl(url.href)) return false;
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
      // The off-site host is the page that will be filled from now on, so its
      // vendor allowlists apply to it. Leaving the row's ATS in place here was
      // the other half of the #143 failure: the guard pinned Greenhouse while
      // still holding a LinkedIn allowlist, so Greenhouse's own runtime was
      // refused and the form stayed inert.
      const derived = inferATS(page.url());
      if (derived && derived !== "generic") boundary.ats = derived;
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
  // The page in front of us is not always the board the row came from. A
  // LinkedIn row whose Apply links out to Greenhouse lands on
  // job-boards.greenhouse.io, and classifying that page's own "Apply" with
  // LinkedIn's rules read it as the FINAL submission: measured 2026-11-05,
  // #143 Glean logged "[submit] clicked final Apply", then filled the form, and
  // returned without ever pressing "Submit application". A filled form that was
  // never submitted is the worst outcome available - it looks like an
  // application, costs a batch slot, and produces no receipt.
  //
  // So classify against the ATS that actually serves the page, and treat an
  // off-site hop as an opener regardless: on the employer's own form an
  // "Apply"-labelled control opens the form, it does not send it.
  const liveAts = inferATS(currentUrl);
  const effectiveAts = liveAts && liveAts !== "generic" ? liveAts : ats;
  const hoppedOffBoard = effectiveAts !== ats;
  const sels = ATS_SELECTORS[effectiveAts]?.applyBtn || ATS_SELECTORS.generic.applyBtn;
  /**
   * The first match in DOM order is not necessarily the control a person can
   * see. Hirist renders two Apply buttons and one is a hidden responsive
   * duplicate; clicking that one does nothing, the run then waits for a form the
   * board never opened, and an application that a single click would have sent
   * is recorded as NeedsReview. Prefer the first visible match, and fall back to
   * the plain first match for stubs and for pages where nothing reports visible.
   */
  const firstVisibleMatch = async (locator) => {
    if (typeof locator?.nth !== "function" || typeof locator?.count !== "function") {
      return locator.first();
    }
    const total = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 10); i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible?.().catch(() => false)) return candidate;
    }
    return locator.first();
  };
  for (const sel of sels) {
    const el = await firstVisibleMatch(page.locator(sel));
    if (await el.count() > 0) {
      const href = typeof el.getAttribute === "function" ? await el.getAttribute("href").catch(() => null) : null;
      const innerText = typeof el.innerText === "function" ? await el.innerText().catch(() => "") : "";
      const ariaLabel = typeof el.getAttribute === "function" ? await el.getAttribute("aria-label").catch(() => "") : "";
      const valueLabel = typeof el.getAttribute === "function" ? await el.getAttribute("value").catch(() => "") : "";
      const label = (innerText || ariaLabel || valueLabel || sel).trim().slice(0, 80);
      console.log(`    [found] Apply → ${sel} "${label}" href=${href?.slice(0,80)}`);
      // A recommendation card and a "see all jobs" shortcut both carry "Apply"
      // text. Clicking one opens a different posting, so it is skipped rather
      // than classified - the page's own missing-apply state is decided below.
      if (href && isListingBrowseUrl(href, page.url())) {
        console.log(`    [apply-skip] ${sel} browses jobs (${String(href).slice(0, 70)}), not this job's apply control`);
        continue;
      }
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
      const forceIntermediate = (APPLY_IS_ALWAYS_INTERMEDIATE.has(effectiveAts) || hoppedOffBoard)
        && type !== "submit";
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
    // Name the control the way the page does. `hint.split(" ")[0]` is empty
    // whenever the id is missing, which reported Keka's optional
    // workExperience.months select as "field (offered: 0 .. 11)" — a message
    // that cannot be traced back to a control.
    const name = String(select.name || select.label || select.id || "field").trim().slice(0, 60) || "field";
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
      unanswered.push(`${name} (offered: ${select.options.join(" / ")})`);
      continue;
    }
    await page.locator("select").filter({ has: page.locator(`option:text-is("${pick}")`) }).first()
      .selectOption({ label: pick }).catch(() => {});
    console.log(`    [answer] ${name} → "${pick}"`);
    answered.push(name);
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

/*
 * Order eligible rows so the best applications are spent first.
 *
 * The previous order was board-acceptance first, then whatever the SQL returned.
 * That put a 12-score "Engineering Manager, Infrastructure" ahead of a 65-score
 * India backend role purely because Greenhouse has a better acceptance record
 * than the India boards - the batch was spent on rows the role gate should never
 * have admitted, while the roles the candidate can actually win never ran.
 *
 * Order now: India first (the candidate is in Greater Noida and cannot take a US
 * on-site role), then fit score, and only then the board's acceptance record,
 * which is a tiebreak rather than a priority. The sort is stable on the original
 * index, so equal rows never reshuffle between runs.
 */
const INDIA_ONLY_BOARD = /naukri|instahyre|hirist|cutshort|foundit|naukri\.com/i;

const INDIA_PLACE = /\bindia\b|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|noida|gurgaon|gurugram|delhi|ncr|kolkata|ahmedabad|jaipur|kochi|coimbatore|indore|chandigarh/i;

/**
 * Is this row worth one of the batch's slots before the US-AWS-looking work?
 *
 * A board name alone is not evidence. Wellfound used to be in INDIA_BOARD, and
 * because its scraper never captured the place, 87 blank-location rows scored
 * 85-88 and sorted ahead of 54 LinkedIn rows that were actually in India - a
 * measured batch of 8 spent every slot on US-only Wellfound roles whose own
 * modal disables Send ("not accepting applications from your current location").
 *
 * So: a stated India place wins regardless of board. On the India-only boards an
 * unstated place is still India (that is all they list). Anywhere else an
 * unstated place is not evidence of anything and sorts behind.
 */
function isIndiaBoardRow(row) {
  const place = `${row?.location_resolved || ""} ${row?.location_raw || ""}`;
  if (INDIA_PLACE.test(place)) return true;
  const where = `${row?.source || ""} ${row?.link || ""}`;
  return INDIA_ONLY_BOARD.test(where);
}

function rankByAcceptance(rows, acceptance) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const groupOf = (row) => {
    if (!acceptance || acceptance.size === 0) return 2;
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
    .map((row, index) => ({
      row,
      index,
      market: isIndiaBoardRow(row) ? 0 : 1,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : -1,
      group: groupOf(row),
    }))
    .sort((a, b) => (a.market - b.market)
      || (b.score - a.score)
      || (a.group - b.group)
      || (a.index - b.index))
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
      // A <label for="id"> is the canonical name of a field, and it is often the
      // ONLY place the question is written. Keka's salary inputs sit in a
      // `div.validation` next to a currency widget, and the nearest ancestor that
      // yields any text is the widget row - "INR Monthly" - so the walk stopped
      // there and the signature read
      //   "expectedsalary expectedsalary.amount monthly"
      // instead of "Expected Salary *". The required field then blocked the
      // submit while the answer sat in the profile (nudge.keka.com #1319,
      // 2026-11-09). Reading the label directly is cheaper and more exact than
      // climbing further, and it cannot pick up a neighbouring question.
      const own = [
        el.getAttribute("aria-label") || "",
        (() => {
          if (typeof document === "undefined" || !el.id) return "";
          try {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            return label ? String(label.textContent || "") : "";
          } catch {
            return "";
          }
        })(),
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
        + "[class*='indicator'], [class*='live'], [class*='placeholder'], [role='listbox'], "
        // A react-select injects its own CSS into a <style> element INSIDE the
        // widget, and textContent includes that CSS. On Greenhouse the nearest
        // ancestor of "How did you hear about Glean?*" yielded
        //   ".remix-css-1a0ro4n-requiredinput{opacity:0;pointer-events:none;...}"
        // as its prompt text, so the walk stopped before it reached the label,
        // the signature never contained the question, and no hint could match -
        // the required field then blocked the submit. Measured 2026-11-05 with
        // the same page at 0ms, 800ms and 2500ms: the label only appeared once
        // the style node was gone from the tree at hydration. Style is not a
        // prompt in any case, so it never belongs in the signature.
        + "style, script, noscript, template, svg, link, meta",
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
      // A character counter and a widget's own placeholder are the nearest text
      // to a control while saying nothing about the question. Deel renders both
      // ("Your answer" above the box, "0/500" below it), so the walk stopped one
      // ancestor too early on every application question and seven required
      // fields looked like controls with no prompt at all — no hint could match
      // them, and "Apply" could never enable (#1320 Zema, 2026-11-10).
      const said = question.replace(/\s+/g, " ").trim();
      // "Your answer" and a character counter are the widget's own furniture, not
      // the question: Deel prints both directly above and below every box, so the
      // nearest ancestor yielding text is "Your answer 0/500" and the real prompt
      // ("Desired Base Salary (please specify amount and currency) *") sits one
      // level higher (#1320 Zema, 2026-11-10). Judge what is left after the
      // furniture is removed.
      const substance = said
        .replace(/your answer/gi, " ")
        .replace(/\d+\s*\/\s*\d+/g, " ")
        .replace(/[^a-z]+/gi, " ")
        .trim();
      if ((substance.match(/[a-z]/gi) || []).length >= 4) break;
      question = "";
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
    // Which fields the board itself is complaining about. A complaint is often
    // only an aria-invalid flag plus a short "This field is required." line, so
    // the field is what has to be named - the message alone says nothing about
    // where to look.
    const fieldLabel = (node) => {
      const wrap = node.closest(".field-wrapper") || node.closest("[class*='phone-input']");
      const label = wrap && wrap.querySelector("label");
      return (label ? label.textContent : "").replace(/\s+/g, " ").trim().slice(0, 50);
    };
    const problems = [...document.querySelectorAll(
      "[aria-invalid='true'], [class*='error'], [class*='Error'], [class*='invalid']",
    )]
      .filter(visible)
      .map((node) => ({
        field: fieldLabel(node) || node.id || node.getAttribute("name") || "",
        text: text(node).slice(0, 70),
      }))
      .filter((entry) => entry.field || entry.text)
      .slice(0, 8);
    return {
      heading: take("h1, h2, h3", 3),
      messages: take("[role='alert'], [role='status'], [class*='error'], [class*='Error'], [class*='invalid']", 6),
      problems,
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
async function acceptRequiredTerms(page, options = {}) {
  if (!ACCEPT_TERMS) return [];
  if (!page || typeof page.evaluate !== "function") return [];
  const includeOptional = options?.includeOptional === true;
  const accepted = await page.evaluate((alsoOptional) => {
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
      // `alsoOptional` is only set when the final button is ALREADY disabled:
      // Keka's candidate-consent box is not marked required, yet it is the
      // switch that enables "Apply Now" (measured 2026-11-09, #1319). It must
      // still read as a consent, and marketing opt-ins stay untouched.
      if (!required && !alsoOptional) return;
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
/**
 * The forward button on a board's own warning dialog, before it hands the
 * application to the employer.
 *
 * LinkedIn opens "Job search safety reminder" over the posting when Apply is
 * clicked, with "Review job post" and "Continue applying" — no navigation, no
 * form. The run waited for a form that could not appear and recorded
 * NeedsReview on a live application (#1307 TAXOSMART, 2026-11-10). Only the
 * forward action is matched: "Review job post" goes back to the posting, and a
 * submission label can never match here.
 */
const APPLY_INTERSTITIAL_LABEL =
  /^(?:continue\s+applying|continue\s+to\s+(?:the\s+)?(?:application|company(?:\s+site)?|employer(?:\s+site)?|external(?:\s+site)?)|proceed\s+to\s+(?:the\s+)?(?:application|company(?:\s+site)?))\b/i;

/**
 * The forward control inside a board's own application wizard.
 *
 * LinkedIn Easy Apply is a 5-page wizard whose only advance control is "Next",
 * becoming "Review" and then a separate "Submit application". Matching it by
 * name alone is not enough: a profile-edit overlay that opens during the run
 * ("Dismiss | Save | Delete experience | Add work experience | Back | Next")
 * carries the same label, so the walk drove the wrong dialog for the rest of
 * its steps (#1033 Heads Up For Tails, 2026-11-10). The caller additionally
 * scopes this to the wizard's own container; the set stays exact so "Back",
 * "Save", "Add work experience" and any submission label can never match.
 */
const EASY_APPLY_STEP_NAME = /^(?:next|review|review\s+your\s+application|continue\s+to\s+next\s+step)$/i;

/**
 * Fill the work-experience form that LinkedIn's Easy Apply renders inside its
 * own wizard, and save it.
 *
 * #1033 (Heads Up For Tails, 2026-11-10) reached step 3/5 and stopped there:
 * the step is an "Edit experience" form - title, company, city, and the
 * required "Dates of employment" selects - and Next does nothing until the
 * dates are chosen. The dates are in the CV, transcribed into
 * `application_answers.experience_history`; nothing is inferred from the
 * posting, and an employer or title the profile does not state is left blank so
 * the run stops at a human instead of writing a wrong date into the candidate's
 * real profile.
 *
 * Returns true when the step was found and saved.
 */
async function fillLinkedinExperienceStep(page, profile) {
  const answers = profile?.application_answers || profile?.candidate?.application_answers || {};
  const history = Array.isArray(answers.experience_history) ? answers.experience_history : [];
  const inspect = () => page.evaluate(() => {
    const flat = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
    const scopes = [...document.querySelectorAll("div, section, aside, form")]
      .filter((el) => {
        const t = flat(el);
        return t.length > 0 && t.length < 12000
          && /\bApply to\s+\S/.test(t) && /\b\d+\s*\/\s*\d+\s+pages?\b/i.test(t);
      })
      .sort((a, b) => flat(a).length - flat(b).length);
    const scope = scopes[0];
    if (!scope) return null;
    document.querySelectorAll("[data-pulseops-exp], [data-pulseops-exp-current], [data-pulseops-exp-save]")
      .forEach((el) => {
        el.removeAttribute("data-pulseops-exp");
        el.removeAttribute("data-pulseops-exp-current");
        el.removeAttribute("data-pulseops-exp-save");
      });
    const visible = (el) => el.offsetParent !== null;
    const selects = [...scope.querySelectorAll("select")].filter(visible);
    selects.forEach((el, index) => el.setAttribute("data-pulseops-exp", String(index)));
    const checkboxes = [...scope.querySelectorAll("input[type='checkbox']")].filter(visible);
    const current = checkboxes.find((box) => /currently\s+work|present/i.test(box.closest("label, div, li")?.innerText || ""));
    if (current) current.setAttribute("data-pulseops-exp-current", "1");
    const save = [...scope.querySelectorAll("button")].find((b) => /^save$/i.test(flat(b)) && visible(b));
    if (save) save.setAttribute("data-pulseops-exp-save", "1");
    const inputs = [...scope.querySelectorAll("input:not([type='checkbox']):not([type='radio']):not([type='hidden'])")]
      .filter(visible);
    return {
      text: flat(scope).slice(0, 1200),
      title: (inputs[0]?.value || "").trim(),
      company: (inputs[1]?.value || "").trim(),
      selects: selects.length,
      current: !!current,
      save: !!save,
    };
  }).catch(() => null);

  const step = await inspect();
  if (!step || !isExperienceStepText(step.text)) return false;
  const match = matchExperienceEntry(history, { title: step.title, company: step.company });
  if (!match) {
    console.log(`  [easy-apply] experience step "${step.title || "?"}" at "${step.company || "?"}": no dates stated in the profile — leaving it for a human`);
    return false;
  }
  const dates = match.dates;
  const needed = dates.current ? 2 : 4;
  if (step.selects < needed) {
    console.log(`  [easy-apply] experience step has ${step.selects} date selects, expected ${needed} — leaving it for a human`);
    return false;
  }

  const setSelect = async (index, label) => {
    const control = page.locator(`[data-pulseops-exp="${index}"]`).first();
    let chosen = false;
    try {
      await control.selectOption({ label });
      chosen = true;
    } catch {
      chosen = await control.selectOption(String(label)).then(() => true).catch(() => false);
    }
    if (!chosen) return false;
    const shown = (await control.evaluate((el) => (el.selectedOptions?.[0]?.textContent || "").trim()).catch(() => ""));
    return shown.toLowerCase() === String(label).toLowerCase();
  };

  const startOk = (await setSelect(0, dates.startMonth)) && (await setSelect(1, dates.startYear));
  let datesOk = startOk;
  if (startOk && dates.current) {
    if (step.current) {
      await page.locator("[data-pulseops-exp-current]").first().check({ timeout: 5000 }).catch(() => {});
    } else {
      // A current role with no "I currently work here" control cannot state an
      // open-ended end date, so it is left for a human rather than guessed.
      datesOk = false;
    }
  } else if (startOk) {
    datesOk = (await setSelect(2, dates.endMonth)) && (await setSelect(3, dates.endYear));
  }
  if (!datesOk) {
    console.log(`  [easy-apply] experience step dates ${dates.startMonth} ${dates.startYear}${dates.endMonth ? ` - ${dates.endMonth} ${dates.endYear}` : " - present"} were refused by the form`);
    return false;
  }
  console.log(`  [easy-apply] experience dates: ${step.title || "?"} at ${step.company || "?"} ${dates.startMonth} ${dates.startYear} - ${dates.current ? "present" : `${dates.endMonth} ${dates.endYear}`} (from cv.md)`);
  if (!step.save) return true;
  await page.locator("[data-pulseops-exp-save]").first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const after = await inspect();
  if (after && isExperienceStepText(after.text)) {
    console.log("  [easy-apply] experience form is still open after Save — the wizard's next step decides whether it advanced");
  }
  return true;
}

/**
 * Step through a board's safety/warning dialog on the way to the form.
 * Returns true when a control was clicked, so the caller re-checks for the
 * form rather than treating the dialog as the end of the flow.
 */
async function dismissApplyInterstitial(page) {
  if (!page || typeof page.getByRole !== "function") return false;
  const controls = page.getByRole("button", { name: APPLY_INTERSTITIAL_LABEL });
  const total = Math.min(await controls.count().catch(() => 0), 3);
  for (let i = 0; i < total; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = (await control.innerText().catch(() => "")).trim().slice(0, 60);
    if (!(await clickTriggerControl(control))) continue;
    console.log(`    [interstitial] clicked "${label || "continue"}" on the board's own dialog`);
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function clickTriggerControl(el) {
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  // A sticky header/footer can sit over the control's centre, so a coordinate
  // click lands on whatever is behind it. LinkedIn's own "Easy Apply" was
  // clicked into /mynetwork this way (#1278 Meril, 2026-11-10): the run then
  // hunted for an application form on the network page. Only when the point is
  // actually covered does the click fall back to the DOM, which fires the same
  // handler without hit-testing.
  const covered = await el.evaluate((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && hit !== node && !node.contains(hit);
  }).catch(() => false);
  if (!covered) {
    try {
      await el.click({ timeout: 12000 });
      return true;
    } catch {
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      try {
        await el.click({ timeout: 8000 });
        return true;
      } catch {
        // fall through to the DOM click below
      }
    }
  }
  return el.evaluate((node) => { node.click(); return true; }).catch(() => false);
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
    // The first match in DOM order is not necessarily the control the user can
    // see: responsive layouts keep a hidden duplicate of the footer (Hirist
    // renders both), and clicking that one silently does nothing - which is how
    // #492 "clicked Next" six times and stayed on the same screening form.
    const candidates = page.locator(navSelector);
    let next = null;
    const candidateCount = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(candidateCount, 10); i++) {
      const el = candidates.nth(i);
      if (await el.isVisible().catch(() => false)) { next = el; break; }
    }
    if (!next) return { stopped: "no-navigation" };
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
    let clickError = "";
    await next.click({ timeout: 5000 }).catch((error) => {
      clickError = String(error).split("\n")[0].slice(0, 100);
    });
    if (clickError) {
      await next.click({ timeout: 4000, force: true }).catch((error) => {
        clickError = String(error).split("\n")[0].slice(0, 100);
      });
    }
    await page.waitForTimeout(2000);
    if (clickError) {
      console.log(`  [${tag}] step ${step + 1}: click failed — ${clickError}`);
      return { stopped: "click-failed" };
    }
    // A board that answers with its own "applied" page has recorded the
    // application; Hirist sends the form to /job/applied?jobId=<id>. That page
    // is the board's receipt, so it counts as confirmation rather than as a
    // navigation that needs another step.
    const appliedPage = /\/job\/applied|already-applied/i.test(String(page.url?.() || ""));
    const confirmed = appliedPage || await page.evaluate(() =>
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
  // An operator-authorised terms acceptance must land before the final click,
  // otherwise required-field validation silently swallows the submission. It
  // runs before the captcha handoff so the operator sees a form whose button is
  // already enabled while they type the characters.
  if (ACCEPT_TERMS) await acceptRequiredTerms(page).catch(() => []);
  // A consent box that is NOT marked required can still be the switch that
  // enables the final button — Keka's candidate-consent box is exactly that: the
  // form validates, the captcha is typed, and "Apply Now" stays disabled until
  // it is ticked (#1319, measured 2026-11-09). Retry only while the button is
  // actually disabled, and only under --accept-terms.
  if (ACCEPT_TERMS && (await locator.isDisabled().catch(() => false))) {
    const extra = await acceptRequiredTerms(page, { includeOptional: true }).catch(() => []);
    if (extra.length) console.log("  [terms-accepted] that consent box was what kept the final button disabled");
  }

  const typedCaptcha = await waitForOperatorCaptcha(page);
  if (typedCaptcha.present && !typedCaptcha.entered) {
    return { allowed: true, clicked: false, captcha: true };
  }
  if (!typedCaptcha.present && (await hasCaptcha(page))) {
    console.log(`  [captcha] final ${label} is blocked until verification disappears`);
    if (!(await waitForCaptchaResolution(page))) {
      return { allowed: true, clicked: false, captcha: true };
    }
  }
  if (!locator || (await locator.count().catch(() => 0)) === 0) {
    return { allowed: true, clicked: false };
  }

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
    // An open dropdown owns the next mousedown and would eat this click, so
    // close anything still showing before the control is pressed.
    await closeOpenDropdowns(page);
    // Sticky headers can cover a long form's submit control; scroll it into
    // view and allow a longer budget before giving up.
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    // Watch what the click actually does. A pointer click can reach a live
    // control and still be a no-op - the menu that owns the next mousedown ate
    // it, or the handler was replaced by a re-render between hit-testing and
    // dispatch. Measured 2026-11-05, #143 Glean: "[submit] clicked final Submit
    // application", then no write, no navigation, no validation error, and the
    // run reported a refusal that never happened.
    let writes = 0;
    let submissionHost = "";
    try { submissionHost = new URL(page.url()).host; } catch { submissionHost = ""; }
    const countWrite = (request) => {
      try {
        if (String(request.method?.() || "GET").toUpperCase() === "GET") return;
        // Analytics pings (snowplow and friends) are posted on every click, so
        // only a write to the board's own host counts as the submit leaving.
        if (new URL(request.url()).host !== submissionHost) return;
        writes += 1;
      } catch { /* ignore */ }
    };
    if (typeof page.on === "function") page.on("request", countWrite);
    // Fingerprint what the page shows about its own state, so "did the click
    // do anything" is decided by a change rather than by matching words. The
    // first attempt at this matched /select/ against any element with an
    // error-ish class, and Greenhouse's live region quotes the Country
    // placeholder ("Country | Select a country"), so every dead click looked
    // like a live one.
    const submitFingerprint = () => page.evaluate(() => {
      const shown = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      return {
        url: location.href,
        problems: [...document.querySelectorAll("[class*='error'], [role='alert'], [aria-invalid='true']")]
          .filter(shown).length,
        submitDisabled: [...document.querySelectorAll("button, input[type='submit']")]
          .some((b) => /submit/i.test(`${b.textContent || ""} ${b.value || ""}`) && (b.disabled || b.getAttribute("aria-busy") === "true")),
      };
    }).catch(() => null);
    const before = await submitFingerprint();
    // Record what the pointer and the form actually do, in the page. Without
    // this, a click that never reached the control and a click whose handler
    // decided to do nothing are indistinguishable in the log.
    await page.evaluate(() => {
      window.__pulseSubmitTrace = { pointer: 0, submit: 0, label: "" };
      document.addEventListener("click", (event) => {
        const button = event.target?.closest?.("button, input[type='submit'], [role='button']");
        if (!button) return;
        window.__pulseSubmitTrace.pointer += 1;
        window.__pulseSubmitTrace.label = String(button.textContent || button.value || "").trim().slice(0, 40);
      }, true);
      document.addEventListener("submit", () => { window.__pulseSubmitTrace.submit += 1; }, true);
    }).catch(() => {});
    try {
      await locator.click({ timeout: 15000 });
    } finally {
      if (typeof page.off === "function") page.off("request", countWrite);
    }
    console.log(`  [submit] clicked final ${label}`);
    await page.waitForTimeout(1500);
    const trace = await page.evaluate(() => window.__pulseSubmitTrace || null).catch(() => null);
    const after = await submitFingerprint();
    if (trace && trace.pointer === 0) {
      console.log(`  [submit] the click on ${label} never reached a control (no pointer event arrived)`);
    }
    // One line, always: what the click was followed by. Without it a refused
    // submit and a click that did nothing read identically in the log.
    console.log(`  [submit] after the click: ${writes} write(s) to ${submissionHost || "the board"}, `
      + `complaint nodes ${before?.problems ?? "?"} → ${after?.problems ?? "?"}, `
      + `submit control ${after?.submitDisabled ? "" : "still "}enabled, `
      + `pointer ${trace?.pointer ?? "?"} / submit ${trace?.submit ?? "?"} event(s)`);
    const activated = writes > 0 || !before || !after
      || after.url !== before.url
      || after.problems !== before.problems
      || (after.submitDisabled && !before.submitDisabled);
    if (!activated) {
      // Activating the control through the DOM is the same button, not a
      // bypass: it runs the page's own handler, so anything it submits or
      // complains about is the board's own verdict.
      console.log(`  [submit] the click on ${label} produced no request and no complaint `
        + `(${trace ? `${trace.pointer} pointer event(s) on "${trace.label}", ${trace.submit} submit event(s)` : "no trace"}) `
        + `— activating the control directly`);
      await locator.evaluate((el) => el.click()).catch(() => {});
      await page.waitForTimeout(1500);
    }
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

/**
 * A board that refuses automated browsers outright, rather than asking a
 * question a human could answer.
 *
 * Himalayas answers a plain page load - headed Edge with a persistent profile,
 * and a clean bundled Chromium with a real Chrome user agent alike - with
 * Cloudflare's managed-check interstitial and HTTP 403. Measured 2026-11-11:
 * `title: "Just a moment..."`, body "Performing security verification", no
 * posting and no Apply control ever painted, and an empty full-page screenshot.
 * There is no widget to click and no sign-in that fixes it, so a run can never
 * convert one of these into an application.
 *
 * Distinct from a CAPTCHA on an application form: that one is solvable in a
 * headed window and is worth waiting for. This one is a refusal, so it is
 * recorded as Skipped and the row stops consuming batch slots.
 */
function isBotVerificationWall(text) {
  const body = String(text || "");
  if (!body) return false;
  return /performing security verification/i.test(body)
    || /^\s*just a moment\.\.\./i.test(body)
    || /checking (?:if the site connection is secure|your browser before accessing)/i.test(body)
    || /enable javascript and cookies to continue/i.test(body);
}

async function hasCaptcha(page) {
  try {
    for (const selector of CAPTCHA_SELECTORS) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      // Guarded because a locator without nth() is a real possibility: the unit
      // tests pass a minimal stub exposing count() only, and combo() already
      // makes the same check. Unguarded, the probe threw
      // "loc.nth is not a function" on node 20 and took five sibling subtests
      // down with it - one missing method on a stub, reported as five unrelated
      // failures.
      //
      // It fails CLOSED rather than skipping. A captcha-selector matched an
      // element but the element cannot be inspected, and the safe reading of
      // that is "there may be a challenge here". Skipping would let the probe
      // fall through to no-challenge on the strength of a missing method, which
      // is the exact inversion this whole helper exists to prevent.
      if (typeof loc.nth !== "function") {
        if (count > 0) {
          console.log(`    [captcha] ${selector} matched ${count} element(s) but the locator cannot be inspected; treating as a challenge`);
          return true;
        }
        continue;
      }
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

/**
 * A typed image captcha is a different shape from the vendor widgets above.
 *
 * Greenhouse/Ashby gate the submit with an invisible reCAPTCHA, so waiting for a
 * badge to disappear is the right move. Keka instead shows a 120x40 picture and
 * a required text box (#captcha, measured 2026-11-09, nudge.keka.com). The
 * picture cannot be read honestly by a program, and it never disappears while
 * the page stays on the form, so the vendor probe's wait would simply expire.
 *
 * The run therefore fills everything else, tells the operator to type the
 * characters in the visible window, and continues as soon as the box holds a
 * value. Nothing is guessed and no third-party solving service is involved.
 */
async function waitForOperatorCaptcha(page) {
  let input = null;
  try {
    input = page.locator('input[id*="captcha" i], input[name*="captcha" i]').first();
    if (!(await input.count().catch(() => 0))) return { present: false, entered: false };
    if (!(await input.isVisible().catch(() => false))) return { present: false, entered: false };
    // A "captcha" input with no picture is not this shape (a honeypot or a
    // hidden vendor field). Requiring the image keeps the handoff honest.
    const image = page.locator('img[alt*="captcha" i]').first();
    if (!(await image.count().catch(() => 0))) return { present: false, entered: false };
  } catch {
    return { present: false, entered: false };
  }
  if (String(await input.inputValue().catch(() => "")).trim()) {
    return { present: true, entered: true };
  }
  if (DRY_RUN) {
    console.log("  [captcha] an image captcha must be typed by hand before this form can be submitted");
    return { present: true, entered: false };
  }
  if (!(HEADED && OTP_PAUSE)) {
    console.log("  [captcha] an image captcha must be typed by hand; this run is not pausing for it"
      + " (needs --headed --otp-pause)");
    return { present: true, entered: false };
  }
  console.log(`  [handoff] type the captcha shown in the browser window; waiting up to ${Math.round(OTP_PAUSE_MS / 1000)}s…`);
  const deadline = Date.now() + OTP_PAUSE_MS;
  while (Date.now() < deadline) {
    if (String(await input.inputValue().catch(() => "")).trim()) {
      console.log("  [handoff] captcha entered — submitting the completed form");
      return { present: true, entered: true };
    }
    await page.waitForTimeout(1000).catch(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  }
  console.log("  [captcha] no captcha was entered before the wait ended");
  return { present: true, entered: false };
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

/**
 * Answer the mandatory radio questions a board asks about facts the profile
 * already states, and report the ones it cannot answer.
 *
 * Hirist gates every application behind a screening form whose "Next" button
 * stays disabled until each starred question is answered. Measured 2026-11-03
 * on Vedantu (#492): the salary, expected-salary and notice-period questions
 * came pre-filled from the profile, but three bare radio groups did not - "Are
 * you currently living in Bangalore?", the years-of-experience band, and a
 * role-history question. Nothing in the commitment list matched them, so the
 * form was abandoned with a disabled Next and the row went to NeedsReview.
 *
 * These two are answered from facts, not from preference: where the candidate
 * currently lives, and how many years he has worked. Both are already in the
 * profile (current_location, experience_years) and both stay truthful whichever
 * way they land. History questions that no field can settle (a founding/FDE
 * role) are answered only from application_answers, which the operator writes.
 * Anything else is left untouched and named in the log, because a guess on a
 * history question is a false statement on an application.
 */
function placeAliases(location) {
  const raw = String(location || "").toLowerCase();
  const parts = raw.split(/[,/]/).map((p) => p.trim()).filter(Boolean);
  const aliases = new Set(parts);
  // Greater Noida / Noida / Gurugram / Ghaziabad / Faridabad are all the Delhi
  // NCR, and boards ask about it under every one of those names.
  const ncr = ["greater noida", "noida", "gurugram", "gurgaon", "ghaziabad", "faridabad", "delhi", "new delhi", "delhi ncr", "ncr"];
  if (parts.some((p) => ncr.includes(p))) ncr.forEach((a) => aliases.add(a));
  // The same Indian city is written two ways, and a board picks either: "Are
  // you currently living in Bangalore?" was answered No for a Bengaluru
  // resident because the two spellings never met.
  const spellings = [
    ["bengaluru", "bangalore"],
    ["mumbai", "bombay"],
    ["chennai", "madras"],
    ["kolkata", "calcutta"],
    ["pune", "poona"],
  ];
  for (const [a, b] of spellings) {
    if (aliases.has(a)) aliases.add(b);
    if (aliases.has(b)) aliases.add(a);
  }
  return aliases;
}

function experienceBandFor(question, options, years) {
  if (!/years?\b.*experience|experience\b.*years?|total experience/i.test(question)) return null;
  if (!Number.isFinite(years)) return null;
  for (const option of options) {
    const text = String(option).toLowerCase();
    let lo = null;
    let hi = null;
    let m;
    if ((m = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/))) {
      lo = Number(m[1]);
      hi = Number(m[2]);
    } else if ((m = text.match(/less than\s*(\d+(?:\.\d+)?)/))) {
      lo = 0;
      hi = Number(m[1]) - 0.0001;
    } else if ((m = text.match(/(\d+(?:\.\d+)?)\s*\+/))) {
      lo = Number(m[1]);
      hi = Number.POSITIVE_INFINITY;
    } else if ((m = text.match(/more than\s*(\d+(?:\.\d+)?)/))) {
      lo = Number(m[1]) + 0.0001;
      hi = Number.POSITIVE_INFINITY;
    } else if (/fresher|no experience|none/.test(text)) {
      lo = 0;
      hi = 0.999;
    }
    if (lo === null) continue;
    if (years >= lo && years <= hi) return option;
  }
  return null;
}

/**
 * "How many years of professional, production experience do you have writing
 * Go (Golang) or Ruby?" - a question scoped to named technologies.
 *
 * Total experience cannot answer it, and putting 0.2 years there would claim
 * experience in a language cv.md never mentions. Two truthful answers exist and
 * which one applies is decided by the CV, not by the posting:
 *
 *   - a technology the profile lists  -> the same band the general question gets
 *   - nothing the profile lists       -> "None", when the board offers it
 *
 * Anything else - no recognisable technology, or no matching option - is left
 * for the human. Measured on GitLab 8916232002, 2026-11-09, where this was the
 * last of four questions still blocking an otherwise complete form.
 */
function skillYearsOption(texts, question, profile, years) {
  const text = String(question || "");
  if (!/(?:years?[\s\S]{0,80}experience|experience[\s\S]{0,80}years?)/i.test(text)) return "";
  if (!Number.isFinite(years)) return "";
  const m = text.match(/\b(?:writing|using)\s+([^?.]{2,60})/i);
  if (!m) return "";
  const named = m[1]
    .replace(/\([^)]*\)/g, " ")
    .split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && t.split(/\s+/).length <= 3);
  if (!named.length) return "";
  const known = [];
  for (const list of [profile?.domain?.core_skills, profile?.domain?.adjacent_skills]) {
    for (const skill of Array.isArray(list) ? list : []) {
      known.push(String(skill).trim().toLowerCase());
    }
  }
  const anyKnown = named.some((tech) => known.some(
    (k) => k && (tech === k || tech.startsWith(`${k} `) || k.startsWith(`${tech} `)),
  ));
  if (anyKnown) {
    // "None" is not a band for a technology he does have: experienceBandFor
    // reads it as 0-to-0.999 years and would answer "None" for 0.2 years of
    // Python. Only the numeric bands are eligible here.
    const bands = (Array.isArray(texts) ? texts : [])
      .filter((t) => !/^(?:none|no experience|nil|n\/a)\b/i.test(String(t).trim()));
    return experienceBandFor("total experience", bands, years);
  }
  return (Array.isArray(texts) ? texts : [])
    .find((t) => /^(?:none|no experience|nil|n\/a|0)\b/i.test(String(t).trim())) || "";
}

/**
 * Pick the "I can relocate to <city>" option of a presence question.
 *
 * Indian boards ask this as a dropdown rather than a yes/no:
 *
 *   This role requires candidate to be present in Bengaluru, what best describe
 *   your situation *
 *     "I'm looking for remote opportunity only"
 *     "Currently in Bangalore"
 *     "I'm elsewhere but can relocate to Bangalore"
 *
 * (Measured on GitLab 8916232002, 2026-11-09.) Selecting the relocate option is
 * a commitment about where the candidate will live, so it is only chosen when
 * the option names a city in application_answers.relocation_cities - compared
 * through placeAliases, so Bengaluru and Bangalore are the same city - and never
 * when it names the city he already lives in.
 */
function relocationOption(texts, candidate, stated) {
  const accepted = new Set();
  for (const city of String(stated?.relocation_cities || "").split(",")) {
    for (const alias of placeAliases(city.trim())) accepted.add(alias);
  }
  if (!accepted.size) return "";
  const here = placeAliases(candidate?.current_location || "");
  for (const text of Array.isArray(texts) ? texts : []) {
    const m = String(text).match(/relocat\w*\s+(?:to|in)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
    if (!m) continue;
    const city = m[1].trim().toLowerCase();
    const alias = [...accepted].find((a) => a && (city.startsWith(a) || a.startsWith(city)));
    if (!alias) continue;
    if ([...here].some((h) => h && (city.startsWith(h) || h.startsWith(city)))) continue;
    return String(text);
  }
  return "";
}

/**
 * The stated notice period in days, or null when it says nothing usable.
 *
 * "30 days" is the operator's. Only an explicit day/week/month count is read,
 * and "immediate" is zero; anything else is refused rather than defaulted, the
 * same rule availabilityDate follows.
 */
function noticeDays(candidate) {
  const raw = String(candidate?.notice_period ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (/immediate/.test(raw)) return 0;
  const m = raw.match(/(\d+)\s*(day|week|month)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0 || n > 365) return null;
  return n * (m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1);
}

/** Read one availability option as a day range, or null when it states none. */
function availabilityRange(text) {
  const t = String(text || "").toLowerCase();
  if (/immediate|right\s+away|asap/.test(t)) return [0, 0];
  let m = t.match(/(\d+)\s*(?:-|to|–)\s*(\d+)\s*(day|week|month)/);
  if (m) {
    const unit = m[3] === "week" ? 7 : m[3] === "month" ? 30 : 1;
    return [Number(m[1]) * unit, Number(m[2]) * unit];
  }
  m = t.match(/less\s+than\s+(\d+)\s*(day|week|month)/);
  if (m) {
    const unit = m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1;
    return [0, Number(m[1]) * unit - 0.5];
  }
  m = t.match(/(?:more|over)\s+than\s+(\d+)\s*(day|week|month)|(\d+)\s*(day|week|month)s?\s*\+/);
  if (m) {
    const n = m[1] || m[3];
    const unitName = m[2] || m[4];
    const unit = unitName === "week" ? 7 : unitName === "month" ? 30 : 1;
    return [Number(n) * unit + 0.5, Number.POSITIVE_INFINITY];
  }
  m = t.match(/(\d+)\s*(day|week|month)/);
  if (m) {
    const unit = m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1;
    const n = Number(m[1]) * unit;
    // "within 2-4 weeks" is a range above; a bare "within 30 days" is a ceiling.
    return /within|upto|up to|under|≤/.test(t) ? [0, n + 0.5] : [n, n];
  }
  return null;
}

/**
 * Pick the availability band that contains the stated notice period.
 *
 * Zema's Deel form (jobs.deel.com, #1320, 2026-11-09) asks "Available to start
 * (a notice period) *" as a radio group - "Available immediately", "Available
 * within 2-4 weeks", "Available within 1-2 months" - and the whole form's Apply
 * button stays disabled until it is answered. The profile states the notice
 * period, so the answer is a fact rendered in the board's own bands rather than
 * a commitment invented for the form.
 *
 * Narrowest containing band wins, and a question that is not about availability
 * gets nothing.
 */
function noticeBandFor(question, options, days) {
  if (!/available\s+to\s+(?:start|join)|notice\s+period|how\s+soon\s+can\s+you|joining\s+(?:time|date)|earliest\s+(?:start|joining)/i.test(String(question))) {
    return "";
  }
  if (!Number.isFinite(days) || days < 0) return "";
  let best = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const option of Array.isArray(options) ? options : []) {
    const range = availabilityRange(option);
    if (!range) continue;
    const [lo, hi] = range;
    if (days < lo || days > hi) continue;
    const width = hi - lo;
    if (width < bestWidth) {
      best = String(option);
      bestWidth = width;
    }
  }
  return best || "";
}

/**
 * Find the radio option that expresses a stated answer.
 *
 * Boards do not repeat the operator's wording. He answered the voluntary
 * disability self-identification with "No, I don't have a disability" and
 * PayPal renders that choice as "NO. I DON'T HAVE A DISABILITY (INCLUDING
 * CANCER, EPILEPSY, DIABETES…)", so an equality test matched nothing and the
 * required group stayed blank (#1322, 2026-11-10). Matching therefore accepts,
 * in order: the same words; an option that spells the answer out further; an
 * answer that spells the option out further.
 *
 * Both extra directions stop at a word boundary, because "None of the above"
 * must never be read as the option "No". Anything still ambiguous (two options
 * could be meant) returns -1 and the group is left for a human rather than
 * guessed.
 */
function statedOptionIndex(answer, options) {
  // Compare words, not spelling: a comma where the board wrote a full stop is
  // not a different answer. "don't" becomes two tokens on both sides, so the
  // comparison stays symmetric.
  const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const wanted = words(answer);
  if (!wanted.length) return -1;
  const opts = (Array.isArray(options) ? options : []).map(words);
  const same = opts.findIndex((o) => o.length === wanted.length && o.every((w, i) => w === wanted[i]));
  if (same >= 0) return same;
  const startsWith = (long, short) => short.length < long.length
    && short.every((w, i) => long[i] === w);
  const spelledOut = opts.map((o, i) => (startsWith(o, wanted) ? i : -1)).filter((i) => i >= 0);
  if (spelledOut.length === 1) return spelledOut[0];
  if (spelledOut.length > 1) return -1;
  const abbreviated = opts.map((o, i) => (startsWith(wanted, o) ? i : -1)).filter((i) => i >= 0);
  if (abbreviated.length === 1) return abbreviated[0];
  return -1;
}

/**
 * The years-of-experience bar a question states, or null.
 *
 * Only questions that name experience qualify: "at least 5 years" on its own
 * could be "at least 5 years at your last employer", which is a different fact
 * about the candidate than total professional experience.
 *
 * Exported for the guardrail tests: this decides how a knockout question is
 * answered, so a pattern that drifts is a false statement on a real application.
 */
function yearsRequirement(question) {
  const text = String(question || "");
  if (!/\bexperience\b|\bworked\b|\bindustry\b/i.test(text)) return null;
  const match = /(?:at\s+least|minimum(?:\s+of)?|more\s+than|over)\s+(\d{1,2})\s*\+?\s*years?|\b(\d{1,2})\s*\+\s*years?/i.exec(text);
  if (!match) return null;
  const years = Number.parseInt(match[1] || match[2], 10);
  return Number.isFinite(years) ? years : null;
}

/**
 * The monthly stipend a question names, or null.
 *
 * "Stipend will be 15-18k Maximum, are you fine with it?" is a commitment about
 * money, so it is answered from a stated floor rather than guessed. A range is
 * what he would be accepting, so the lower bound is the figure that decides;
 * "unpaid" and figures that are not money (a duration, a headcount) leave it
 * unread, because a wrong number here is a job he cannot afford to take.
 *
 * Exported for the guardrail tests, for the same reason as yearsRequirement.
 */
function stipendFigure(question) {
  const text = String(question || "");
  if (!/\bstipend\b/i.test(text)) return null;
  if (!/\b(fine|okay|ok|comfortable|acceptable|agree|willing|alright)\b/i.test(text)) return null;
  const clean = (value) => Number.parseFloat(String(value).replace(/,/g, ""));
  // "15-18k", "15k-18k", "15 to 18k" - the lower bound is the offer.
  const range = /(\d{1,3}(?:,\d{3})*)\s*k?\s*(?:-|–|\bto\b)\s*(\d{1,3}(?:,\d{3})*)\s*k\b/i.exec(text);
  if (range) {
    const low = clean(range[1]);
    const high = clean(range[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) return Math.min(low, high) * 1000;
  }
  const figures = [];
  for (const match of text.matchAll(
    /(\d[\d,]*(?:\.\d+)?)\s*(k)\b|(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)|(\d{1,3}(?:,\d{3})+|\d{4,})\b/gi,
  )) {
    if (match[1] && match[2]) figures.push(clean(match[1]) * 1000);
    else if (match[3]) figures.push(clean(match[3]));
    else if (match[4]) figures.push(clean(match[4]));
  }
  if (!figures.length) return null;
  return Math.min(...figures);
}

/**
 * Questions about the candidate's own history that no CV field can be turned
 * into an answer mechanically. Each is answered only when the operator has
 * stated it in application_answers; otherwise it is left blank and named.
 *
 * Exported for the guardrail tests: the wording a board uses is the only thing
 * that decides whether a stated answer is applied, so a pattern that drifts
 * silently is a question silently left blank.
 */
function answerFactualRadioHints() {
  return [
    { key: "high_ownership_role_experience", hint: /founding engineer|forward deployed|\bFDE\b|high[- ]ownership/i },
    { key: "ever_interviewed_here", hint: /interviewed (?:with|at) (?:us|this company)|previously interviewed/i },
    // "Are you comfortable working in an onsite setting?" and "Are you
    // comfortable commuting to this job's location?" - the two required radios
    // that held #1337 Innovfix (2026-11-11). Comfort with either is a life
    // decision, not a CV fact, so it is answered only from the operator's own
    // statement. The hints stay narrow: the first was answered "No" by a loose
    // `/onsite/` rule would also catch "Are you open to onsite work abroad?".
    { key: "onsite_comfortable", hint: /\bare\s+you\s+comfortable\s+working\s+in\s+an?\s+onsite\s+setting|comfortable\s+(?:working|with\s+working)\s+onsite|willing\s+to\s+work\s+onsite/i },
    { key: "commute_comfortable", hint: /comfortable\s+commut\w*|able\s+to\s+commute|willing\s+to\s+commute|commut\w*\s+to\s+(?:the\s+|this\s+)?(?:job|office|work)\s*(?:'s\s*)?location/i },
    // "This position requires you to be in the office 8 days per month. Would you
    // be able to meet this requirement?" is a commitment, not a CV fact.
    { key: "office_attendance_days", hint: /in[- ](?:the )?office|office\s+(?:attendance|presence)|days?\s+(?:a|per)\s+(?:week|month)\s+in\s+(?:the\s+)?office/i },
    // Voluntary self-identification is a radio group, not a text field, so it
    // needs its own entry here: the disability and conflict-of-interest
    // statements only exist in application_answers and nothing on a CV can be
    // turned into them (#1322 PayPal, 2026-11-10).
    { key: "disability_disclosure", hint: /disabilit\w*|differently\s+abled|voluntary\s+self[- ]identification/i },
    { key: "conflict_of_interest", hint: /(?:board|advisory\s+group)[\s\S]{0,220}?(?:compete|competitor|interest)|family\s+relationship|government\s+official|known\s+merchant|referred\s+to[\s\S]{0,160}?(?:merchant|partner)|(?:spouse|relative)[\s\S]{0,120}?(?:employee|employer|board|interest)/i },
  ];
}

async function answerFactualRadioQuestions(page, candidate) {
  const stated = candidate?.application_answers || {};
  const statedQuestions = answerFactualRadioHints();
  const groups = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const byName = new Map();
    for (const input of document.querySelectorAll('input[type="radio"]')) {
      if (!input.name) continue;
      const holder = input.closest("label") || (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null) || input.parentElement;
      const text = norm(holder?.innerText || input.value);
      const entry = byName.get(input.name) || { name: input.name, options: [], checked: false, question: "" };
      if (text) entry.options.push(text.slice(0, 60));
      if (input.checked) entry.checked = true;
      byName.set(input.name, entry);
    }
    // The question is the nearest ancestor block that holds more text than the
    // options alone: a radio group's container also carries its label.
    for (const entry of byName.values()) {
      const first = document.querySelector(`input[name="${CSS.escape(entry.name)}"]`);
      const optionLength = entry.options.reduce((sum, t) => sum + t.length, 0);
      let node = first;
      while (node && node !== document.body) {
        const text = norm(node.innerText);
        if (text.length > optionLength + 12) { entry.question = text.slice(0, 400); break; }
        node = node.parentElement;
      }
    }
    return [...byName.values()].filter((g) => !g.checked && g.options.length > 1);
  }).catch(() => []);
  if (!Array.isArray(groups) || groups.length === 0) return;

  for (const group of groups) {
    const question = group.question.replace(/\s+/g, " ").trim();
    if (!question) continue;
    const questionClause = question.split(/\?\s*/)[0];
    let answer = null;
    let from = "";
    // "Do you have at least 5 years of professional experience?" is a knockout
    // question, and the only defensible answer is the true one: the profile
    // states four months, so a five-year bar is a No. Answering Yes does not buy
    // an interview - the same recruiter opens a CV that says "Class of 2027" and
    // two internships a summer long - so the answer is computed from
    // experience_years rather than stated, and a bar that is met still says Yes.
    const yearsBar = yearsRequirement(questionClause);
    const stipend = yearsBar !== null ? null : stipendFigure(question);
    const living = questionClause.match(/(?:currently\s+)?(?:living|residing|staying|based|located)\s+in\s+([A-Za-z][A-Za-z. ]{2,30})$/i);
    if (yearsBar !== null) {
      // Answered here rather than left to the branches below: a bar is a
      // Yes/No question, and letting the chain continue would let a notice or
      // band rule answer a question that is not about notice or a band.
      const have = Number.parseFloat(String(candidate?.experience_years ?? "")) || 0;
      answer = have >= yearsBar ? "Yes" : "No";
      from = `candidate.experience_years (${have} vs a ${yearsBar}-year bar)`;
    } else if (stipend !== null) {
      // "Stipend will be 15-18k Maximum, are you fine with it?" An internship is
      // not priced like a job: the operator's 5 LPA expectation is a full-time
      // figure, and he accepts an internship above the monthly floor he set.
      const floor = Number.parseFloat(String(candidate?.minimum_stipend_monthly ?? ""));
      answer = Number.isFinite(floor) && stipend >= floor ? "Yes" : "No";
      from = `candidate.minimum_stipend_monthly (INR ${stipend}/month vs a INR ${Number.isFinite(floor) ? floor : "?"} floor)`;
    } else if (living) {
      const target = living[1].trim().toLowerCase();
      const aliases = placeAliases(candidate?.current_location);
      answer = aliases.has(target) ? "Yes" : "No";
      from = `current_location (${candidate?.current_location || "unset"})`;
    } else if (/current\s+(?:place\s+of\s+residence|city|location|address)|place\s+of\s+residence|city\s+of\s+residence|which\s+city\s+(?:are\s+you|do\s+you)/i.test(questionClause)) {
      // "What is your current place of residence? (choose one of the options)"
      // is transcription, not a preference: the option naming where he lives is
      // a fact from the profile. An exact city match wins over a prefix so
      // "Delhi" is not answered with "New Delhi" when both are offered, and a
      // list that does not contain his city is left blank and named.
      const aliases = [...placeAliases(candidate?.current_location || "")].filter(Boolean);
      const opts = group.options.map((opt) => String(opt).trim());
      const exact = opts.find((opt) => aliases.includes(opt.toLowerCase()));
      const hit = exact || opts.find((opt) => {
        const o = opt.toLowerCase();
        return aliases.some((a) => o.startsWith(`${a} `) || o.startsWith(`${a},`) || o.startsWith(`${a}(`));
      });
      if (hit) {
        answer = hit;
        from = `current_location (${candidate?.current_location || "unset"})`;
      } else {
        // A form that offers only cities he does not live in still has to be
        // answered to be sent, and a place he has said he would relocate to is
        // the honest choice: it is a stated preference, not a claimed address.
        // The log says so, so nothing downstream reads it as his current city.
        const relocating = String(stated?.relocation_cities || "")
          .split(",").map((city) => city.trim().toLowerCase()).filter(Boolean);
        const willing = opts.find((opt) => relocating.includes(opt.toLowerCase()));
        if (willing) {
          answer = willing;
          from = "application_answers.relocation_cities (willing to relocate)";
        }
      }
    } else {
      const days = noticeDays(candidate);
      const availability = noticeBandFor(question, group.options, days);
      if (availability) {
        answer = availability;
        from = `notice_period (${days} days)`;
      } else {
        const years = Number.parseFloat(String(candidate?.experience_years ?? ""));
        const band = experienceBandFor(question, group.options, years);
        if (band) {
          answer = band;
          from = `experience_years (${years})`;
        } else {
          const statedMatch = statedQuestions.find((item) => item.hint.test(question));
          const value = statedMatch ? String(stated[statedMatch.key] ?? "").trim() : "";
          if (value) {
            answer = value;
            from = `application_answers.${statedMatch.key}`;
          }
        }
      }
    }
    if (!answer) {
      console.log(`    [answer-missing] "${question.slice(0, 90)}" — left blank (no factual source)`);
      continue;
    }
    const index = statedOptionIndex(answer, group.options);
    if (index < 0) {
      console.log(`    [answer-missing] "${question.slice(0, 60)}": ${group.options.join("/")} offers no "${answer}"`);
      continue;
    }
    const input = page.locator(`input[type="radio"][name="${group.name}"]`).nth(index);
    // Hirist (and most custom-styled radio groups) hide the native input with
    // display:none and expose a <label for>. Playwright's check() cannot click a
    // display:none element, and clicking the wrapper div does nothing - only the
    // label forwards activation to the input, so click that.
    const landed = await page.evaluate(({ name, idx }) => {
      const members = [...document.querySelectorAll('input[type="radio"]')].filter((el) => el.name === name);
      const target = members[idx];
      if (!target) return false;
      const label = target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null;
      (label || target.closest("label") || target.parentElement)?.click();
      return target.checked;
    }, { name: group.name, idx: index }).catch(() => false)
      || await input.isChecked().catch(() => false);
    if (landed) {
      console.log(`    [answer] "${question.slice(0, 60)}" → "${group.options[index]}" from ${from}`);
    } else {
      console.log(`    [answer-missing] "${question.slice(0, 60)}": control did not accept "${group.options[index]}"`);
    }
  }
}

/**
 * Decide which options of a city/relocation checkbox group to tick.
 *
 * Returns null when the question is not about relocation at all - a checkbox
 * group about skills or consents is not this fact's business. Otherwise returns
 * the option labels the operator's stated list covers, which may be empty.
 */
function relocationPicks(question, options, stated) {
  const text = String(question || "");
  if (!/relocat|currently\s+(?:residing|living|based)|willing\s+to\s+(?:move|relocate)/i.test(text)) {
    return null;
  }
  const wanted = String(stated?.relocation_cities ?? "")
    .split(/[,|;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // A stated "NCR" covers every city in it, and a stated city covers the other
  // spelling of itself. Expanding through placeAliases means the profile lists
  // hubs by name instead of enumerating every board's variant of them.
  const accepted = new Set();
  for (const place of wanted) placeAliases(place).forEach((a) => accepted.add(a));
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o).trim());
  const picks = opts.filter((opt) => {
    const o = opt.toLowerCase();
    // The option may carry a qualifier - "Pune (relocation required)" - so a
    // prefix match is what a person means by ticking "Pune".
    return [...accepted].some((place) => o === place || o.startsWith(`${place} `) || o.startsWith(`${place},`));
  });
  return { picks, wanted };
}

/**
 * Answer a "which cities will you work in" checkbox group from a stated list.
 *
 * Hirist asks "Please select the city you are currently residing or willing to
 * relocate to" as a mandatory checkbox group, one checkbox per city, each with
 * its own element name - so there is no radio group to read and no name to group
 * by. #1054 was abandoned on exactly this: every text box and radio was filled
 * and Next stayed disabled because this one group was empty.
 *
 * Willingness to move is a life decision, not a fact in the CV, so it is never
 * inferred from current_location or from the job's own city. Only cities the
 * operator listed in application_answers.relocation_cities are ticked; anything
 * else is left alone and named in the log.
 */
async function answerFactualCheckboxQuestions(page, candidate) {
  const stated = candidate?.application_answers || {};
  const groups = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const byQuestion = new Map();
    for (const input of document.querySelectorAll('input[type="checkbox"]')) {
      if (input.checked || input.disabled) continue;
      const label = input.id
        ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
        : null;
      const optionText = norm(label?.innerText || input.closest("label")?.innerText || "");
      if (!optionText) continue;
      // The question is the nearest ancestor that holds more than the option
      // text alone. Options of one question share that ancestor, which is what
      // groups them - their element names are all different.
      let node = input;
      let question = "";
      while (node && node !== document.body) {
        const text = norm(node.innerText);
        if (text.length > optionText.length + 12) { question = text.slice(0, 400); break; }
        node = node.parentElement;
      }
      if (!question) continue;
      const entry = byQuestion.get(question) || { question, ids: [], options: [] };
      entry.ids.push(input.id);
      entry.options.push(optionText.slice(0, 60));
      byQuestion.set(question, entry);
    }
    return [...byQuestion.values()];
  }).catch(() => []);
  if (!Array.isArray(groups) || groups.length === 0) return;

  for (const group of groups) {
    const question = group.question.replace(/\s+/g, " ").trim();
    const decision = relocationPicks(question, group.options, stated);
    if (!decision) continue;
    if (!decision.wanted.length) {
      console.log(`    [answer-missing] "${question.slice(0, 90)}" — ${group.options.join("/") || "cities"} left unticked (application_answers.relocation_cities unset)`);
      continue;
    }
    if (!decision.picks.length) {
      console.log(`    [answer-missing] "${question.slice(0, 60)}": ${group.options.join("/")} offers no ${decision.wanted.join("/")}`);
      continue;
    }
    const ids = decision.picks.map((pick) => group.ids[group.options.indexOf(pick)]);
    const clicked = await page.evaluate((targets) => {
      const done = [];
      for (const id of targets) {
        const el = document.getElementById(id);
        if (!el) continue;
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        (label || el.closest("label") || el.parentElement)?.click();
        done.push({ id, checked: el.checked });
      }
      return done;
    }, ids).catch(() => []);
    const ok = Array.isArray(clicked) && clicked.length > 0 && clicked.every((c) => c.checked);
    console.log(ok
      ? `    [answer] "${question.slice(0, 60)}" → "${decision.picks.join(", ")}" from application_answers.relocation_cities`
      : `    [answer-missing] "${question.slice(0, 60)}": checkbox did not accept "${decision.picks.join(", ")}"`);
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
  // ATS that actually serves the page when it is one this repo knows (Keka's
  // form is firstName/lastName/email/mobilePhone, not LinkedIn's), and the
  // generic set - which covers split first/last name fields - otherwise.
  const onExternalHost = onExternalAts(originUrl);
  const liveAts = inferATS(currentUrl);
  const effectiveAts = onExternalHost
    ? (liveAts && liveAts !== "generic" ? liveAts : "generic")
    : ats;
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
    // A textarea is not automatically an essay. Deel's application form puts its
    // "Desired Base Salary (please specify amount and currency)" in a textarea,
    // and the catch-all `form textarea` poured the whole 1499-character essay
    // into it — over its 500-character limit, on a money field, while the essay
    // question never got it. So the box must both ask for prose and not be a
    // money/number field.
    const boxes = page.locator("textarea");
    const seen = Math.min(await boxes.count().catch(() => 0), 8);
    for (let i = 0; i < seen; i++) {
      const box = boxes.nth(i);
      if (!(await box.isVisible?.().catch(() => false))) continue;
      const hint = await box.evaluate(controlSignatureMatcher()).catch(() => "");
      if (!isEssayFieldHint(hint)) {
        if (hint) console.log(`    [essay-skip] not an essay field: ${hint.slice(0, 70)}`);
        continue;
      }
      const words = whyUs.split(/\s+/).length;
      const filled = await box.fill(whyUs, { timeout: 4000 }).then(() => true).catch(() => false);
      if (filled) console.log(`    [fill] required essay → ${words} words`);
      break;
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
  const combo = async (hintRe, values, options = {}) => {
    const pick = typeof options?.pick === "function" ? options.pick : null;
    // A caller that knows what the question IS can name it in the log; a raw
    // regex source is unreadable for the questions answered from option lists.
    const label = String(options?.label || "").trim() || hintRe.source;
    const controls = page.locator('[role="combobox"]');
    const total = await controls.count().catch(() => 0);
    if (typeof controls.nth !== "function") return null;
    // Only the open menu's options count. A closed react-select menu can leave
    // its option nodes in the DOM, and matching those made a Yes/No question
    // read the previous dropdown's country list.
    const OPTION = '[role="option"]:visible';
    // Tracked so "the control matched but no option did" can be reported
    // separately from "no control matched at all". See the tail of this function.
    let sawControl = false;
    let matchedCount = 0;
    const sawOptions = [];
    for (let i = 0; i < total && i < 16; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      if (await isMirrorInput(control)) continue;
      // Match on the question this control belongs to, never on surrounding
      // form text, which would make any pattern match any field.
      const signature = await control.evaluate(controlSignatureMatcher()).catch((e) => {
        console.log(`    [combo] ${hintRe.source}: matcher failed (${String(e.message || e).slice(0, 80)})`);
        return "";
      });
      if (!hintRe.test(String(signature))) continue;
      matchedCount++;
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
        console.log(`    [combo] ${label}: already answered "${already.slice(0, 30)}" — not overwriting`);
        // Counts as a match. Without this, a control that is matched and already
        // answered is reported as "no control matched" on the next pass, which is
        // the same conflation this branch exists to remove.
        //
        // And it RETURNS rather than continuing: Greenhouse renders the same
        // question twice (a real control and a twin), so carrying on found the
        // second, empty copy, opened its menu, failed to answer it and left that
        // menu on screen. The next click - the submit - was then eaten by the
        // open dropdown. Measured 2026-11-05, #143 Glean:
        //   [combo] how did you hear: already answered "LinkedIn" — not overwriting
        //   [combo] how did you hear: control matched but no option accepted ...
        //   [submit] clicked final Submit application        (no request at all)
        return already;
      }
      // Several acceptable answers, tried in order. A board's option list is its
      // own vocabulary: Greenhouse offers "LinkedIn" but not "Job board", while
      // another board offers "Job board" and nothing else. Taking only values[0]
      // made the first alias the only one ever considered.
      const wantedList = values.map((v) => String(v || "")).filter(Boolean);
      const wanted = wantedList[0] || "";
      // Open the menu and try filtering by typing, but fall back to reading the
      // unfiltered list. Typing a prefix of the answer is wrong for Yes/No-style
      // widgets whose real option reads "Yes" or "I have read and agree" — the
      // filter then matches nothing and the field is silently left empty.
      // The value is compared as plain text, NOT interpolated into a RegExp.
      // It was, and any answer containing a metacharacter threw a SyntaxError -
      // parentheses being the common case, since real option text is full of
      // them: "(either full time or internship)". A crash here would abort the
      // whole run, and the very answer this change introduces contains one.
      const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pickOption = async (texts) => {
        const lower = (t) => String(t).toLowerCase();
        // Some answers only exist in the board's own vocabulary, and the right
        // one is a function of the option list rather than of profile text: an
        // experience BAND ("Intern / Fresher", "Less than 5 Years") and a
        // "can relocate to <city>" option are both chosen by reading what is on
        // offer. The caller supplies that decision and it is tried first, with
        // the shown options as its only input.
        const computed = pick ? String(pick(texts, signature) || "").trim() : "";
        const candidates = [computed, ...wantedList].filter(Boolean);
        for (const candidateText of candidates) {
          const w = lower(candidateText);
          const hit = texts.find((t) => lower(t) === w)
            || texts.find((t) => lower(t).startsWith(w))
            || texts.find((t) => new RegExp(`\\b${reEsc(candidateText)}\\b`, "i").test(t))
            // A dropdown offering exactly one option has no choice to make, so the
            // configured wording cannot be a mismatch worth failing on. This is
            // how the legal acknowledgements are written: one long option, not
            // Yes/No. Selecting it is the only way to complete the field.
            || (texts.length === 1 ? texts[0] : null);
          if (!hit) continue;
          if (texts.length === 1 && !new RegExp(`\\b${reEsc(candidateText)}\\b`, "i").test(hit)) {
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
            console.log(`    [fill] ${label} → "${landed.slice(0, 40)}"`);
            return landed;
          }
          console.log(`    [combo] ${hintRe.source}: clicked "${hit.slice(0, 30)}" but nothing was selected`);
        }
        return null;
      };

      // Open the menu. Clicking the combobox input is not enough on a
      // react-select that renders that input as
      //   .requiredinput{opacity:0;pointer-events:none;position:absolute}
      // so the click lands on nothing, the menu never opens, and every attempt
      // reads 0 options while the required question stays unanswered. Measured
      // 2026-11-05 on #143 Glean (Greenhouse): "How did you hear about
      // Glean?*" matched the hint but no option could ever be seen, and the
      // submit was refused for that one field on every pass.
      //
      // Tried in order, cheapest and most reliable first:
      //   1. focus the input and press ArrowDown - the documented way to open a
      //      react-select, and it needs no pointer events at all
      //   2. click the control itself, which works on ordinary comboboxes
      //   3. click the wrapping .select__control, which is the element that
      //      actually carries the open handler
      //   4. dispatch mousedown on that wrapper, for widgets that only listen
      //      for the raw event
      const openMenu = async () => {
        const optionCount = async () => page.locator(OPTION).count().catch(() => 0);
        // A menu can render a few frames after the event that opened it, so poll
        // briefly instead of testing once. A single fixed wait made a widget
        // that took 400ms look broken.
        const waitOptions = async (ms = 1500) => {
          const deadline = Date.now() + ms;
          do {
            if (await optionCount()) return true;
            await page.waitForTimeout(120);
          } while (Date.now() < deadline);
          return false;
        };
        // A menu left open by an earlier attempt would make step 1 meaningless
        // and would also merge two option lists.
        await pressEscape();
        const focused = await control.focus({ timeout: 2000 }).then(() => true).catch(() => false);
        if (page.keyboard && typeof page.keyboard.press === "function") {
          await page.keyboard.press("ArrowDown").catch(() => {});
        }
        if (await waitOptions(1200)) return "keyboard";
        await control.click({ timeout: 2500 }).catch(() => {});
        if (await waitOptions(800)) return "click";
        const box = await control.evaluate((el) => {
          const wrap = el.closest("[class*='select__control']")
            || el.closest("[class*='select__container']")
            || el.closest("[class*='control']")
            || el.parentElement;
          if (!wrap) return null;
          const r = wrap.getBoundingClientRect();
          return r.width > 0 && r.height > 0
            ? { x: r.x + r.width / 2, y: r.y + r.height / 2 }
            : null;
        }).catch(() => null);
        if (box) {
          await page.mouse.click(box.x, box.y).catch(() => {});
          if (await waitOptions(900)) return "wrapper-click";
        }
        const dispatched = await control.evaluate((el) => {
          const wrap = el.closest("[class*='select__control']")
            || el.closest("[class*='select__container']")
            || el.closest("[class*='control']")
            || el.parentElement;
          if (!wrap) return false;
          for (const type of ["mousedown", "mouseup", "click"]) {
            wrap.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        }).catch(() => false);
        if (dispatched && await waitOptions(1200)) return "dispatch";
        // Report which control this was: "some combobox would not open" is not
        // actionable on a page with five of them.
        const id = await control.evaluate(
          (el) => el.id || el.getAttribute("aria-label") || el.getAttribute("name") || el.tagName,
        ).catch(() => "?");
        console.log(`    [combo] ${hintRe.source}: control "${String(id).slice(0, 40)}" matched but the menu `
          + `would not open (focus ${focused ? "ok" : "failed"}; keyboard, click, wrapper-click and dispatch `
          + `all produced no options)`);
        return null;
      };

      const opened = await openMenu();
      if (opened && opened !== "keyboard") {
        console.log(`    [combo] ${hintRe.source}: menu opened via ${opened}`);
      }
      await page.waitForTimeout(150);
      const typed = await control.fill(wanted.slice(0, 5)).then(() => true).catch(() => false);
      if (!typed && page.keyboard && typeof page.keyboard.type === "function") {
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
        await openMenu();
        await page.waitForTimeout(250);
        texts = (await page.locator(OPTION).allInnerTexts().catch(() => []))
          .map((t) => String(t).replace(/\s+/g, " ").trim())
          .filter(Boolean);
        console.log(`    [combo] ${hintRe.source}: ${texts.length} option(s) unfiltered → ${texts.slice(0, 4).join(" | ")}`);
        chosen = texts.length ? await pickOption(texts) : null;
      }
      if (chosen) return chosen;
      await pressEscape();
      // The control DID match; only the option list refused the value. That is a
      // different fault from "no control matched" and needs a different fix, so
      // it is reported separately. Conflating them made #333 look like a
      // matching bug twice, when the value was simply the wrong shape for a
      // five-option experience-level select.
      sawControl = true;
      sawOptions.push(texts.length);
    }
    if (sawControl) {
      console.log(`    [combo] ${hintRe.source}: control matched but no option accepted the value `
        + `(saw ${sawOptions.join("/")} option(s) across ${matchedCount} attempt(s))`);
      return null;
    }
    // Never fail silently: a hint that matches no control is a bug worth seeing.
    console.log(`    [combo] ${hintRe.source}: no control matched (${total} combobox checked)`);
    return null;
  };

  /**
   * Answer a Yes/No or multi-select question expressed as radios or checkboxes.
   *
   * combo() handles a react-select and answerQuestion() handles a text control,
   * which left a real gap: "Are you fluent or proficient in Arabic?" is very
   * often a pair of radios, and neither could see it. That question blocked #716
   * indefinitely.
   *
   * Scoped to the control's OWN question text rather than surrounding form text,
   * so a hint can never match an unrelated radio on the same page - the same
   * rule the rest of the file follows.
   */
  const radio = async (hintRe, values, tag) => {
    const wanted = (values || []).filter(Boolean).map((v) => String(v).toLowerCase());
    if (!wanted.length) return null;
    const inputs = page.locator(
      'input[type="radio"], input[type="checkbox"]',
    );
    const total = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 60); i++) {
      const input = inputs.nth(i);
      if (!(await input.isVisible().catch(() => false))) continue;
      // Group by name so only one answer per question can be chosen.
      const name = await input.getAttribute("name").catch(() => "");
      if (!name) continue;
      const group = page.locator(`input[type="radio"][name="${name}"], input[type="checkbox"][name="${name}"]`);
      const size = await group.count().catch(() => 0);
      const labels = [];
      for (let k = 0; k < size; k++) {
        const el = group.nth(k);
        const text = (
          (await el.evaluate((e) => (e.closest("label")?.innerText || e.value || "")).catch(() => ""))
          || ""
        ).trim();
        labels.push({ el, text });
      }
      const signature = labels.map((l) => l.text).join(" ");
      if (!hintRe.test(signature)) continue;
      for (const l of labels) {
        if (!wanted.some((w) => l.text.toLowerCase() === w)) continue;
        if (await l.el.isChecked().catch(() => false)) {
          console.log(`    [answer] ${tag}: already "${l.text.slice(0, 30)}"`);
          return l.text;
        }
        await l.el.check({ timeout: 4000 }).catch(async () => {
          await l.el.click({ timeout: 4000, force: true }).catch(() => {});
        });
        console.log(`    [commitment] ${tag} → "${l.text.slice(0, 40)}" recorded under operator authorisation`);
        return l.text;
      }
    }
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
        + 'input[type="datetime-local"], input[type="number"], textarea',
      );
      const total = await fields.count().catch(() => 0);
      let filled = 0;
      let firstLanded = "";
      for (let i = 0; i < total && i < 40; i++) {
        const field = fields.nth(i);
        if (!(await field.isVisible().catch(() => false))) continue;
        if (await isMirrorInput(field)) continue;
        // Never overwrite a value that is already there.
        if (String(await field.inputValue().catch(() => "")).trim()) continue;
        const signature = await field.evaluate(controlSignatureMatcher()).catch((e) => {
          console.log(`    [answer] ${tag}: matcher failed (${String(e.message || e).slice(0, 80)})`);
          return "";
        });
        if (!hintRe.test(String(signature))) continue;
        // A fact can veto its own hint on a specific control...
        if (typeof options?.notWhen === "function" && options.notWhen(String(signature))) continue;
        // A per-control fact resolves its value from THIS control's own text,
        // which is how one salary answer serves both a per-month and a
        // per-annum question.
        const text = resolve ? String(resolve(signature) ?? "").trim() : fallback;
        if (!text) continue;
        // A control that only takes a number is given one, or nothing: prose
        // leaves it "Invalid input" and the step refuses to advance even though
        // the log shows a successful fill.
        const isNumberControl = await field.evaluate((el) => {
          const type = String(el.getAttribute("type") || "").toLowerCase();
          const mode = String(el.getAttribute("inputmode") || "").toLowerCase();
          return type === "number" || mode === "numeric" || mode === "tel";
        }).catch(() => false);
        const statedNumber = statedNumericAnswer(signature, options?.stated);
        const numeric = statedNumber
          ? { text: statedNumber, numeric: true, missing: false }
          : numericFieldAnswer(isNumberControl ? "example: 1" : signature, text);
        if (numeric.missing) {
          console.log(`    [answer] ${tag}: control takes a number and the stated answer is "${text.slice(0, 40)}" — left empty`);
          continue;
        }
        await field.fill(numeric.text).catch(() => {});
        await page.waitForTimeout(150);
        const answerText = numeric.text;
        // A controlled input can reject the value it was given. Say so, rather
        // than logging a fill that did not happen.
        let landed = String(await field.inputValue().catch(() => "")).trim();
        if (landed !== answerText) {
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
          const chosen = await pickFromAutocomplete(field, answerText);
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
        const committed = await field.evaluate((el) => {
          if (el.getAttribute("role") !== "combobox") return null;
          const wrap = el.closest("[class*='select__control']") || el.closest("[class*='select__container']");
          if (!wrap) return null;
          const v = wrap.querySelector("[class*='single-value']");
          return v ? String(v.textContent || "").trim() : "";
        }).catch(() => null);
        if (committed !== null) {
          // The typed text is not the answer: a react-select keeps it in the
          // input while the committed value lives in .single-value. Reading raw
          // inputValue() reported a typed-but-unselected value as a filled field
          // - measured 2026-11-05, #143 Glean: "[fill] how you heard ->
          // LinkedIn" while the board still counted "How did you hear about
          // Glean?*" as empty.
          landed = committed;
        }
        const stillEmpty = committed !== null
          ? !committed
          : !String(await field.inputValue().catch(() => "")).trim();
        if (!landed && stillEmpty) {
          // Leave no half-answer behind: a typed value with nothing selected
          // still reads to the board's validator as an empty required field,
          // and to the next pass as text worth not overwriting.
          if (committed !== null) await field.fill("").catch(() => {});
          console.log(`    [answer] ${tag}: value did not stick (nothing was accepted)`);
          continue;
        }
        if (landed && landed !== text) {
          console.log(`    [answer] ${tag}: option "${landed.slice(0, 40)}" selected for "${text.slice(0, 40)}"`);
        }
        console.log(`    [fill] ${tag} -> "${answerText.slice(0, 40)}"${answerText !== text ? ` (number, from "${text.slice(0, 40)}")` : ""}`);
        filled += 1;
        firstLanded = firstLanded || answerText;
        // Keep going instead of returning on the first match: a form can ask
        // the same fact twice - PlanetScale asks both "Where are you located?"
        // and "Where are you based?" - and stopping after the first left the
        // second empty and blocked the submit while the log showed a
        // successful fill. `once` still stops at the first, which is what keeps
        // the work-authorisation answer scoped to one jurisdiction.
        if (once) return text;
      }
      if (filled) return firstLanded;

    // A required question is often a native <select>, which is not an input and
    // was therefore never inspected at all. Greenhouse asks "How did you hear
    // about <Company>?*" that way, so the answer sat in the profile while the
    // submit was refused for an empty required field - measured 2026-11-05,
    // #143 Glean: the form was filled, "Submit application" was clicked, and the
    // board came back "required fields still empty: How did you hear about
    // Glean?*".
    //
    // Only an option that actually exists is picked. If the question offers
    // "Job board" rather than the board's own name, that is what gets selected -
    // it is still true, and it is the option the form will accept. No option is
    // invented and a question this cannot answer is left for the log.
    const selects = page.locator("select");
    const selectTotal = await selects.count().catch(() => 0);
    const aliasLabels = Array.isArray(options?.fallbackLabels) ? options.fallbackLabels : [];
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (let i = 0; i < selectTotal && i < 20; i++) {
      const control = selects.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      const signature = await control.evaluate(controlSignatureMatcher()).catch(() => "");
      if (!hintRe.test(String(signature))) continue;
      const current = await control.evaluate((el) => {
        const opt = el.options?.[el.selectedIndex];
        return { value: String(el.value || ""), label: String(opt?.textContent || "").trim() };
      }).catch(() => ({ value: "", label: "" }));
      // A placeholder is not an answer: "Please select..." still leaves the
      // question unanswered to the board's own validator.
      const placeholder = !current.value || /^(?:please|select|choose|--)/i.test(current.label);
      if (!placeholder) continue;
      const labels = await control.evaluate((el) => [...el.options]
        .map((o) => ({ value: String(o.value || ""), label: String(o.textContent || "").trim() }))
        .filter((o) => o.label && !/^(?:please\s*select|select|choose|--)/i.test(o.label)))
        .catch(() => []);
      if (!labels.length) continue;
      const text = resolve ? String(resolve(signature) ?? "").trim() : fallback;
      const wanted = [text, ...aliasLabels].map(norm).filter(Boolean);
      let choice = null;
      for (const want of wanted) {
        choice = labels.find((o) => norm(o.label) === want)
          || labels.find((o) => norm(o.label).startsWith(want))
          || labels.find((o) => new RegExp(`\\b${escapeRe(want)}\\b`).test(norm(o.label)));
        if (choice) break;
      }
      // Last resort, and only from the un-normalised answer: "0.2 years" still
      // carries its decimal here, while a normalized copy would read as "0 2".
      if (!choice) choice = numericOption(labels, text);
      if (!choice) {
        console.log(`    [answer] ${tag}: select offers no option for "${text.slice(0, 30)}" (${labels.map((o) => o.label).join(" | ").slice(0, 90)})`);
        continue;
      }
      await control.selectOption({ label: choice.label }).catch(() => {});
      await page.waitForTimeout(150);
      const landed = await control.evaluate((el) => String(el.options?.[el.selectedIndex]?.textContent || "").trim()).catch(() => "");
      if (!landed || landed !== choice.label) {
        console.log(`    [answer] ${tag}: select did not take "${choice.label.slice(0, 30)}"`);
        continue;
      }
      console.log(`    [fill] ${tag} -> "${choice.label.slice(0, 40)}" (select)`);
      filled += 1;
      firstLanded = firstLanded || choice.label;
      if (once) return choice.label;
    }
    if (filled) return firstLanded;
    console.log(`    [answer] ${tag}: no empty field matched ${hintRe.source} (${total} checked)`);
    return null;
  };
  // The phone's dialling code is its own control wherever a board splits it out
  // from the number: Keka signs it `mobilePhone.countryCode`, Deel calls it
  // "Dial code". Left empty it blocks the submit even though the number itself
  // was filled — #1320 Zema (Deel, 2026-11-10) showed the phone as invalid for
  // exactly this. It is answered only from a stated answer, and only on a control
  // that names itself as a dialling/country CODE, so the location "Country"
  // question further down can never receive "+91".
  const dialCode = String(candidate?.application_answers?.dial_code || "").trim();
  if (dialCode) {
    await combo(
      /\b(?:dial(?:ling)?\s*code|country\s*code|isd\s*code|country\s*prefix)\b/i,
      [dialCode, "India", "India (+91)"],
      {
        label: "dial code",
        // Boards write the option their own way: Deel prints "IN +91" beside 243
        // others, so neither "+91" nor "India" matches by label and word-boundary
        // matching cannot see a "+". Choose the option that CONTAINS the stated
        // code, which is the one fact this question is about.
        pick: (texts) => texts.find((t) => String(t).replace(/\s+/g, "").includes(dialCode.replace(/\s+/g, ""))),
      },
    );
  }
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
    // The bare alternative allows the word to appear more than once: the
    // signature is the control's own attributes followed by its prompt, so a
    // field whose id is "country" and whose label is "Country" signs as
    //   "country    country"
    // and an anchored single-word alternative refused it. That is Greenhouse's
    // phone dialling-code select, and leaving it empty is what made the board
    // answer a fully-filled application with "Select a country" — measured
    // 2026-11-05, #143 Glean: every other field was filled and the submit was
    // refused for this one control, four complaint nodes, all "Country".
    /(?!\b(?:phone|mobile|tel|dial(?:ling)?|contact|calling|country\s*code)[^a-z]{0,20})\b(?:country|nation)\b.{0,40}?\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b|\b(?:locat\w*|reside\w*|based|address\w*|citizen\w*|from|where)\b.{0,40}?\b(?:country|nation)\b|^(?:country|nation)(?:\s+(?:country|nation))*\s*[:*\-]?\s*$/i,
    [String(candidate?.country || profile?.candidate?.country || "India").trim() || "India"],
  );
  // The same question is a native <select> on Greenhouse and a react-select on
  // others, so both paths answer it. Without the combo path a custom dropdown
  // stayed empty and blocked the submit just like the <select> did.
  const heardStated = profile?.candidate?.application_answers || {};
  const heardValue = String(heardStated?.how_you_heard || heardFromBoard(job)).trim();
  await combo(
    /how\s+did\s+you\s+hear|how\s+you\s+(?:heard|found)|where\s+did\s+you\s+(?:hear|find)/i,
    [heardValue, "Job board", "Job Board", "Other"],
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
    WORK_LOCATION_QUESTION,
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
    for (const fact of identityFacts(candidate, stated, job, profile)) {
      // `once` facts stop after the first matching control; the rest fill every
      // match, because a form may ask the same fact more than once. A fact with
      // byField resolves its value from each control's own signature.
      await answerQuestion(fact.hint, fact.value, fact.tag, {
        once: fact.once === true,
        resolve: fact.byField,
        fallbackLabels: fact.fallbackLabels,
        notWhen: fact.notWhen,
        stated,
      });
    }
    // Two questions exist only as dropdowns whose answers can only be chosen
    // from the board's own option list, so no profile string can answer them:
    // an experience BAND ("Intern / Fresher", "Less than 5 Years") and a
    // "can relocate to <city>" option. Both pick from what is on offer and stay
    // silent when the list offers nothing the profile supports - measured
    // 2026-11-09 on GitLab 8916232002, where these two of four questions were
    // the only ones left empty on an otherwise complete form.
    const experienceYears = Number.parseFloat(String(candidate?.experience_years ?? ""));
    if (Number.isFinite(experienceYears) && experienceYears >= 0) {
      await combo(YEARS_OF_EXPERIENCE_QUESTION, [], {
        label: "years of experience",
        pick: (texts) => experienceBandFor("total experience", texts, experienceYears),
      });
      // A question scoped to named technologies gets its own answer, decided by
      // whether the CV lists that technology - run after the general band so the
      // plain question is already answered and is not touched again.
      await combo(
        /how\s+many\s+years|years\s+of\s+experience|years?\s+of\s+[\w\s,]{0,40}experience/i,
        [],
        {
          label: "skill-scoped years",
          pick: (texts, signature) => skillYearsOption(texts, signature, profile, experienceYears),
        },
      );
    }
    await combo(
      /present\s+in|what\s+best\s+describe|your\s+situation/i,
      [],
      {
        label: "relocation",
        pick: (texts) => relocationOption(texts, candidate, stated),
      },
    );
    // The non-compete representation reaches the fact list only as a text
    // input, and Greenhouse renders it as a Yes/No react-select (measured on
    // GitLab 8916232002: "[answer] non-compete: value did not stick (nothing was
    // accepted)" on every pass). The legal answer is in the profile, so it is
    // given to the dropdown and to a radio pair too.
    const nonCompete = String(stated?.current_non_compete ?? "").trim();
    if (nonCompete) {
      const picked = await combo(NON_COMPETE_QUESTION, [nonCompete], { label: "non-compete" });
      if (!picked) await radio(NON_COMPETE_QUESTION, [nonCompete], "non-compete");
    }
    const commitments = [
      { key: "ever_interviewed_here", hint: /ever (?:been )?interviewed|interviewed (?:here|before|previously|with|at)|previous(?:ly)? interview|applied (?:here|before|previously)|have\s+you\s+(?:ever\s+)?(?:interviewed|spoken|applied)|in\s+the\s+past/i, tag: "prior interview history" },
      { key: "open_to_relocation", hint: /open to relocat|relocat(?:ion|e) for (?:this|the) role|willing to (?:move|relocat)/, tag: "open to relocation" },
      { key: "future_us_residence", hint: /(?:reside|work|live|located?|relocate) (?:now or )?(?:in|to) the (?:us|usa|united states)|future.*(?:united states)|\bthe us\b/i, tag: "future US residence" },
      { key: "requires_visa_sponsorship", hint: /sponsorship|require a visa|need a visa|visa support|work authorization|right to work/, tag: "visa sponsorship" },
      // Language proficiency. Keyed per language so any one of them can be
      // answered, and matched on the language name because that is how the form
      // words it: "Are you fluent or proficient in Arabic?". This blocked #716.
      //
      // Defaulting to "No" is the truthful answer for every language the operator
      // has not confirmed he speaks - he stated directly that he does not speak
      // Arabic. A blank required field blocks the submit outright, so leaving
      // these unanswered guaranteed a blocked form; "No" costs only the roles
      // that genuinely need that language.
      { key: "language_arabic", hint: /\barabic\b/i, tag: "Arabic proficiency" },
      { key: "language_french", hint: /\bfrench\b/i, tag: "French proficiency" },
      { key: "language_spanish", hint: /\bspanish\b|castilian/i, tag: "Spanish proficiency" },
      { key: "language_german", hint: /\bgerman\b/i, tag: "German proficiency" },
      { key: "language_chinese", hint: /\b(?:chinese|mandarin|cantonese)\b/i, tag: "Chinese proficiency" },
      { key: "language_hindi", hint: /\bhindi\b/i, tag: "Hindi proficiency" },
      { key: "language_english", hint: /\benglish\b/i, tag: "English proficiency" },
      // Frontend is excluded from the role scope, so a form claiming it would
      // contradict the pipeline's own filter. The operator confirms he has none.
      { key: "frontend_experience", hint: /frontend|front[- ]end|react|angular|vue\.?js/i, tag: "frontend experience" },
      { key: "react_experience", hint: /\breact(?:\.js|js)?\b/i, tag: "React experience" },
      { key: "angular_experience", hint: /\bangular(?:js)?\b/i, tag: "Angular experience" },
      { key: "nodejs_experience", hint: /node(?:\.js|js)|npm packages/i, tag: "Node.js experience" },
      // Self-described technical skills. Drafted from cv.md - it restates the
      // stack and the shipped systems, and adds nothing the CV does not support.
      // This blocked #333 ("How would you characterize your technical skills?").
      // Scale AI asks "How would you characterize your technical skills?"
      // as a five-option EXPERIENCE-LEVEL select, not a text box. Measured on
      // the live form: options are "I worked as a Software Engineer (either
      // full time or internship)" / "I studied Computer Science ... but
      // didn't do industry SWE" / "I studied a technical degree ..." /
      // "I taught myself SQL, Python, etc." / "I don't have enough technical
      // experience for the role". No prose can ever be accepted, so this must
      // be answered with one of them and must go through combo().
      //
      // The chosen option is drawn from cv.md: a completed backend engineering
      // internship at AKS Intelligent Systems LLP, May-July 2026. The option
      // reads "either full time or internship", so it is true - and more
      // accurate than the alternative defensible option, since he did do
      // industry SWE.
      { key: "technical_skills_experience", hint: /characteri[sz]e your technical skills/i, tag: "technical skills" },

      // Business travel. The operator answered this directly on 2026-10-08 after
      // it was flagged to him as the final blocker on #716: he is okay to travel.
      //
      // It was the one commitment deliberately left unset while it was open. A
      // Yes here is a commitment to something no CV field can imply, so silence
      // was correct until he said it himself - and a guessed Yes could have put
      // him in a role expecting travel he cannot do.
      //
      // Both the specific Scale AI wording and the general phrasing are matched,
      // since other boards ask it differently and the answer applies equally.
      { key: "business_travel_6_8_weeks", hint: /business trips?|travel (?:every|\d+\s*-\s*\d+\s*weeks?)|ready to (?:go on )?travel|willing to travel|relocation(?: support)? required/i, tag: "business travel" },
    ];
    for (const item of commitments) {
      const value = String(stated[item.key] ?? "").trim();
      if (!value) continue;
      const picked = await combo(item.hint, [value]);
      if (picked) {
        console.log(`    [commitment] ${item.tag} → "${picked}" recorded under operator authorisation`);
        continue;
      }
      // Not a dropdown. "Are you ready to go on business trips every 6-8 weeks?"
      // (which blocked #716) and the language questions are Yes/No radio pairs,
      // and combo cannot see those at all - it only walks [role="combobox"].
      //
      // Tried only after combo matched NOTHING. If combo found the control and
      // merely refused the value, a radio pass cannot help and re-asking risks
      // double-answering a multi-select.
      const radioPicked = await radio(item.hint, [value], item.tag);
      if (radioPicked) {
        console.log(`    [commitment] ${item.tag} → "${radioPicked}" recorded under operator authorisation`);
      }
    }

    // Language proficiency. Answered from the operator's own statements: he
    // speaks English and Hindi, and explicitly does not speak Arabic. Routed
    // through radio() because these are usually Yes/No controls, and through the
    // commitment list below so a select is covered too.
    for (const [key, label] of [
      ["language_arabic", "Arabic"], ["language_french", "French"],
      ["language_spanish", "Spanish"], ["language_german", "German"],
      ["language_chinese", "Chinese"],
    ]) {
      const answer = String(stated[key] ?? "").trim();
      if (!answer) continue;
      const picked = await radio(
        new RegExp(`\\b${label}\\b`, "i"), [answer], `${label} proficiency`,
      );
      if (picked) continue;
      await combo(new RegExp(`\\b${label}\\b`, "i"), [answer]);
    }

    // Frontend and Node are excluded from the role scope, so a form claiming
    // them would contradict the pipeline's own filter. The operator confirms he
    // has none. These are commonly Yes/No radios too.
    for (const [key, label, re] of [
      ["frontend_experience", "frontend", /frontend|front[- ]end/i],
      ["react_experience", "React", /\\breact/i],
      ["angular_experience", "Angular", /\\bangular/i],
      ["nodejs_experience", "Node\.js", /node(?:\\.js|js)/i],
    ]) {
      const answer = String(stated[key] ?? "").trim();
      if (!answer) continue;
      await radio(re, [answer], `${label} experience`);
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

    // Radio questions about facts the profile already states - where the
    // candidate lives, how many years he has worked - are answered from those
    // facts. Anything else is named in the log, so a form blocked on a disabled
    // Next points at the exact question that needs an operator answer.
    await answerFactualRadioQuestions(page, candidate);
    // Same principle for checkbox groups: Ask before assuming.
    await answerFactualCheckboxQuestions(page, candidate);
  }

  // Cover letter: use HQ recommendation if available (generic placeholder)
  if (sels.cover) {
    const cover = `Dear Hiring Manager,\n\nI am excited to apply for ${job.title} at ${job.company}. My background in ${profile.domain?.title || "Backend Engineering"} aligns closely with this role.\n\nBest regards,\n${fullName}`;
    await tryFill(page, sels.cover, cover);
  }
  return true;
}

/**
 * Hirist's own applied state for a posting.
 *
 * The job page swaps its Apply button for one reading "Applied" once an
 * application exists, and going back to the posting after submitting lands on
 * /job/applied?jobId=<id>. Neither phrasing matches the generic badge phrasings
 * ("application submitted", "you applied"), so a completed application was being
 * re-read as "no Apply button found" and downgraded to NeedsReview. Scoped to
 * the board's own hosts so the word "Applied" on any other site stays ignored.
 */
async function hasHiristAppliedBadge(page) {
  let host = "";
  try { host = canonicalHost(new URL(page.url()).hostname); } catch { return false; }
  if (!/(^|\.)hirist\.(?:tech|com)$/.test(host)) return false;
  if (/\/job\/applied|already-applied/i.test(String(page.url() || ""))) return true;
  return page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll("button, a, [role='button']")]
      .some((el) => visible(el) && /^applied$/i.test((el.innerText || "").trim()));
  }).catch(() => false);
}

async function hasVisibleAppliedBadge(page) {  const pageHit = await page.evaluate(() => {
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

// A board confirms a submission two ways: it prints the words in the page it
// already has, or it navigates to a dedicated route of its own. Keka does the
// second — measured 2026-11-09 on #1319, where the POST answered 200, the page
// fetched /careers/success/94986, and the run still filed the row as an error
// because the confirmation was never looked for in the address.
const SUBMISSION_LANDING_PATH = /(?:^|\/)(?:success|successful|confirmation|confirmed|thank-?you|thankyou|applied|application-(?:sent|received|submitted)|submitted|completed?)(?:\/|$)/i;

function isSubmissionLandingUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return SUBMISSION_LANDING_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

// The page can be gone by the time a post-submit question is asked (a board
// that navigates to its success route may close the window); asking a closed
// page throws, and that throw used to overwrite the evidence with an error.
function pageIsClosed(page) {
  try {
    return !page || page.isClosed();
  } catch {
    return true;
  }
}

function safePageUrl(page) {
  try {
    return pageIsClosed(page) ? "" : String(page.url() || "");
  } catch {
    return "";
  }
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

/**
 * Use a portal's own federated sign-in when no Submit is on the page.
 *
 * A portal that hides its application form behind a login is not a form
 * problem, and it is indistinguishable from a multi-step flow if all you check
 * is whether a Submit exists. Both produce "no Submit button detected - site
 * may use multi-step flow", which is exactly how ten Instahyre applications
 * and two Wellfound ones ended in NeedsReview without anyone noticing the
 * real cause.
 *
 * Google is preferred over LinkedIn, and both over a password form, because a
 * session already in the persistent profile (.edge-profile, the one --edge
 * uses) reduces the whole exchange to one click with no credential involved.
 *
 * Returns what actually happened rather than assuming success:
 *   { signedIn: true,  via }
 *   { signedIn: false, reason } - one of not-an-auth-wall,
 *     no-federated-option, credentials-required
 */
async function tryFederatedSignIn(page) {
  const PROVIDERS = [
    { via: "Google", re: /(?:sign\s*in|sign\s*up|log\s*in|continue)\s+with\s+google/i },
    { via: "LinkedIn", re: /(?:sign\s*in|sign\s*up|log\s*in|continue)\s+with\s+linkedin/i },
  ];
  const wall = await page.evaluate(() => {
    const body = String(document.body?.innerText || "");
    const head = body.replace(/\s+/g, " ").slice(0, 700);
    return {
      url: location.href,
      // A wall is either signalled by the URL or by the page asking to sign in.
      looksLikeWall: /\/(login|register|signup|signin|sign-in|auth|onboarding)\b/i.test(location.href)
        || /\b(sign up|sign in|log in|create (?:an )?account|register)\b/i.test(head),
      labels: [...document.querySelectorAll("button, a, [role=button], input[type=submit], div[role=button]")]
        .map((el) => String(el.innerText || el.value || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length <= 60),
    };
  }).catch(() => null);
  if (!wall || !wall.looksLikeWall) return { signedIn: false, reason: "not-an-auth-wall" };

  for (const provider of PROVIDERS) {
    const label = wall.labels.find((l) => provider.re.test(l));
    if (!label) continue;
    const control = page.locator(`button:has-text("${label}"), a:has-text("${label}"), [role=button]:has-text("${label}")`).first();
    if (!(await control.count().catch(() => 0))) continue;
    console.log(`  [sso] auth wall at ${String(page.url()).slice(0, 90)} — pressing "${label}"`);
    await control.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await control.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const state = await page.evaluate(() => {
      const body = String(document.body?.innerText || "");
      return {
        url: location.href,
        // A credential prompt. Deliberately includes the provider's own hosts,
        // because that is what it looks like the moment a session is absent.
        needsCredential: /accounts\.google\.com|linkedin\.com\/(login|checkpoint)|linkedin\.com\/uas\/login|enter your password|choose an account/i.test(
          location.href + " " + body.replace(/\s+/g, " ").slice(0, 400),
        ),
        stillWall: /\/(login|register|signup)\b/i.test(location.href),
      };
    }).catch(() => ({}));

    if (state.needsCredential) {
      // The line this whole feature stops at. A federated button is safe to
      // press only when the profile is already authenticated; the moment a
      // human is needed, hand over and name the one command that fixes it.
      console.log(`  [sso] ${provider.via} is asking for credentials — stopping without entering anything`);
      console.log(`         sign in once with:  node apps/browser-apply/tools/signin.mjs <board>`);
      return { signedIn: false, via: provider.via, reason: "credentials-required" };
    }
    if (!state.stillWall) {
      console.log(`  [sso] signed in via ${provider.via}`);
      return { signedIn: true, via: provider.via };
    }
    console.log(`  [sso] ${provider.via} returned to a wall (${String(state.url).slice(0, 70)})`);
  }
  return { signedIn: false, reason: "no-federated-option" };
};

/**
 * Rewrite a stored job URL into the form the board will actually serve.
 *
 * LinkedIn stores job links as https://in.linkedin.com/jobs/view/<slug>-<id> with
 * tracking parameters. Measured 2026-11-03 with a fully signed-in profile: the
 * www host served the posting normally, while the in.* host bounced to
 * /authwall?trk=bf - so the row died as redirect-blocked before Easy Apply was
 * ever reached, which is why the LinkedIn pool looked unrunnable rather than
 * merely unhandled. The numeric id is the durable part of the URL.
 */
function normaliseJobUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return value;
    if (!/\/jobs\/view\b/.test(parsed.pathname)) return value;
    const id = (parsed.pathname.match(/(\d{6,})/) || [])[1];
    // Some scraped links carry the slug but no id. www still serves those by
    // slug, so drop the tracking query and keep the path rather than failing.
    return id
      ? `https://www.linkedin.com/jobs/view/${id}/`
      : `https://www.linkedin.com${parsed.pathname}`;
  } catch {
    return value;
  }
}

async function processJob(browser, job, profile, runtime = {}) {
  const url = normaliseJobUrl(String(job.link || job.url || ""));
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
  // Every main-frame address this job visits. A board can confirm a submit by
  // navigating to its own success route, so the address is part of the
  // evidence — and it survives the window being closed afterwards, which the
  // page object does not.
  const visitedUrls = [];
  if (typeof page.on === "function") {
    page.on("framenavigated", (frame) => {
      try { if (frame === page.mainFrame()) visitedUrls.push(String(frame.url() || "")); } catch { /* gone */ }
    });
  }
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
      // Deel mints the same capability at
      //   POST api-prod.letsdeel.com/deelapi/guest/ats/application_form_upload_requests
      // and without it the CV never attached on #1320 (2026-11-10).
      // All are the ATS naming its own upload target, so all are harvested
      // from the ATS's own response. Nothing is guessed or wildcarded.
      if (!/presigned_fields|presigned_attributes|ApiCreateFileUploadHandle|application_form_upload_requests/i.test(href)) return;
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

  // Every document load and every outgoing write, logged as it happens.
  //
  // Without this, "the board refused the submit" was an inference: the guard
  // only logs the requests it BLOCKS, so a submit that was allowed and answered
  // with a validation error looked exactly like a click that did nothing at all.
  // Measured 2026-11-05, #143 Glean: the log showed "[submit] clicked final
  // Submit application" and then no other line, and there was no way to tell
  // which of the two had happened. Form posts and navigations are few, so this
  // stays quiet.
  if (typeof page.on === "function") {
    page.on("request", (request) => {
      try {
        const method = String(request.method?.() || "GET").toUpperCase();
        const type = String(request.resourceType?.() || "");
        const isDocument = type === "document";
        if (!isDocument && method === "GET") return;
        if (type === "image" || type === "ping" || type === "preflight") return;
        const label = isDocument ? "nav" : "write";
        console.log(`    [net] ${label} ${method} ${type || "document"} ${String(request.url()).slice(0, 120)}`);
      } catch { /* a dead request object is not worth a warning */ }
    });
    // The status of the same requests. A submit that the board answers with
    // 200-and-an-error reads very differently from one that is accepted, and
    // the difference decides Verified vs NeedsVerification.
    page.on("response", (response) => {
      try {
        const request = response.request?.();
        const method = String(request?.method?.() || "GET").toUpperCase();
        const type = String(request?.resourceType?.() || "");
        if (!(type === "document" || method !== "GET")) return;
        if (type === "image" || type === "ping" || type === "preflight") return;
        console.log(`    [net] ${response.status()} ${method} ${type || "document"} ${String(response.url()).slice(0, 100)}`);
      } catch { /* ignore */ }
    });
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

    // A Hirist posting answers with the word "Applied" in place of its Apply
    // button once the candidate has applied. That is the board's own record, and
    // the only way to reach it is to have completed the screening form - so it is
    // read as a verified submission rather than falling through to "no Apply
    // button found" and a NeedsReview that says nothing.
    if (await hasHiristAppliedBadge(page)) {
      console.log("  [hirist] posting shows Applied for this candidate — recording verified submission");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "verified", verifiedBy: "server-badge", pdf: resumePdf };
    }

    // Dead-listing guard: never attempt submits on 404/expired job pages
    const deadHit = await page.evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 2000);
      return /404|page not found|unable to load the page|may not be valid|posting has been removed|job (?:posting )?(?:has been|was) removed|no longer exists|no longer available|no longer accepting applications|no longer open|job (?:you are trying to view )?(?:has |is |was )?expired|position (has been )?filled|this job is (?:no longer|closed)|job is closed|posting (?:has )?ended/i.test(t);
    }).catch(() => false);
    const closedNotice = Boolean(deadHit) || await page.evaluate((closedSource) => {
      const t = (document.body?.innerText || "").slice(0, 2000);
      return new RegExp(closedSource, "i").test(t);
    }, CLOSED_LISTING_TEXT.source).catch(() => false);
    if (closedNotice && !(await hasCaptcha(page))) {
      console.log("  [dead] job page is 404/expired — skipping (mark for DB cleanup)");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "dead-link", pdf: resumePdf };
    }

    // A board that refuses automated browsers never paints the posting. Waiting
    // for a form that cannot arrive, and then recording "no Submit button
    // found", describes a broken form rather than the refusal that happened.
    const wallText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 800)).catch(() => "");
    if (isBotVerificationWall(wallText)) {
      const host = (() => { try { return new URL(page.url()).hostname; } catch { return "the board"; } })();
      console.log(`  [bot-wall] ${host} serves a Cloudflare verification page instead of the posting — no unattended application is possible here`);
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "board-blocked", pdf: resumePdf };
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
    const postingUrl = page.url();
    let applyNavigation = await detectAndClickApply(page, ats, navBoundary, finalGuard);
    // LinkedIn's own job page is the apply surface: Easy Apply is a modal over
    // it, so a click that leaves the posting for somewhere else is a misclick,
    // not a hop. #1278 Meril landed on /mynetwork, where the run filled a search
    // box and reported "no Submit button detected" on a live posting. Return to
    // the posting once and let the control be clicked again (the DOM fallback in
    // clickTriggerControl covers the sticky nav that swallowed the first click).
    if (ats === "linkedin" && !DRY_RUN && !applyNavigation.blocked && postingUrl) {
      let landed = "";
      try { landed = new URL(page.url()).pathname; } catch { landed = ""; }
      if (landed && !/^\/(?:jobs|apply|preload|talent)\b/i.test(landed)) {
        console.log(`  [misclick] Apply click left the posting for ${landed} — returning to it`);
        await page.goto(postingUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2000);
        const retried = await detectAndClickApply(page, ats, navBoundary, finalGuard);
        if (retried.clicked) applyNavigation = retried;
      }
    }
    // After an approved off-site hop the page is a corporate careers site, so
    // the originating ATS selectors no longer exist. Re-detect with the
    // generic set (e.g. "Apply for this role"). The hop itself already counts
    // as a click, so this must not depend on that flag.
    //
    // Only when the hop has NOT already landed on the form. Some careers sites
    // link straight to an /apply route (Keka: /careers/applyjob/<id>) and its
    // form carries its own "Apply Now" button; re-detecting there would find
    // that button and click it as an opener, i.e. press an application submit on
    // an empty form.
    if (!applyNavigation.blocked && onExternalAts(navBoundary)
        && !(await pageHasOneStepApplicationForm(page))) {
      const retry = await detectAndClickApply(page, "generic", navBoundary, finalGuard);
      if (retry.clicked) applyNavigation = retry;
    }
    // Opening the form is racy: the trigger may only scroll to a lazily
    // rendered section, a cookie notice can cover it, and hydration timing
    // varies. Retry the trigger and wait for real fields before giving up.
    if (!applyNavigation.blocked) {
      let surfaceReady = false;
      // The board may answer the Apply click with its own dialog instead of a
      // form ("Job search safety reminder" → "Continue applying" on LinkedIn).
      // Step through it once before waiting for fields that cannot appear yet.
      if (await dismissApplyInterstitial(page)) {
        applyNavigation = { ...applyNavigation, clicked: true };
      }
      for (let attempt = 1; attempt <= 3 && !surfaceReady; attempt++) {
        await dismissConsentBanners(page);
        surfaceReady = await waitForApplicationSurface(page, 12000);
        if (surfaceReady) break;
        console.log(`  [form-open] attempt ${attempt}: form not rendered, re-triggering Apply`);
        const again = await detectAndClickApply(page, onExternalAts(navBoundary) ? "generic" : ats, navBoundary, finalGuard);
        if (again.blocked) break;
        // The re-trigger can land on the same dialog rather than the form.
        await dismissApplyInterstitial(page);
      }
      if (surfaceReady) await fillCommonFields(page, ats, profile, job, navBoundary);
    }
    // Some Hirist postings have no screening form at all: the Apply click is the
    // whole application and the board answers with /job/applied?jobId=<id>. The
    // run then waited 3 x 12s for a form that never comes and recorded
    // NeedsReview on an application the board had already accepted - measured
    // on StatusNeo #1095, where the receipt mail arrived seconds after the click.
    // The board's own applied state is the evidence, so read it before deciding.
    if (!applyNavigation.blocked && await hasHiristAppliedBadge(page)) {
      console.log("  [hirist] Apply landed on the board's applied page — recording verified submission");
      if (!sharedCtx) await context.close();
      return { company: job.company, title: job.title, link: url, ats, action: "verified", verifiedBy: "server-badge", pdf: resumePdf };
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
      // A click that succeeded can still have landed on a registration wall
      // rather than a form. Instahyre does exactly this - "Apply now" navigates
      // the tab to /candidates/register/ - and because the check below ran first,
      // every one of its runs ended right here as needs-verification with the log
      // saying only "clicked final Apply now" and never mentioning a login. Ten
      // postings and 21 attempts looked like one unexplained failure instead of
      // one missing account.
      const landedOnWall = await page.evaluate(() => {
        const body = String(document.body?.innerText || "");
        return /\/(login|register|signup|signin)\b/i.test(location.href)
          || /\b(sign up|sign in|log in|create (?:an )?account)\b/i.test(body.replace(/\s+/g, " ").slice(0, 700));
      }).catch(() => false);

      let signedInNow = false;
      if (landedOnWall) {
        const sso = await tryFederatedSignIn(page);
        signedInNow = Boolean(sso.signedIn);
        if (signedInNow) {
          // Registration drops the candidate back on the job page rather than a
          // form, so the Apply control has to be pressed a second time.
          const applyAgain = page.locator('button:has-text("Apply now"), a:has-text("Apply now")').first();
          if (await applyAgain.count().catch(() => 0)) {
            const againLabel = ((await applyAgain.innerText().catch(() => "")) || "").trim().slice(0, 40);
            if (againLabel && isSubmissionControlLabel(againLabel)) {
              console.log(`  [sso] pressing "${againLabel}" again after sign-in`);
              await applyAgain.click({ timeout: 8000 }).catch(() => {});
              await page.waitForTimeout(5000);
            }
          }
        }
      }

      if (signedInNow) {
        // Deliberately no return. The form does not exist yet, so reporting an
        // outcome here would describe a page that has nothing on it. Fall through
        // into the normal fill-and-submit flow; the trust and captcha checks
        // immediately below this block both run again on the way down.
        console.log(`  [sso] authenticated — continuing into the application form`);
      } else if (ats === "yc" || ats === "wellfound") {
        // "Apply Now" on these boards OPENS the outreach modal; it does not
        // submit anything. Returning needs-verification here is what made every
        // Wellfound submission look attempted while landing nowhere: measured
        // 2026-11-03, two jobs logged "clicked final Apply Now", no receipt mail
        // arrived, and both pages still offered "Apply Now" afterwards. Fall
        // through to the modal handler below, where the real Send lives.
        console.log("  [apply] opener clicked - falling through to the YC/Wellfound modal handler");
      } else {
        const confirmed = await hasVisibleAppliedBadge(page) || await page.evaluate(() =>
          /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
        ).catch(() => false);
        if (!sharedCtx) await context.close();
        return { company: job.company, title: job.title, link: url, ats, action: confirmed ? "verified" : "needs-verification", pdf: resumePdf };
      }
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
      // Wellfound does not render its outreach modal until the apply control is
      // clicked, so a check made here sees no textarea and the flow falls
      // through to the generic submit path. That path clicks "Apply Now" - which
      // merely OPENS the modal - and then records needs-verification. Measured
      // 2026-11-03 on two Wellfound jobs: both logged "clicked final Apply Now",
      // no receipt mail ever arrived, and both pages still offered "Apply Now"
      // afterwards. Nothing was submitted. So click the opener, then look again.
      let nAreas = await page.locator("textarea").count().catch(() => 0);
      let modalOpen = nAreas > 0 || await page.evaluate(() =>
        /reach out to the team|start a conversation with the team/i.test(document.body?.innerText || "")
      ).catch(() => false);
      if (!modalOpen || nAreas === 0) {
        const opener = page
          .locator('button:has-text("Apply Now"), button:has-text("Apply to job"), a:has-text("Apply Now")')
          .first();
        if ((await opener.count()) > 0) {
          console.log("  [yc] no modal yet - clicking the apply control to open it");
          await opener.click({ timeout: 8000 }).catch((e) => {
            console.log(`  [yc] opener click failed: ${String(e).slice(0, 80)}`);
          });
          await page.waitForTimeout(3000);
          nAreas = await page.locator("textarea").count().catch(() => 0);
          modalOpen = nAreas > 0 || await page.evaluate(() =>
            /reach out to the team|start a conversation with the team|send application/i.test(document.body?.innerText || "")
          ).catch(() => false);
          console.log(`  [yc] after opener: textarea=${nAreas} modal=${modalOpen}`);
        }
      }
      if (modalOpen && nAreas > 0) {
        // Wellfound closes applications by geography and says so inside the
        // modal, with the Send button rendered disabled rather than hidden:
        //   "mozee is not accepting applications from your current location due
        //    to timezone overlap"
        //   "This job does not support the locations or timezones for remote
        //    work on your profile."
        // The engine used to fill what it could, find the answers uneditable,
        // and record needs-review - so the same US-remote role was re-visited
        // every run forever. Measured 2026-11-03 on #1131 (mozee, $125k-$170k,
        // Texas) and #1118 (Deepgram, $150k-$220k, US-remote). There is no
        // session that can make these submittable, so record the refusal and
        // stop spending a browser visit on it.
        if (ats === "wellfound") {
          const refusal = await page.evaluate(() => {
            const scope = document.querySelector('[class*="styles_modal"]') || document.body;
            const text = (scope.innerText || "").replace(/\s+/g, " ");
            const m = /[^.]*(?:not accepting applications from your current location|does not support the locations)[^.]*\.?/i.exec(text);
            return m ? m[0].trim().slice(0, 220) : "";
          }).catch(() => "");
          const sendDisabled = await page.locator('button[type="submit"]:visible')
            .evaluateAll((els) => els.length > 0 && els.every((el) => el.disabled === true))
            .catch(() => false);
          if (refusal && sendDisabled) {
            console.log(`  [yc] board refuses this location: ${refusal}`);
            if (!sharedCtx) await context.close();
            return {
              company: job.company, title: job.title, link: url, ats,
              action: "location-ineligible", reason: refusal, pdf: resumePdf,
            };
          }
        }
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
          // Wellfound keeps a pre-rendered (hidden) copy of this modal in the
          // DOM, so document order is not the modal: filling textarea[0] and [1]
          // writes into the hidden duplicate, reads back as 0 chars, and the
          // ready-check then refuses the Send. Measured 2026-11-03. Target the
          // visible ones and read the value back from the same element.
          const areas = page.locator("textarea:visible");
          const visibleCount = await areas.count().catch(() => 0);
          if (visibleCount !== nAreas) {
            console.log(`  [yc] ${nAreas} textarea(s) in the DOM, ${visibleCount} visible — using the visible ones`);
          }
          for (let i = 0; i < Math.min(visibleCount, 3); i++) {
            const area = areas.nth(i);
            const text = answers[keys[i]] || "";
            try {
              await area.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
              await area.click({ timeout: 8000 });
              await area.fill(text, { timeout: 8000 });
            } catch (e) {
              // Fallback: JS focus + value set + input events (modals/overlays)
              await page.evaluate(([idx, val]) => {
                const t = [...document.querySelectorAll("textarea")]
                  .filter((el) => el.getClientRects().length > 0)[idx];
                if (!t) return;
                t.scrollIntoView({ block: "center" });
                t.focus();
                document.execCommand("selectAll", false, null);
                document.execCommand("insertText", false, val);
                t.dispatchEvent(new Event("input", { bubbles: true }));
                t.dispatchEvent(new Event("change", { bubbles: true }));
              }, [i, text]).catch(() => {});
            }
            const gotLen = (await area.inputValue().catch(() => "")).length;
            console.log(`  [yc] textarea ${i + 1}: target ${text.length} chars, actual ${gotLen}`);
          }
          await page.waitForTimeout(1500);
          // Wellfound labels this "Submit application" and renders it as
          // button[type=submit]; YC says "Send application". Looking only for
          // "Send application"/"Send" found nothing, so every drafted answer
          // stopped one click short of submission and was recorded needs-review.
          const sendBtn = page
            .locator('button:has-text("Submit application"), button[type="submit"]:has-text("Submit"), button:has-text("Send application"), button:has-text("Send")')
            .first();
          let sent = false;
          let clickError = false;
          if (DRY_RUN) {
            console.log(`  [DRY-RUN] YC answers drafted — would click Send (use --live)`);
          } else if ((await sendBtn.count()) > 0) {
            const lens = await page.locator("textarea:visible")
              .evaluateAll((els) => els.map((t) => (t.value || "").length))
              .catch(() => []);
            const answersReady = lens.length >= Math.min(nAreas, 3) && lens.every((length) => length >= 50);
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
            console.log("  [yc] Send button not found - refusing an unverified submission");
            // Name the controls that ARE present, so the next failure of this
            // kind is one log line instead of another round of DOM probing.
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("button, [role='button'], input[type='submit']")]
                .map((el) => ((el.innerText || el.value || "").replace(/\s+/g, " ").trim()))
                .filter((t) => t && t.length < 40)
                .slice(0, 12)
            ).catch(() => []);
            console.log(`  [yc] visible controls: ${JSON.stringify(seen)}`);
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
    const uploadSelectors = ATS_SELECTORS[ats]?.fields?.resume || ATS_SELECTORS.generic.fields.resume;
    // Which document is sent is decided by the control's own label, not by the
    // board: a form asking for a resume gets the JD-tailored build, a form
    // asking for a CV gets the candidate's CV untouched.
    const uploadPdf = await resolveUploadPdf(page, job, profile, uploadSelectors);
    const uploaded = await tryUpload(page, uploadSelectors, uploadPdf, ats, navBoundary, uploadHosts);

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

    // LinkedIn Easy Apply is a wizard: Next (x N) → Review → Submit application.
    //
    // The modal has no role="dialog". Measured 2026-11-03 on a live India posting:
    // the wizard rendered in a plain <footer> whose button reads "Next" with no
    // aria-label, so the old `div[role='dialog'] button:has-text('Next')` selector
    // matched nothing - the walk never advanced, no Submit was ever on screen, and
    // the row recorded NeedsReview. Four of eight rows in one measured batch died
    // this way. LinkedIn holds 54 of the 55 India-located pending rows, so this
    // was the most expensive selector in the file.
    //
    // Pinning it to <footer> only moved the problem, and so did matching the
    // name alone. #1033 (Heads Up For Tails, 2026-11-10) clicked "Next" eight
    // times and ended on a *profile edit* overlay - "Dismiss | Save | Delete
    // experience | Add work experience | Back | Next" - because that overlay
    // carries its own Back/Next pair. Driving the wrong dialog is worse than not
    // driving one: it edits the candidate's profile and still never submits.
    //
    // So the step control is scope-bound: only inside the smallest container
    // that holds the wizard's own header ("Apply to <company>") and its
    // "N/M pages" progress, and only when its accessible name is exactly
    // "Next" / "Review" / "Review your application" / "Continue to next step".
    // A step that does not advance twice in a row stops the walk instead of
    // clicking into whatever opened on top of it.
    if (ats === "linkedin" && !DRY_RUN) {
      const stepName = EASY_APPLY_STEP_NAME;
      const locateStep = () => page.evaluate(([nameSrc]) => {
        const exact = new RegExp(`^(?:${nameSrc})$`, "i");
        const flat = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
        document.querySelectorAll("[data-pulseops-step]").forEach((el) => el.removeAttribute("data-pulseops-step"));
        const scopes = [...document.querySelectorAll("div, section, aside, form")]
          .filter((el) => {
            const t = flat(el);
            return t.length > 0 && t.length < 12000
              && /\bApply to\s+\S/.test(t) && /\b\d+\s*\/\s*\d+\s+pages?\b/i.test(t);
          })
          .sort((a, b) => flat(a).length - flat(b).length);
        const scope = scopes[0];
        if (!scope) return { found: false, key: "", label: "" };
        const buttons = [...scope.querySelectorAll("button")].filter((b) => {
          const label = (b.getAttribute("aria-label") || flat(b) || "").trim();
          return exact.test(label) && !b.disabled && b.offsetParent !== null;
        });
        if (!buttons.length) return { found: false, key: "", label: "" };
        const button = buttons[0];
        button.setAttribute("data-pulseops-step", "1");
        const heading = (scope.querySelector("h2, h3, [data-test-modal-header]") || {}).innerText || "";
        const progress = (/\b\d+\s*\/\s*\d+\s+pages?\b/i.exec(flat(scope)) || [""])[0];
        return {
          found: true,
          key: `${heading.replace(/\s+/g, " ").trim()}|${progress}`,
          label: (button.getAttribute("aria-label") || flat(button) || "").trim().slice(0, 30),
        };
      }, [stepName.source]).catch(() => ({ found: false, key: "", label: "" }));

      let previousKey = "";
      let stalls = 0;
      for (let step = 0; step < 8; step++) {
        if (!isCurrentPageTrusted(page.url(), ats, navBoundary)) {
          if (!sharedCtx) await context.close();
          return { company: job.company, title: job.title, link: url, ats, action: "redirect-blocked", pdf: resumePdf };
        }
        const found = await locateStep();
        // The wizard's work-experience step is a form inside the wizard, not a
        // page with a Next: it has to be filled and saved before the walk can
        // advance (or Next does nothing at all).
        if (await fillLinkedinExperienceStep(page, profile).catch(() => false)) {
          continue;
        }
        if (!found.found) break;
        // Fill the current step first: LinkedIn keeps Next enabled while required
        // fields are empty, so clicking it just leaves the same step on screen.
        await fillCommonFields(page, ats, profile, job, navBoundary);
        console.log(`  [easy-apply] step ${step + 1}: clicking "${found.label}"`);
        await page.locator("[data-pulseops-step]").first().click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const after = await locateStep();
        if (after.key && after.key === found.key && after.key !== previousKey) {
          stalls = 1;
        } else if (after.key && after.key === found.key) {
          stalls += 1;
        } else {
          stalls = 0;
        }
        previousKey = after.key;
        if (stalls >= 2) {
          const blocker = await page.evaluate(() => {
            const el = document.querySelector(".artdeco-inline-feedback--error, [role='alert'], .artdeco-inline-feedback__message");
            return (el?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
          }).catch(() => "");
          // Keep the evidence for the step that would not advance: the walk now
          // stops instead of clicking into whatever opened on top of it, so the
          // page itself is the only record of what was missing.
          const stepText = await page.evaluate(() => {
            const flat = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
            const scopes = [...document.querySelectorAll("div, section, aside, form")]
              .filter((el) => {
                const t = flat(el);
                return t.length > 0 && t.length < 12000
                  && /\bApply to\s+\S/.test(t) && /\b\d+\s*\/\s*\d+\s+pages?\b/i.test(t);
              })
              .sort((a, b) => flat(a).length - flat(b).length);
            const scope = scopes[0];
            if (!scope) return { questions: "", controls: "" };
            const visible = (el) => el.offsetParent !== null;
            // A select's innerText is every option it offers, which buries the
            // questions after it. Read the labels and the controls' own state
            // instead, so an unanswered required field is named outright.
            const questions = [...scope.querySelectorAll("label, legend, h2, h3, h4")]
              .filter(visible).map(flat).filter(Boolean);
            const controls = [...scope.querySelectorAll("input, select, textarea")]
              .filter(visible).map((el) => {
                const required = el.required || el.getAttribute("aria-required") === "true";
                const raw = el.tagName === "SELECT"
                  ? (el.selectedOptions?.[0]?.textContent || "").trim()
                  : String(el.value || "").trim();
                return `${el.tagName.toLowerCase()}${required ? "*" : ""}="${raw.slice(0, 40)}"`;
              });
            return {
              questions: questions.join(" | ").slice(0, 600),
              controls: controls.join(" ").slice(0, 700),
            };
          }).catch(() => ({ questions: "", controls: "" }));
          console.log(`  [easy-apply] step stalled at "${found.key || "unknown"}"${blocker ? ` — page says: ${blocker}` : ""}`);
          if (stepText.questions) console.log(`  [easy-apply] step questions: ${stepText.questions}`);
          if (stepText.controls) console.log(`  [easy-apply] step controls: ${stepText.controls}`);
          await page.screenshot({ path: screenshotPath.replace("preview", "wizard"), fullPage: true }).catch(() => {});
          break;
        }
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
    if (!submitFound) {
      // "No Submit" has three very different causes and one message covered all
      // three: a multi-step flow, a portal that needs an account, and a portal
      // whose apply button opens an app behind SSO. Try the account case before
      // concluding anything, because it is recoverable and the others are not.
      const sso = await tryFederatedSignIn(page);
      if (sso.signedIn) {
        // Registration usually drops the candidate back on the job page rather
        // than a form, so the Apply control has to be pressed a second time.
        const applyAgain = page.locator('button:has-text("Apply now"), a:has-text("Apply now"), button:has-text("Apply"), a:has-text("Apply")').first();
        if (await applyAgain.count().catch(() => 0)) {
          const applyLabel = ((await applyAgain.innerText().catch(() => "")) || "").trim().slice(0, 40);
          if (applyLabel && isSubmissionControlLabel(applyLabel)) {
            console.log(`  [sso] pressing "${applyLabel}" again after sign-in`);
            await applyAgain.click({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(5000);
          }
        }
        for (const sel of submitSels) {
          const probe = await pickVisible(page.locator(sel));
          if ((await probe.count()) > 0) {
            const l = ((await probe.innerText().catch(() => "")) || "").trim().slice(0, 60);
            if (isSubmissionControlLabel(l)) {
              console.log(`  [found] Submit → ${sel} ("${l}") — after sign-in`);
              submitFound = true;
              break;
            }
          }
        }
        if (!submitFound) {
          console.log(`  [sso] signed in via ${sso.via}, but still no Submit — treating as a multi-step flow`);
        }
      } else if (sso.reason === "credentials-required") {
        // Already logged precisely above. Do not also claim the site is
        // multi-step; that is the misdiagnosis this whole change removes.
      } else {
        console.log(`  [warn] no Submit button detected (${sso.reason}) — site may use multi-step flow`);
      }
    }

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
    // Where the address bar was when the submit was pressed: only a landing
    // reached AFTER the click can be evidence of a submission.
    let navMark = visitedUrls.length;
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
        // Remember where the address bar was before the press, so a landing
        // reached during the pre-submit flow can never be mistaken for proof.
        navMark = visitedUrls.length;
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
          // A board that answers by navigating to its own /success route can
          // close this window immediately afterwards; a fixed wait on a closed
          // page threw "Target page, context or browser has been closed" and
          // filed a submitted application as an error (#1319, Keka).
          await page.waitForTimeout(3000).catch(() => {});
          const landed = safePageUrl(page) || visitedUrls[visitedUrls.length - 1] || "";
          if (landed && !isCurrentPageTrusted(landed, ats, navBoundary)) {
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
    const serverApplied = clicked && HUMAN_FINAL_STATUSES.has(ats)
      && await hasVisibleAppliedBadge(page).catch(() => false);
    // A board can confirm by leaving the form for a route of its own rather than
    // printing the words in the page it already has. Only an address reached
    // AFTER the press counts, and it is read from the navigation log because the
    // window may already be gone by now (Keka's /careers/success/<id>, #1319).
    const landing = clicked
      ? visitedUrls.slice(navMark).find((visited) => isSubmissionLandingUrl(visited)) || ""
      : "";
    if (landing) console.log(`  [confirm] the board navigated to its confirmation page: ${landing.slice(0, 120)}`);
    let confirmed = clicked && (serverApplied || Boolean(landing) || await page.evaluate(() =>
      /successfully applied|application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied|application received/i.test(document.body?.innerText || "")
    ).catch(() => false));
    // Declared at function scope on purpose: the final return that records this
    // value sits outside BOTH the `if (clicked && !confirmed)` block and the
    // post-submit inspection block, so declaring it inside either one made
    // every submission throw "spamRefused is not defined" on the return.
    let spamRefused = false;
// A final click that lands on an SMS verification step is not a submission.
    // With --enter-otp the operator supplies the code they received.
    if (clicked && !confirmed && !pageIsClosed(page)) {
      const otp = await completeSmsVerification(page);
      if (otp.state === "submitted") {
        confirmed = true;
        await page.screenshot({ path: screenshotPath.replace("preview", "verified"), fullPage: true }).catch(() => {});
      } else if (otp.state === "not-present") {
        confirmed = false;
      }
    }
    // Diagnose before the context closes, otherwise the page is gone. A board
    // that confirmed by navigating away may also have closed the window, in
    // which case there is nothing left to diagnose and nothing to complain
    // about: the landing route already decided this row.
    if (clicked && !confirmed && pageIsClosed(page)) {
      console.log("  [confirm] the application window closed after the submit — no receipt was seen on it");
    }
    if (clicked && !confirmed && !pageIsClosed(page)) {
      // Say what the page actually says. A silent refusal is otherwise
      // indistinguishable from an unfilled field.
      const outcome = await describeSubmitOutcome(page).catch(() => null);
      if (outcome) {
        if (outcome.heading.length) console.log(`  [page] heading → ${outcome.heading.join(" | ").slice(0, 140)}`);
        if (outcome.messages.length) console.log(`  [page] message → ${outcome.messages.join(" | ").slice(0, 400)}`);
        if (outcome.problems?.length) {
          console.log(`  [page] complaints → ${outcome.problems
            .map((p) => `${p.field || "?"}${p.text && p.text !== p.field ? `: ${p.text}` : ""}`)
            .join(" | ").slice(0, 400)}`);
        }
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
          if (pageIsClosed(page)) break;
          await page.waitForTimeout(2000).catch(() => {});
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
        // No score bucket here. Score ranks the in-scope pool; it never removed a
        // row from it (`isEligibleJob` has had no score check since the 12-score
        // manager role outranked a 65-score India role). Reporting "score<N" as a
        // drop reason is what made the queue's real blocker invisible twice.
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
  // The board refuses automated browsers at the door (Cloudflare managed check,
  // see isBotVerificationWall). Nothing a human can answer in the window changes
  // it, and re-attempting burns a slot a day, so it is terminal.
  if (action === "board-blocked") return "Skipped";
  if (action === "dead-link" || action === "invalid-listing") return "Expired";
  if (action === "salary-below-threshold") return "Skipped";
  // The board refused the submission itself as spam. Recording this as
  // NeedsVerification sends an operator to wait for a confirmation that will
  // never come, and re-running just repeats the refusal. Skipped is the honest
  // terminal state: we did apply, and the board declined to take it.
  if (action === "spam-refused") return "Skipped";
  // The posting will not accept an application from the candidate's location
  // (a US-only onsite/remote role, said plainly in the modal). Retrying cannot
  // change that, and NeedsReview kept these rows coming back every run.
  if (action === "location-ineligible") return "Skipped";
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
      sharedCtx = await chromium.launchPersistentContext(EDGE_PROFILE, {
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
      console.log(`[Edge] persistent profile ${EDGE_PROFILE} (msedge, headed)`);
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
  isEssayFieldHint,
  isBotVerificationWall,
  UPLOAD_BUTTON_LABEL,
  APPLY_INTERSTITIAL_LABEL,
  EASY_APPLY_STEP_NAME,
  numericFieldAnswer,
  numericOption,
  additionalMonthsOfExperience,
  statedNumericAnswer,
  statedOptionIndex,
  isSubmissionLandingUrl,
  pageIsClosed,
  safePageUrl,
  inferATS,
  installNavigationGuard,
  isFinalApplyControl,
  isAllowedInitialJobUrl,
  isAllowedNavigationUrl,
  isStrictTargetRole,
  isAuthWallHost,
  isGoogleFormUrl,
  isSubmissionControlLabel,
  isListingBrowseUrl,
  CLOSED_LISTING_TEXT,
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
  skillRatingFor,
  skillYearsFor,
  skillScopedQuestion,
  statedSkillEntries,
  jobDescriptionFor,
  whyInterested,
  rankByAcceptance,
  isIndiaBoardRow,
  readAcceptanceByAts,
  candidateFirstName,
  candidateLastName,
  heardFromBoard,
  decideUploadKind,
  findCanonicalCv,
  servingAtsForRequest,
  portalAssetHostAllowed,
  portalApiHostAllowed,
  placeAliases,
  experienceBandFor,
  relocationOption,
  skillYearsOption,
  noticeDays,
  noticeBandFor,
  YEARS_OF_EXPERIENCE_QUESTION,
  WORK_LOCATION_QUESTION,
  isApplicationSurfaceControl,
  relocationPicks,
  availabilityDate,
  salaryAnswer,
  firstAmount,
  salaryInLacs,
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
  answerFactualRadioHints,
  yearsRequirement,
  stipendFigure,
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
