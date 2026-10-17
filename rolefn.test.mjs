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

const SOFTWARE_ENGINEERING_TITLE =
  /\bsoftware\b[^a-z0-9]{0,20}\b(?:developer|development|programmer)\b|\b(?:developer|development|programmer)\b[^a-z0-9]{0,20}\bsoftware\b/i;


const AI_WITH_ENGINEERING_NOUN = new RegExp(
  String.raw`\bai\b.{0,30}?\b(?:engineer|engineering|scientist|researcher|architect|developer|programmer)\b`
  + String.raw`|\b(?:engineer|engineering|scientist|researcher|architect|developer|programmer)\b.{0,30}?\bai\b`,
  "i",
);


const BACKEND_SIGNAL =
  /\b(?:python|java|spring|golang|c\+\+|\bc#\b|\.net\b|rust|kotlin|scala|backend|back[\s-]end|microservices?|distributed systems?|postgres|sql|kafka|redis|llm|genai|ml\b|machine[\s-]+learning|deep[\s-]+learning|computer[\s-]+vision|nlp|agentic|agents?\b|api)\b/i;

function descriptionIsFrontendOnly(body) {
  if (BACKEND_SIGNAL.test(body)) return false;
  
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

