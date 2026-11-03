/**
 * Title cleaning and relevance ranking for the weekly portal scan.
 *
 * Why this module exists
 * ---------------------
 * The scan used to hand whatever text a board rendered straight to the evaluator.
 * Every India board decorates its listings, so the pipeline received values like
 *
 *   "Backend Developer Bangalore Founded in 2021 50-200 employees View job »
 *    CapsLock is a Dubai-based marketing agency off..."
 *
 *   "HiveMarketing automation for event promoters (email, sms, ads, CRM)
 *    Senior Software Engineer, Data SystemsFull-time · Remote (US)"
 *
 * The measured effect: 78 of 436 sourced postings carried an in-scope role, but
 * the domain filter rejected most of them because the *company blurb* contained
 * "marketing"/"sales", and the role-scope gate in the apply queue rejected the
 * rest because the title still carried a company name and a location. Roles were
 * being discarded for text the board glued on, not for anything about the job.
 *
 * Cleaning happens once, at the ingestion boundary (`appendUniqueJobs`), so the
 * database, the evaluator and the browser-apply gate all read the same string.
 *
 * Selection happens before a portal's row cap. Taking the first 40 of Anthropic's
 * 683 postings returned 40 US senior roles every week, so the handful of India
 * entry-level roles was never reachable - the cap decided which roles existed.
 */

// Board chrome that appears inside a scraped title. Ordered longest-first where
// one pattern would otherwise eat another's text.
const BOARD_CHROME = [
  /\s*[·•|]\s*(?:full[\s-]?time|part[\s-]?time|contract|internship|remote|hybrid|on[\s-]?site)\b.*$/i,
  // Same chip glued to the preceding word — Wellfound renders
  // "Software Engineer, Data SystemsFull-time", and only the bullet-prefixed
  // form was stripped, so "Full-time" survived into the stored title. The
  // lookbehind also accepts whitespace and "(" so the ordinary
  // "Machine Learning Researcher Full-time" form is stripped too; it can never
  // fire at position 0, so a title that *starts* with "Full-time" survives.
  /(?<=[a-z\)\s])(?:Full|Part)[\s-]?time\b.*$/,
  /(?<=[a-z\)\s])In\s+office.*$/,
  // Wellfound's compensation chip: "Chennai L - 35L".
  /\s+[A-Z]\s*-\s*\d+(?:\.\d+)?\s*[Ll]\b.*$/,
  /\s*founded\s+in\s+(?:19|20)\d{2}.*$/i,
  /\s*\d+\s*[-–]\s*\d+\s*(?:employees|people)\b.*$/i,
  /\s*\d+\+?\s*(?:employees|people)\b.*$/i,
  /\s*view\s+job\b.*$/i,
  /\s*actively\s+hiring\b.*$/i,
  /\s*apply\s+now\b.*$/i,
  /\s*posted\s+\d+\s*(?:day|hour|week|month)s?\s+ago\b.*$/i,
  /\s*(?:recently\s+active|be an early applicant|easy apply)\b.*$/i,
  /\s*work\s+from\s+home\b.*$/i,
  /\s*work\s+from\s+office\b.*$/i,
];

// Cities and regions that boards append to a role with no delimiter. Only
// stripped from the END, and only as a whole trailing phrase.
const PLACES = [
  "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai", "noida",
  "gurugram", "gurgaon", "greater noida", "new delhi", "delhi ncr", "delhi",
  "kolkata", "ahmedabad", "jaipur", "indore", "kochi", "coimbatore", "remote",
  "india", "pan india", "anywhere in india",
];

// The separator may be whitespace, a comma/dash or a slash. "Backend Engineer
// Bangalore", "Backend Engineer, Bangalore, India" and "… REST API / Remote" are
// the same title with different punctuation, and only the whitespace form used to
// be stripped — so a comma left the city in the stored title.
const PLACE_TAIL = new RegExp(
  `(?:\\s*[,–—/-]\\s*|\\s+)(?:in\\s+|at\\s+)?(?:${PLACES.map((p) => p.replace(/ /g, "\\s+")).join("|")})\\s*$`,
  "i",
);

// Pipe-separated metadata, e.g. "Backend Developer Intern | Entry Level |
// Fresher | Node.js, Python, REST APIs / Remote". Location and seniority segments
// are board decoration and go; a segment that names a technology stays, because
// the stack is a real disqualifier — dropping "| Node.js" made a Node role look
// eligible to a Python/C++ candidate.
const PIPE_STACK =
  /\b(?:node(?:\.js)?|javascript|js|typescript|react|angular|vue|next\.js|java|python|golang|go|rust|kotlin|php|ruby|perl|c\+\+|c#|\.net|sql|postgres\w*|mysql|mongo\w*|django|flask|fastapi|spring\w*|docker|kubernetes|k8s|aws|gcp|azure|ml|ai|llm|nlp|pytorch|tensorflow)\b/i;

// YC's card markup glues the employer onto the role with no separator at all:
// "RationalFirst Zero-human Accounting FirmMachine Learning Researcher Full-time".
// The company name is then read as the candidate's own discipline ("Accounting"),
// so the posting is rejected for what the employer sells. Split only a CamelCase
// boundary — a lowercase letter followed by a capitalised role noun and then
// another word — so "Mumbai" never becomes "Mum bai".
const GLUED_ROLE =
  /(?<=[a-z])(Machine|Software|Backend|Frontend|Full|Data|Product|Research|Applied|Platform|Infrastructure|Engineering|Developer|Engineer|Analyst|Scientist|Architect|Consultant|Senior|Staff|Lead|Principal|Junior|Founding)(?=\s*[A-Z][a-z])/g;

// Hirist appends the number of open positions to the role ("Backend Developer2",
// "Engineering Manager6"). The digits are welded to the word — with a space they
// are a level, and "SDE 2" must not become "SDE".
const TRAILING_COUNT = /(?<=[a-z\)])\d{1,3}$/;

// YC's card markup has no separator between company, tagline and role, so the
// only reliable boundary is the capitalised start of the role phrase. These are
// the words a role can begin with on that board.
const ROLE_START =
  /(?:^|[\s)\.\-])((?:Founding|Senior|Staff|Lead|Principal|Junior|Associate|Entry|Graduate|New\s+Grad|Software|Backend|Back[\s-]End|Frontend|Front[\s-]End|Full[\s-]?Stack|Machine|ML|AI|GenAI|LLM|Data|Product|Project|Program|Research|Applied|Forward\s+Deployed|Platform|Infrastructure|Site\s+Reliability|Solutions?|Customer|Security|Cloud|DevOps|Mobile|Android|iOS|Embedded|QA|SDET|Test|Technical|Engineering|Developer|Engineer|Analyst|Scientist|Architect|Consultant|Intern)\b.*)$/i;

/**
 * Strip board chrome from a scraped title.
 *
 * Idempotent: cleaning an already-clean title returns the same value.
 */
export function cleanTitle(raw) {
  let value = String(raw || "")
    .replace(/[\u00a0\u200b]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";

  // 1. A specialty glued to its location ("Computer UseSan Francisco, CA").
  //    Split before a capital run that follows a lowercase letter.
  value = value.replace(/([a-z\)])((?:[A-Z][a-z]{2,}){1,4})\s*$/, "$1 $2");

  // 1b. An employer glued onto the role ("FirmMachine Learning Researcher").
  //
  // Whether this fired is the reliable glue signal step 4 needs. The old test
  // was `length > 60 && "Full-time" in raw`, and board chrome strips
  // "Full-time · <place>" first, so it ran on the shortened string: "AI
  // DronesSoftware EngineerFull-time · San Francisco, CA, US" is 58 characters
  // and kept its company glued on. Python mirror: title_clean.py.
  const unglued = value.replace(GLUED_ROLE, " $1");
  const glueFound = unglued !== value;
  value = unglued;

  // 2. Pipe metadata ("Backend Engineer | Bangalore"). Location and seniority
  //    segments are dropped; a segment that names a technology is kept so the
  //    role gate can still see the stack.
  if (value.includes("|")) {
    const segments = value.split("|").map((segment) => segment.trim());
    const kept = [segments[0], ...segments.slice(1).filter((segment) => segment && PIPE_STACK.test(segment))];
    value = kept.filter(Boolean).join(" | ");
  }

  // 3. Board chrome, including everything after it.
  for (const pattern of BOARD_CHROME) value = value.replace(pattern, "");
  value = value.replace(/\s+/g, " ").trim();

  // 4. Glued company + tagline + role (YC). Keep from the last role-start word
  //    only when the text before it does not already look like a role phrase.
  //    Gated on a glue signal - the raw carried a Full-time/Part-time marker, or
  //    step 1b had to pull a role word apart - and NOT on length. The length
  //    test ran after board chrome had already removed "Full-time · <place>",
  //    so "PlutoLinkedIn for agents Founding Engineer" (41 chars) skipped it and
  //    went to queue with the tagline still attached.
  if (glueFound || /(?:full|part)[\s-]?time\b/i.test(String(raw || ""))) {
    const m = ROLE_START.exec(value);
    if (m && m.index > 0) value = m[1];
  }

  // 5. Trailing place name, applied at most twice ("Backend Engineer Bangalore
  //    India" -> "Backend Engineer").
  for (let i = 0; i < 2; i += 1) {
    const next = value.replace(PLACE_TAIL, "");
    if (next === value) break;
    value = next;
  }

  // 6. Hirist's trailing opening count.
  value = value.replace(TRAILING_COUNT, "");

  value = value.replace(/[\s,;:.\-–—]+$/, "").trim();
  return value.slice(0, 160);
}

// ── Role scope (mirrors packages/pulse-eval/.../title_clean.py) ─────────────

const SENIORITY_EXCLUDE =
  /\b(?:senior|sr|staff|lead|principal|director|head\s+of|vp|vice\s+president|manager|architect|chief|cto|founder)\b/i;

const ENTRY_LEVEL =
  /\b(?:intern|internship|trainee|fresher|graduate|new\s+grad|entry[\s-]?level|junior|jr|associate|apprentice|sde\s*[-\s]?1|software\s+engineer\s+i)\b/i;

// Non-engineering disciplines. Word-boundary matched: the previous substring
// test rejected every title containing "sales" inside "Salesforce", and matched
// "ios" inside "adios".
const OFF_DOMAIN =
  /\b(?:sales|marketing|recruiter|recruiting|talent\s+acquisition|account\s+executive|account\s+manager|business\s+development|business\s+analyst|customer\s+success|support\s+engineer|product\s+manager|project\s+manager|program\s+manager|product\s+designer|graphic\s+design|ux\s+designer|ui\s+designer|data\s+scientist|data\s+analyst|finance|accounting|legal|counsel|operations|consultant|specialist|strategist|solutions?\s+architect|solutions?\s+engineer|security\s+engineer|devrel|developer\s+advocate|technical\s+writer|copywriter)\b|(?:mechanical|civil|structural|electrical|electronics?|chemical|aerospace|biomedical|industrial|manufacturing|materials?|environmental|mining|agricultural|marine|naval|automotive|hvac|instrumentation|process|plant|maintenance|field|supply[\s-]+chain|logistics)\s+engineer\b/i;

const IN_SCOPE =
  /\b(?:backend|back[\s-]end|software\s+(?:engineer|developer|development)|sde|developer|programmer|ml|machine\s+learning|deep\s+learning|reinforcement\s+learning|artificial\s+intelligence|ai|genai|generative\s+ai|llm|nlp|computer\s+vision|data\s+engineer|platform\s+engineer|infrastructure\s+engineer|site\s+reliability|devops|java|python|c\+\+|golang|go|rust|kotlin|spring|grpc|api|microservices|systems?\s+engineer|research\s+engineer|applied\s+scientist|founding\s+engineer|full\s*stack)\b/i;

// Languages outside the candidate's set. A "Backend Engineer (Ruby)" title is
// in-scope by role family and pure waste by stack.
const OFF_STACK = /\b(?:ruby|rails|php|perl|c#|\.net|dotnet|vb\.net)\b/i;

export function isExcludedSeniority(title) {
  return SENIORITY_EXCLUDE.test(cleanTitle(title));
}

export function isEntryLevel(title) {
  return ENTRY_LEVEL.test(cleanTitle(title));
}

export function isOffDomainTitle(title) {
  return OFF_DOMAIN.test(cleanTitle(title));
}

export function isInScopeTitle(title) {
  const value = cleanTitle(title);
  if (!value) return false;
  if (isOffDomainTitle(value)) return false;
  if (OFF_STACK.test(value)) return false;
  return IN_SCOPE.test(value);
}

const INDIA = /\b(?:india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|noida|gurugram|gurgaon|delhi|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|remote)\b/i;

export function locationLooksRelevant(location) {
  const value = String(location || "").trim();
  // An unknown location is not evidence against the role.
  if (!value) return true;
  return INDIA.test(value);
}

/**
 * Relevance score used to choose which postings a portal's cap keeps.
 *
 * The cap is a throughput bound, so it must not be spent on postings this
 * candidate cannot be hired for. Ranking (not filtering) is deliberate: a board
 * whose entire page is out of scope still contributes, just last.
 */
export function relevanceScore(job) {
  const title = cleanTitle(job?.title || "");
  if (!title) return -1000;
  let score = 0;
  if (isInScopeTitle(title)) score += 100;
  if (isEntryLevel(title)) score += 40;
  if (isExcludedSeniority(title)) score -= 120;
  if (isOffDomainTitle(title)) score -= 80;
  if (locationLooksRelevant(job?.location_raw || job?.location || job?.description)) score += 10;
  return score;
}

/**
 * Order by relevance, then take `max`. Stable for equal scores so a portal's own
 * ordering still decides ties.
 */
export function selectRelevantJobs(jobs, max) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const limit = Number.isFinite(max) && max > 0 ? max : list.length;
  return list
    .map((job, index) => ({ job, index, score: relevanceScore(job) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.job);
}
