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