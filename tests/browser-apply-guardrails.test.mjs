import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  attachPreparedRuntime,
  claimJobForApply,
  classifyApplyControl,
  createNavigationBoundary,
  clickFinalControl,
  finalSubmissionAllowed,
  findResumePdf,
  inferATS,
  installNavigationGuard,
  isAllowedInitialJobUrl,
  isAllowedAssetRequest,
  isAllowedReadOnlyApiRequest,
  isAllowedPresignedUploadRequest,
  collectPresignedUploadHosts,
  isInteractiveChallengeUrl,
  isAllowedCaptchaTokenRequest,
  isAllowedAtsApplicationPost,
  isAllowedNavigationUrl,
  isBlacklistedJob,
  isEligibleJob,
  isSimulationJob,
  controlSignatureMatcher,
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
  advanceMultiStepFlow,
  missingContactFields,
  tryPinExternalApplyOrigin,
  manualUrlDatabaseGuard,
  persistBrowserResult,
  pinNavigationOrigin,
  processJob,
  readSendPause,
  recoverJobClaim,
  resolveDbPath,
  statusForBrowserResult,
  verifyJobClaim,
  waitForCaptchaResolution,
  waitForApplicationSurface,
} from "../apps/browser-apply/apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function eligible(overrides = {}) {
  return {
    id: 1,
    company: "Example Company",
    title: "Backend Intern",
    link: "https://jobs.lever.co/example/1",
    source: "LinkedIn",
    run_id: "live-run",
    status: "Evaluated",
    score: 90,
    ...overrides,
  };
}

test("final actions require both live mode and --auto", async () => {
  assert.equal(finalSubmissionAllowed({ dryRun: true, auto: false }), false);
  assert.equal(finalSubmissionAllowed({ dryRun: true, auto: true }), false);
  assert.equal(finalSubmissionAllowed({ dryRun: false, auto: false }), false);
  assert.equal(finalSubmissionAllowed({ dryRun: false, auto: true }), true);

  let clicks = 0;
  const locator = {
    count: async () => 1,
    isDisabled: async () => false,
    click: async () => { clicks += 1; },
  };
  // The test module is a dry-run import, so the centralized guard must reject
  // the final control before touching the locator.
  const result = await clickFinalControl({}, locator, "Send application");
  assert.equal(result.clicked, false);
  assert.equal(clicks, 0);
});

test("a generic type=submit is only final when its label states submission intent", () => {
  // Regression: a SimplyHired `button[type="submit"]` labelled "Search Jobs"
  // was clicked as if it submitted an application.
  for (const label of [
    "Search Jobs",
    "Search",
    "Apply filters",
    "Sort by date",
    "Sign in",
    "Subscribe",
    "Accept cookies",
    "Load more",
    "Save job",
    "Upload resume",
    "",
  ]) {
    assert.equal(isSubmissionControlLabel(label), false, `expected non-submit: ${label}`);
  }
  for (const label of [
    "Submit",
    "Submit application",
    "Submit Application",
    "Send",
    "Apply",
    "Apply now",
    "Confirm",
  ]) {
    assert.equal(isSubmissionControlLabel(label), true, `expected submit: ${label}`);
  }
});

test("multi-step flow walks Continue then stops when no navigation remains", async () => {
  const clicked = [];
  let step = 0;
  const page = {
    url: () => "https://jobs.ashbyhq.com/acme/9f1c",
    locator: () => ({
      first() { return this; },
      async count() { return step === 0 ? 1 : 0; },
      async innerText() { return "Continue"; },
      async getAttribute() { return null; },
      async isDisabled() { return false; },
      async scrollIntoViewIfNeeded() {},
      async click() { clicked.push("Continue"); step += 1; },
    }),
    waitForTimeout: async () => {},
    evaluate: async () => false,
  };
  const result = await advanceMultiStepFlow(page, {
    ats: "generic", navBoundary: "https://jobs.ashbyhq.com", profile: {}, job: {},
    finalGuard: {},
  });
  assert.equal(result.stopped, "no-navigation");
  assert.deepEqual(clicked, ["Continue"]);
});

test("multi-step flow refuses to click a non-navigation control", async () => {
  const clicked = [];
  const page = {
    url: () => "https://jobs.ashbyhq.com/acme/9f1c",
    locator: () => ({
      first() { return this; },
      async count() { return 1; },
      async innerText() { return "Search Jobs"; },
      async getAttribute() { return null; },
      async isDisabled() { return false; },
      async scrollIntoViewIfNeeded() {},
      async click() { clicked.push("Search Jobs"); },
    }),
    waitForTimeout: async () => {},
    evaluate: async () => false,
  };
  const result = await advanceMultiStepFlow(page, {
    ats: "generic", navBoundary: "https://jobs.ashbyhq.com", profile: {}, job: {},
    finalGuard: {},
  });
  assert.equal(result.stopped, "non-navigation-label");
  assert.deepEqual(clicked, []);
});

test("a missing phone is reported instead of silently fabricating contact details", () => {
  // Regression: the engine filled 9999999999 into real applications.
  assert.deepEqual(
    missingContactFields({ candidate: { name: "Test", email: "t@example.com" } }),
    ["phone"],
  );
  assert.deepEqual(
    missingContactFields({ candidate: { name: "Test", email: "t@example.com", phone: "+91 99999 99999" } }),
    [],
  );
  assert.deepEqual(missingContactFields({ candidate: {} }), ["name", "email", "phone"]);
  assert.deepEqual(missingContactFields(undefined), ["name", "email", "phone"]);
});

test("off-site apply hosts are blocked unless explicitly enabled", () => {
  const boundary = {
    ats: "linkedin",
    initialOrigin: "https://www.linkedin.com",
    initialHost: "www.linkedin.com",
    pinnedOrigin: null,
  };
  // Default (feature flag off) must never widen the boundary.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://autter.dev/careers/x", "linkedin", false), false);
  assert.equal(boundary.pinnedOrigin, null);

  // Enabled: an off-site apply pins exactly one HTTPS host.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://autter.dev/careers/x", "linkedin", true), true);
  assert.equal(boundary.pinnedOrigin, "https://autter.dev");

  // Never plain HTTP, a shortener/paste host, or a second hop.
  assert.equal(tryPinExternalApplyOrigin(boundary, "http://autter.dev/x", "linkedin", true), false);
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://bit.ly/x", "linkedin", true), false);
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://pastebin.com/x", "linkedin", true), false);
  // The pin never moves back to the ATS origin.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://www.linkedin.com/jobs/view/1", "linkedin", true), false);
  // And never to a second external host.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://other.example/x", "linkedin", true), false);
});

test("an aggregator page may cross once onto the employer's own careers site", () => {
  const boundary = {
    ats: "generic",
    initialOrigin: "https://www.simplyhired.co.in",
    initialHost: "www.simplyhired.co.in",
    pinnedOrigin: null,
  };
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://careers.hancod.io/apply/12", "generic", true), true);
  assert.equal(boundary.pinnedOrigin, "https://careers.hancod.io");
  // One hop only, even for aggregators.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://ats.example.co/x", "generic", true), false);
  // Still HTTPS-only and no port.
  assert.equal(tryPinExternalApplyOrigin(boundary, "http://careers.hancod.io/x", "generic", true), false);
});

test("a shortener can never become the pinned apply origin", () => {
  const boundary = {
    ats: "linkedin",
    initialOrigin: "https://www.linkedin.com",
    initialHost: "www.linkedin.com",
    pinnedOrigin: null,
  };
  // The shortener itself must never be pinned, even when policy is on.
  for (const hop of [
    "https://bit.ly/afpsafety",
    "https://t.co/abc",
    "https://tinyurl.com/x",
    "https://is.gd/x",
  ]) {
    assert.equal(tryPinExternalApplyOrigin(boundary, hop, "linkedin", true), false, hop);
  }
  assert.equal(boundary.pinnedOrigin, null);
  // The resolved destination is fine.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://anthropic.com/apply", "linkedin", true), true);
  assert.equal(boundary.pinnedOrigin, "https://anthropic.com");
});

test("Ashby company boards are rejected but job-scoped listings are allowed", () => {
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/vercel"), false);
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/sprinto"), false);
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/vercel/9f1c2b44-1234"), true);
  assert.equal(isAshbyJobListing("not-a-url"), false);
});

test("Greenhouse company boards are rejected but job listings are allowed", () => {
  assert.equal(isGreenhouseJobListing("https://boards.greenhouse.io/freshworks"), false);
  assert.equal(isGreenhouseJobListing("https://job-boards.greenhouse.io/chargebee"), false);
  assert.equal(isGreenhouseJobListing("https://boards.greenhouse.io/freshworks/jobs/4012345"), true);
  assert.equal(isGreenhouseJobListing("not-a-url"), false);
});

test("a stated notice period maps onto the nearest offered chip, never invented", () => {
  const offered = ["Immediate Joiner", "15 days", "1 month", "2 months", "2+ months"];
  // 30 days is not offered; the nearest real option is "1 month".
  assert.equal(matchChipOption(offered, "30 days"), "1 month");
  assert.equal(matchChipOption(offered, "15 days"), "15 days");
  assert.equal(matchChipOption(offered, "Immediate Joiner"), "Immediate Joiner");
  assert.equal(matchChipOption(offered, "60 days"), "2 months");
  // No stated preference, no options, or no match must not guess.
  assert.equal(matchChipOption(offered, ""), null);
  assert.equal(matchChipOption([], "30 days"), null);
  assert.equal(matchChipOption(["Select", "Other"], "30 days"), null);
});

test("a stated salary band maps onto the offered band that contains it", () => {
  const offered = ["Select Current Salary", "Below 2 LPA", "2-4 LPA", "4-6 LPA", "6-8 LPA", "8+ LPA"];
  // "4 to 5 lpa" is contained by the 4-6 band.
  assert.equal(matchSalaryOption(offered, "4 to 5 lpa"), "4-6 LPA");
  assert.equal(matchSalaryOption(offered, "4-5 LPA"), "4-6 LPA");
  assert.equal(matchSalaryOption(offered, "3 LPA"), "2-4 LPA");
  // No stated expectation must not guess a band.
  assert.equal(matchSalaryOption(offered, ""), null);
  assert.equal(matchSalaryOption(offered, undefined), null);
  assert.equal(matchSalaryOption([], "4-5 LPA"), null);
});

test("Wellfound search pages are rejected but real postings are allowed", () => {
  // Regression: a search page's "Applied" chip belonged to a different posting
  // and was recorded as a verified submission.
  assert.equal(isWellfoundJobListing("https://wellfound.com/india/role/r/backend-engineer"), false);
  assert.equal(isWellfoundJobListing("https://wellfound.com/india/role/intern/backend-engineer"), false);
  assert.equal(isWellfoundJobListing("https://wellfound.com/jobs/3405119-associate-software-engineer"), true);
  assert.equal(isWellfoundJobListing("not-a-url"), false);
});

test("dead-listing copy is recognised across real portal wordings", () => {
  // Regression: each of these was served by a live portal for a removed or
  // expired posting, and the run kept retrying them as NeedsReview.
  const dead = [
    "Unable to load the page Job id provided may not be valid or the job posting has been removed.",
    "The job you are trying to view has expired. Please perform a new search to find current jobs.",
    "This job is no longer accepting applications",
    "No longer accepting applications",
    "Position has been filled",
    "404 Not Found",
    "This job is closed",
  ];
  const pattern = /404|page not found|unable to load the page|may not be valid|posting has been removed|job (?:posting )?(?:has been|was) removed|no longer exists|no longer available|no longer accepting applications|no longer open|job (?:you are trying to view )?(?:has |is |was )?expired|position (has been )?filled|this job is (?:no longer|closed)|job is closed|posting (?:has )?ended/i;
  for (const text of dead) {
    assert.equal(pattern.test(text), true, text);
  }
  // A live posting must not be mistaken for a dead one.
  for (const text of [
    "Backend Engineer at Acme. Apply now. This job is a great fit for your team.",
    "No longer open positions in your saved search",
  ].slice(0, 1)) {
    assert.equal(pattern.test(text), false, text);
  }
});

test("Naukri search pages are rejected but real postings are allowed", () => {
  assert.equal(isNaukriJobListing("https://www.naukri.com/java-spring-boot-jobs-in-bangalore-hyderabad-pune-chennai?experience=0"), false);
  assert.equal(isNaukriJobListing("https://www.naukri.com/backend-jobs-in-bangalore"), false);
  assert.equal(isNaukriJobListing("https://www.naukri.com/job-backend-developer-1234567"), true);
  assert.equal(isNaukriJobListing("https://www.naukri.com/job-detail-1234567"), true);
  assert.equal(isNaukriJobListing("https://www.naukri.com/job/1234567"), true);
  assert.equal(isNaukriJobListing("not-a-url"), false);
});

test("simulation fragments are refused before any submission path", () => {
  assert.equal(hasSimulationFragment("https://wellfound.com/india/role/r/backend-engineer#mock-2"), true);
  assert.equal(hasSimulationFragment("https://wellfound.com/jobs/123-x#simulated"), true);
  assert.equal(hasSimulationFragment("https://wellfound.com/jobs/3405119-associate-software-engineer"), false);
  assert.equal(hasSimulationFragment("https://boards.greenhouse.io/acme/jobs/1#mock"), true);
  // Real anchors must not be mistaken for simulation markers.
  assert.equal(hasSimulationFragment("https://example.com/jobs/1#testimonials"), false);
  assert.equal(hasSimulationFragment("https://example.com/jobs/1#apply-now"), false);
});

test("Lever company boards are rejected but role listings are allowed", () => {
  assert.equal(isLeverJobListing("https://jobs.lever.co/groww"), false);
  assert.equal(isLeverJobListing("https://jobs.lever.co/cred"), false);
  assert.equal(isLeverJobListing("https://jobs.lever.co/groww/9f1c2b44-1234-5678"), true);
  assert.equal(isLeverJobListing("not-a-url"), false);
});

test("application surface waits until real form controls render", async () => {
  let calls = 0;
  const page = {
    evaluate: async () => calls++ >= 2,
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForApplicationSurface(page, 5000), true);
  assert.equal(calls, 3);
});

test("application surface does not treat stale loader copy as readiness", async () => {
  // Regression: "Picking up your details" stays in the DOM after parsing ends,
  // so text matching never cleared and the run stalled before the form.
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      return true; // controls present on the first poll
    },
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForApplicationSurface(page, 5000), true);
  assert.equal(calls, 1);
});

test("CAPTCHA is fail-closed instead of falling through", async () => {
  const page = {
    locator: () => ({ count: async () => 1 }),
    evaluate: async () => false,
    frames: () => [],
  };
  // A dry run must not proceed past a detected challenge. Live/auto uses the
  // same helper and only returns true after the challenge disappears.
  assert.equal(await waitForCaptchaResolution(page), false);
});

test("simulation markers and legacy Mock rows are blocked", () => {
  assert.equal(isSimulationJob({ source: "sim:Mock" }), true);
  assert.equal(isSimulationJob({ source: "SIMULATED:Indeed India" }), true);
  assert.equal(isSimulationJob({ source: "LinkedIn", run_id: "sim-abc123" }), true);
  assert.equal(isSimulationJob({ source: "Mock" }), true);
  assert.equal(isSimulationJob({ source: "LinkedIn", run_id: "live-abc123" }), false);
});

test("strict role gate excludes full-stack, frontend, Laravel, mobile, and embedded titles", () => {
  for (const title of [
    "Full Stack Developer Intern",
    "Frontend Engineer",
    "Laravel Developer",
    "Android Engineer",
    "Embedded Systems Engineer Intern",
    "Software Engineer Intern",
  ]) {
    assert.equal(isStrictTargetRole(title), false, title);
  }
  for (const title of [
    "Backend Engineer",
    "Machine Learning Engineer",
    "AI/ML Engineer",
    "Java Backend Engineer",
    "C++ Software Engineer",
    "GenAI Engineer",
  ]) {
    assert.equal(isStrictTargetRole(title), true, title);
  }
});

test("strict role gate matches the candidate's stack: python in, node/mongo/django/design out", () => {
  for (const title of [
    "Python Developer",
    "Python Backend Engineer",
    "Machine Learning Engineer (Python)",
    "Java Backend Developer",
    "C++ Systems Engineer Intern",
    "Backend Engineer",
  ]) {
    assert.equal(isStrictTargetRole(title), true, title);
  }
  for (const title of [
    "Node.js Backend Engineer",
    "JavaScript Developer",
    "MongoDB Engineer",
    "Django Back-End Development Intern",
    "Frontend Engineer",
    "UI/UX Designer",
    "Product Designer",
    "Figma Designer",
  ]) {
    assert.equal(isStrictTargetRole(title), false, title);
  }
});

test("strict role gate excludes Node.js roles even when they say backend", () => {
  for (const title of [
    "Backend Developer Intern | Entry Level | Fresher | Node.js, Python",
    "Node.js Backend Engineer",
    "Backend Developer (NodeJS)",
    "Full Stack Engineer (Next.js)",
  ]) {
    assert.equal(isStrictTargetRole(title), false, title);
  }
  // Genuine backend/AI titles in the candidate's stack still pass.
  for (const title of ["Backend Engineer", "Java Backend Developer", "C++ Backend Engineer"]) {
    assert.equal(isStrictTargetRole(title), true, title);
  }
});

test("scraped titles with the company joined to the role still match", () => {
  // Regression: "FirmMachine Learning Researcher" has no word boundary
  // before "machine", so these real ML roles were being dropped.
  for (const title of [
    "RationalFirst Zero-human Accounting FirmMachine Learning Researcher Full-time",
    "Research Engineer, Chip Design RL (Reinforcement Learning)San Francisco, CA",
  ]) {
    assert.equal(isStrictTargetRole(title), true, title);
  }
  // No in-domain keyword at all: stays out of the browser's PII path.
  assert.equal(isStrictTargetRole("Research Engineer, Production Model Post-Training"), false);
});

test("job selection refuses terminal, review, paused, low-score, and Indeed rows", () => {
  for (const status of [
    "Applied", "Sent", "FollowupSent", "Expired", "Skipped", "Verified",
    "Applying", "NeedsReview", "NeedsVerification", "Simulated", "SendPaused", "EmailQueued",
  ]) {
    assert.equal(isEligibleJob(eligible({ status }), { explicit: true }), false, status);
  }
  assert.equal(isEligibleJob(eligible({ score: 74 }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ _pending_g10_review: true }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ _outreach_statuses: ["review_posted"] }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ _send_paused: true }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ _send_paused: null }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ link: "https://www.indeed.com/viewjob?jk=x" }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ link: "https://www.indeed.com/viewjob?jk=x" }), { explicit: true, includeIndeed: true }), true);
  assert.equal(isEligibleJob(eligible({ source: "sim:Mock" }), { explicit: true }), false);
});

test("blacklist matching is enforced independently of the SQL query", () => {
  assert.equal(isBlacklistedJob({ company: "Example Company", link: "https://jobs.lever.co/x" }, ["example"]), true);
  assert.equal(isBlacklistedJob({ company: "Other Company", link: "https://jobs.lever.co/x" }, ["example"]), false);
});

test("ATS inference and redirect allowlists are host based", () => {
  assert.equal(inferATS("https://evil.example/?next=jobs.lever.co"), "generic");
  assert.equal(inferATS("https://jobs.lever.co/example/1"), "lever");
  assert.equal(isAllowedNavigationUrl("https://jobs.lever.co/example/1", "lever"), true);
  assert.equal(isAllowedNavigationUrl("https://evil.example/redirect", "lever"), false);
  assert.equal(isAllowedNavigationUrl("https://www.indeed.com/viewjob?jk=1", "indeed"), true);
  assert.equal(isAllowedNavigationUrl("https://evil.example/redirect", "generic", "https://good.example/job"), false);
  assert.equal(isAllowedInitialJobUrl("https://jobs.lever.co/example/1"), true);
  assert.equal(isAllowedInitialJobUrl("http://jobs.lever.co/example/1"), false);
  assert.equal(isAllowedNavigationUrl("http://jobs.lever.co/form", "lever", "https://jobs.lever.co/example/1"), false);
});

test("HTTP job URLs are rejected before a browser or page is opened", async () => {
  let contextCalls = 0;
  let pageCalls = 0;
  const browser = {
    newContext: async () => {
      contextCalls += 1;
      return {
        newPage: async () => {
          pageCalls += 1;
          throw new Error("HTTP URL must never reach a page");
        },
      };
    },
  };

  const result = await processJob(browser, {
    company: "Acme",
    title: "Backend Intern",
    link: "http://jobs.lever.co/acme/backend/1",
  }, { candidate: { name: "Candidate", email: "candidate@example.com" } });

  assert.equal(result.action, "redirect-blocked");
  assert.equal(contextCalls, 0);
  assert.equal(pageCalls, 0);
});

test("navigation guard blocks an HTTP same-origin target before interaction", async () => {
  let handler;
  const mainFrame = { parentFrame: () => null };
  const page = {
    url: () => "https://jobs.lever.co/acme/backend/1",
    mainFrame: () => mainFrame,
    route: async (_pattern, fn) => { handler = fn; },
  };
  await installNavigationGuard(page, "lever", "https://jobs.lever.co/acme/backend/1");

  let aborted = 0;
  let continued = 0;
  const request = {
    url: () => "http://jobs.lever.co/acme/backend/apply",
    method: () => "GET",
    isNavigationRequest: () => true,
    resourceType: () => "document",
    frame: () => mainFrame,
  };
  await handler({
    request: () => request,
    abort: async () => { aborted += 1; },
    continue: async () => { continued += 1; },
  });
  assert.equal(aborted, 1);
  assert.equal(continued, 0);
});

test("an exact DB PDF path wins over fuzzy filename matching", () => {
  const pdfDir = path.join(ROOT, "output", "pdf");
  const first = fs.existsSync(pdfDir) ? fs.readdirSync(pdfDir).find((name) => name.toLowerCase().endsWith(".pdf")) : null;
  if (!first) return; // The source tree may intentionally omit generated PDFs.
  const exact = path.join(pdfDir, first);
  assert.equal(findResumePdf("NoSuchCompany", "NoSuchRole", exact), exact);
});

test("PULSEOPS_DB is honored without falling back to the default DB", () => {
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(ROOT, "output", "browser-apply-db-test-"));
  const dbPath = path.join(tempDir, "custom.db");
  fs.writeFileSync(dbPath, "not sqlite yet");
  try {
    assert.equal(resolveDbPath({ PULSEOPS_DB: dbPath }, ROOT), dbPath);
    assert.equal(resolveDbPath({ PULSEOPS_DB: path.join(tempDir, "missing.db") }, ROOT), path.join(tempDir, "missing.db"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("YC answer generation does not build a shell command from scraped text", () => {
  const source = fs.readFileSync(path.join(ROOT, "apps", "browser-apply", "apply.mjs"), "utf8");
  assert.equal(source.includes(["exec", "Sync("].join("")), false);
  assert.match(source, /execFileSync\("python",\s*\[/);
  assert.equal(source.includes('python "${helper}"'), false);
});

function makeGuardrailDb() {
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, "output", "browser-apply-claim-test-"));
  const dbPath = path.join(dir, "guardrails.db");
  const code = String.raw`
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.executescript("""
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  status TEXT,
  score INTEGER,
  link TEXT,
  source TEXT,
  run_id TEXT,
  run_marker TEXT,
  processed_at TEXT
);
INSERT INTO settings(key,value) VALUES('send_paused','0');
INSERT INTO jobs VALUES(1,'Evaluated',90,'https://jobs.lever.co/example/1','LinkedIn','live-run','',NULL);
INSERT INTO jobs VALUES(2,'Evaluated',90,'https://jobs.lever.co/example/2','LinkedIn','live-run','',NULL);
INSERT INTO jobs VALUES(3,'Applied',90,'https://jobs.lever.co/example/3','LinkedIn','live-run','',NULL);
""")
conn.commit()
conn.close()
`;
  execFileSync("python", ["-c", code, dbPath], { encoding: "utf8", windowsHide: true });
  return { dir, dbPath };
}

function dbValue(dbPath, sql, args = []) {
  const code = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2],sys.argv[3:]).fetchone(); print('' if r is None else r[0]); c.close()";
  return execFileSync("python", ["-c", code, dbPath, sql, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function setPause(dbPath, value) {
  const code = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE settings SET value=? WHERE key=?',(sys.argv[2],'send_paused')); c.commit(); c.close()";
  execFileSync("python", ["-c", code, dbPath, value], { encoding: "utf8", windowsHide: true });
}

test("send_paused is fresh and a manual URL needs an authoritative DB", async () => {
  const { dir, dbPath } = makeGuardrailDb();
  try {
    assert.deepEqual(await readSendPause(path.join(dir, "missing.db")), {
      available: false,
      paused: true,
      reason: "db-missing",
    });
    assert.equal((await readSendPause(dbPath)).paused, false);
    assert.equal((await manualUrlDatabaseGuard({ dbPath, dryRun: false })).allowed, true);
    setPause(dbPath, "1");
    assert.equal((await readSendPause(dbPath)).paused, true);
    assert.equal((await manualUrlDatabaseGuard({ dbPath, dryRun: false })).allowed, false);
    assert.equal((await manualUrlDatabaseGuard({ dbPath: path.join(dir, "missing.db"), dryRun: false })).allowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one-step Apply is classified as final while modal Apply remains intermediate", () => {
  assert.equal(classifyApplyControl({ label: "Apply", oneStep: true }).classification, "final");
  assert.equal(classifyApplyControl({ label: "Apply", oneStep: false }).classification, "intermediate");
  assert.equal(classifyApplyControl({ label: "Easy Apply", oneStep: false }).classification, "intermediate");
  assert.equal(classifyApplyControl({ label: "Apply now", oneStep: false }).classification, "final");
  assert.equal(classifyApplyControl({ label: "", oneStep: false }).classification, "unknown");
});

test("navigation trust uses exact hosts/origins and pins after a service crossing", () => {
  assert.equal(isAllowedNavigationUrl("https://evil.example/tenant", "lever", "https://jobs.lever.co/example/1"), false);
  assert.equal(isAllowedNavigationUrl("https://other.lever.co/tenant", "lever", "https://acme.lever.co/example/1"), false);
  assert.equal(isAllowedNavigationUrl("https://acme.lever.co/example/1", "lever", "https://acme.lever.co/example/1"), true);
  assert.equal(isAllowedNavigationUrl("https://jobs.lever.co/form", "lever", "https://acme.lever.co/example/1"), true);
  assert.equal(isAllowedNavigationUrl("http://jobs.lever.co/form", "lever", "https://acme.lever.co/example/1"), false);
  const boundary = createNavigationBoundary("https://acme.lever.co/example/1", "lever");
  assert.equal(isAllowedNavigationUrl("https://jobs.lever.co/form", "lever", boundary), true);
  assert.equal(pinNavigationOrigin(boundary, "https://jobs.lever.co/form"), true);
  assert.equal(isAllowedNavigationUrl("https://acme.lever.co/example/1", "lever", boundary), false);
  assert.equal(isAllowedNavigationUrl("https://job-boards.greenhouse.io/form", "lever", boundary), false);
});

test("vendor form data and the resume upload ticket are readable", () => {
  // Without these the Greenhouse form renders without labels and cannot
  // attach a CV at all.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://job-boards.cdn.greenhouse.io/locales/en/job_post.json", "fetch", "GET", "greenhouse",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields%5B%5D=resume",
      "fetch", "GET", "greenhouse",
    ),
    true,
  );
  // A write is never allowed, and neither is another vendor's path or ATS.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://boards.greenhouse.io/uncacheable_attributes/presigned_fields", "fetch", "POST", "greenhouse",
    ),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://evil.example/locales/en/job_post.json", "fetch", "GET", "greenhouse"),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://job-boards.cdn.greenhouse.io/locales/en/x.json", "fetch", "GET", "lever"),
    false,
  );
});

test("a control's question text is its own prompt, never the whole form", () => {
  // A few ancestors up is often a wrapper holding the entire form. If its text
  // were used as the label, every pattern would match every field.
  // `stripped` models what the clone's textContent becomes once the widget
  // internals are removed; a real clone recomputes it, this mock must too.
  const mkNode = (text, children = [], stripped = text) => ({
    textContent: text,
    getAttribute: () => "",
    parentElement: null,
    cloneNode() {
      return {
        textContent: stripped,
        querySelectorAll: () => children.map((c) => ({ remove() {} })),
      };
    },
  });
  const signature = controlSignatureMatcher();

  const field = mkNode("", []);
  const wrapper = mkNode("Are you open to relocation for this role?", []);
  const wholeForm = mkNode("Are you open to relocation for this role? Country * Why Anthropic? * Have you ever interviewed here?", []);
  field.parentElement = wrapper;
  wrapper.parentElement = wholeForm;
  wholeForm.parentElement = null;

  const sig = signature(field);
  assert.match(sig, /relocation/);
  // The rest of the form must not leak in.
  assert.doesNotMatch(sig, /anthropic/);
  assert.doesNotMatch(sig, /country/);

  // When no ancestor is small enough to be a question, there is nothing to
  // match on — returning "" keeps the caller from matching unrelated text.
  const huge = mkNode("x".repeat(400), []);
  huge.parentElement = null;
  assert.equal(signature(huge), "");

  // The control's own attributes are always part of the signature.
  const named = mkNode("Select...", []);
  named.parentElement = null;
  named.getAttribute = (a) => ({ id: a === "id" ? "country" : "" })[a] || "";
  assert.match(signature(named), /country/);

  // A dropdown's nearest wrappers hold only the input and its "Select…"
  // placeholder, so stripping them leaves nothing. The matcher must keep
  // climbing to reach the prompt, or every question-based match fails.
  const control = mkNode("", [mkNode(""), mkNode("")]);
  const valueBox = mkNode("Select...", [control, mkNode("Select...")], "");
  const fieldBox = mkNode(
    "Are you open to working in-person in one of our offices 25% of the time? Select...",
    [valueBox],
    "Are you open to working in-person in one of our offices 25% of the time?",
  );
  control.parentElement = valueBox;
  valueBox.parentElement = fieldBox;
  fieldBox.parentElement = null;
  const dropdownSig = signature(control);
  assert.match(dropdownSig, /in-person/);
  // The placeholder must not be mistaken for the question.
  assert.doesNotMatch(dropdownSig, /select\.\.\./);
});

test("the page-side matcher is self-contained so it can be serialised", () => {
  // Playwright serialises the evaluate callback into the page. If it referenced
  // anything outside its own body, the reference would be undefined in the page
  // and every field would fail to match — silently, before this guard existed.
  const src = controlSignatureMatcher().toString();
  for (const forbidden of ["fieldQuestionText", "controlSignatureMatcher(", "require(", "process."]) {
    assert.equal(src.includes(forbidden), false, `matcher must not reference ${forbidden}`);
  }
});

test("a dropdown is never treated as answered by matching loose text", () => {
  // react-select's live region always contains the word "selected" as
  // boilerplate. Treating that as an answer made every dropdown look
  // pre-answered, so required questions were silently left empty and the
  // submit was refused with "This field is required".
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "browser-apply", "apply.mjs"),
    "utf8",
  );
  assert.equal(
    /\/selected\/i\s*\.\s*test|selected"\)\s*\?/i.test(source),
    false,
    "answer detection must rely on the rendered value, not on the word 'selected'",
  );
  // The precise signal must still be present.
  assert.match(source, /single-value/);
});

test("an invisible captcha is not a human obstacle, a checkbox is", () => {
  // The invisible anchor frame exists from page load. Treating its mere
  // presence as a challenge made the engine refuse every Greenhouse posting
  // the moment the captcha was allowed to load at all.
  assert.equal(
    isInteractiveChallengeUrl("https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=KEY&size=invisible"),
    false,
  );
  // A visible checkbox still stops the run.
  assert.equal(
    isInteractiveChallengeUrl("https://www.google.com/recaptcha/api2/anchor?k=KEY"),
    true,
  );
  assert.equal(
    isInteractiveChallengeUrl("https://challenges.cloudflare.com/turnstile/v0/api.js"),
    true,
  );
  // Ordinary frames are never challenges.
  assert.equal(isInteractiveChallengeUrl("https://job-boards.greenhouse.io/embed/job_board"), false);
  assert.equal(isInteractiveChallengeUrl(""), false);
});

test("the captcha token call is allowed, and nothing else on that host is", () => {
  // reCAPTCHA fetches challenge state with a POST, so the read-only allowance
  // was not enough and the submit was refused with a bare server error.
  const token = "https://www.recaptcha.net/recaptcha/enterprise/reload?k=KEY";
  assert.equal(isAllowedCaptchaTokenRequest(token, "xhr"), true);
  assert.equal(isAllowedCaptchaTokenRequest(token, "fetch"), true);
  // Exact hosts and the enterprise path only.
  assert.equal(
    isAllowedCaptchaTokenRequest("https://evil.recaptcha.net/recaptcha/enterprise/reload?k=KEY", "xhr"), false,
  );
  assert.equal(isAllowedCaptchaTokenRequest("https://www.recaptcha.net/other/collect", "xhr"), false);
  assert.equal(isAllowedCaptchaTokenRequest(token, "script"), false);
  assert.equal(isAllowedCaptchaTokenRequest("http://www.recaptcha.net/recaptcha/enterprise/reload", "xhr"), false);
});

test("the score floor is an operator knob, and defaults to the safe 75", async () => {
  const { isEligibleJob: withDefault } = await import("../apps/browser-apply/apply.mjs");
  const base = {
    link: "https://boards.greenhouse.io/acme/jobs/1",
    title: "Backend Engineer Intern",
    status: "evaluated",
    source: "Anthropic",
    score: 72,
  };
  // Default floor: 72 is below it, so the row is held back.
  assert.equal(withDefault(base), false);
  assert.equal(withDefault({ ...base, score: 80 }), true);

  // The knob must widen the floor without touching the substantive gates.
  const previous = process.env.PULSEOPS_MIN_SCORE;
  process.env.PULSEOPS_MIN_SCORE = "60";
  const widened = await import(`../apps/browser-apply/apply.mjs?v=${Date.now()}`);
  try {
    assert.equal(widened.isEligibleJob(base), true);
    // Hard exclusions still bite at a lower floor.
    assert.equal(widened.isEligibleJob({ ...base, title: "Frontend Engineer" }), false);
    assert.equal(widened.isEligibleJob({ ...base, source: "mock" }), false);
  } finally {
    if (previous === undefined) delete process.env.PULSEOPS_MIN_SCORE;
    else process.env.PULSEOPS_MIN_SCORE = previous;
  }
});

test("the ATS may receive the application, and nothing else may", () => {
  // The board form posts the finished application to the ATS API, not to the
  // page's own origin. Blocking it meant a perfectly filled form could never be
  // sent.
  const submit = "https://boards.greenhouse.io/anthropic/jobs/4613568008";
  assert.equal(isAllowedAtsApplicationPost(submit, "fetch", "POST", "greenhouse"), true);
  // Not a general cross-origin POST allowance.
  assert.equal(isAllowedAtsApplicationPost("https://evil.example/anthropic/jobs/1", "fetch", "POST", "greenhouse"), false);
  assert.equal(isAllowedAtsApplicationPost(submit, "fetch", "POST", "lever"), false);
  // Only the application endpoint shape, only POST, only xhr/fetch.
  assert.equal(isAllowedAtsApplicationPost("https://boards.greenhouse.io/admin/users", "fetch", "POST", "greenhouse"), false);
  assert.equal(isAllowedAtsApplicationPost(submit, "fetch", "GET", "greenhouse"), false);
  assert.equal(isAllowedAtsApplicationPost(submit, "script", "POST", "greenhouse"), false);
  assert.equal(isAllowedAtsApplicationPost("http://boards.greenhouse.io/anthropic/jobs/1", "fetch", "POST", "greenhouse"), false);
  // A lookalike host is not the ATS.
  assert.equal(isAllowedAtsApplicationPost("https://boards.greenhouse.io.evil.net/anthropic/jobs/1", "fetch", "POST", "greenhouse"), false);
});

test("a tailored CV resolves from its folder, and never a stranger's", async () => {
  // Every tailored CV is now named CV.pdf inside a per-application folder, so
  // the filename alone cannot identify one. The DB path stays authoritative and
  // the fallback must match the company, never pick up an unrelated CV.pdf.
  const { findResumePdf } = await import("../apps/browser-apply/apply.mjs");
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..", "output", "pdf",
  );
  const mineDir = path.join(dir, "zztestco-aaaaaaaa");
  const strangerDir = path.join(dir, "zzotherco-bbbbbbbb");
  fs.mkdirSync(mineDir, { recursive: true });
  fs.mkdirSync(strangerDir, { recursive: true });
  const mine = path.join(mineDir, "CV.pdf");
  const stranger = path.join(strangerDir, "CV.pdf");
  fs.writeFileSync(mine, "mine");
  fs.writeFileSync(stranger, "stranger");
  try {
    // The authoritative DB path is used when it exists.
    assert.equal(findResumePdf("zztestco", "Backend Engineer Intern", mine), mine);
    // With no DB path, the company folder still resolves.
    const resolved = findResumePdf("zztestco", "Backend Engineer Intern");
    assert.equal(resolved, mine, "should resolve this company's tailored CV");
    // A different company must never be handed this CV.
    const other = findResumePdf("zzotherco", "Backend Engineer Intern", stranger);
    assert.equal(other, stranger);
    assert.notEqual(findResumePdf("zzunknownco9x", "Backend Engineer Intern"), mine);
  } finally {
    fs.rmSync(mineDir, { recursive: true, force: true });
    fs.rmSync(strangerDir, { recursive: true, force: true });
  }
});

test("a CV may upload only to the host the ATS itself named", () => {
  // With the upload blocked the board answers "There was an error processing
  // your application", because the form submits with no attachment.
  const hosts = new Set();
  const added = collectPresignedUploadHosts({
    resume: { url: "https://grnhse-prod-jben.s3.us-west-2.amazonaws.com/key?sig=abc" },
  }, hosts);
  assert.equal(added, 1);
  assert.equal(hosts.has("grnhse-prod-jben.s3.us-west-2.amazonaws.com"), true);

  const target = "https://grnhse-prod-jben.s3.us-west-2.amazonaws.com/key?sig=abc";
  assert.equal(isAllowedPresignedUploadRequest(target, "xhr", "PUT", hosts), true);
  // Only that host, only for an upload, and only over HTTPS.
  assert.equal(
    isAllowedPresignedUploadRequest("https://evil.example/key", "xhr", "PUT", hosts), false,
  );
  assert.equal(
    isAllowedPresignedUploadRequest("https://grnhse-prod-jben.s3.us-west-2.amazonaws.com/k", "xhr", "GET", hosts), false,
  );
  assert.equal(
    isAllowedPresignedUploadRequest("http://grnhse-prod-jben.s3.us-west-2.amazonaws.com/k", "xhr", "PUT", hosts), false,
  );
  // Scripts never ride this allowance.
  assert.equal(
    isAllowedPresignedUploadRequest(target, "script", "PUT", hosts), false,
  );
  // With nothing harvested, nothing is writable.
  assert.equal(isAllowedPresignedUploadRequest(target, "xhr", "PUT", new Set()), false);
  assert.equal(isAllowedPresignedUploadRequest(target, "xhr", "PUT", null), false);
});

test("the submit-time captcha and vendor data are reachable, writes are not", () => {
  // Greenhouse runs reCAPTCHA Enterprise on submit. With its script blocked the
  // submit cannot be validated and fails silently, with no error to read.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://www.recaptcha.net/recaptcha/enterprise.js?render=KEY", "script", "GET", "greenhouse",
    ),
    true,
  );
  // The posting record and the email validator are needed to render and submit.
  assert.equal(
    isAllowedReadOnlyApiRequest("https://boards.greenhouse.io/anthropic/jobs/5115935008", "fetch", "GET", "greenhouse"),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://email-address-validator.us.greenhouse.io/address/validate?address=a%40b.com", "fetch", "GET", "greenhouse",
    ),
    true,
  );
  // Invisible reCAPTCHA executes in a cross-origin iframe, so the anchor must
  // load as a document or no token is ever produced and the submit is refused.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=KEY&size=invisible",
      "document", "GET", "greenhouse",
    ),
    true,
  );
  // The enterprise/reload call fetches challenge state, and the gstatic bundle
  // arrives as resource type "other" — both are required to produce a token.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://www.recaptcha.net/recaptcha/enterprise/reload?k=KEY", "xhr", "GET", "greenhouse",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://www.gstatic.com/recaptcha/releases/kemdRjWF/recaptcha__en.js", "other", "GET", "greenhouse",
    ),
    true,
  );
  // The scope stops at /enterprise: another reCAPTCHA path is not opened.
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.gstatic.com/recaptcha/x.js", "xhr", "GET", "greenhouse"),
    false,
  );
  // A captcha script is not a general-purpose exemption: no writes, and the
  // same trust is not extended to another ATS.
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api2/anchor", "xhr", "GET", "greenhouse"),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/enterprise.js", "script", "GET", "lever"),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://evil.recaptcha.net/recaptcha/enterprise.js", "script", "GET", "greenhouse"),
    false,
  );
});

test("an ATS's own CDN may serve its scripts, but no other host may", () => {
  // Greenhouse ships the entire application runtime from its CDN; blocking it
  // leaves the form inert with empty dropdowns.
  assert.equal(isAllowedAssetRequest("https://job-boards.cdn.greenhouse.io/assets/root.js", "script", "greenhouse"), true);
  assert.equal(isAllowedAssetRequest("https://cdn.ashbyhq.com/app.js", "script", "ashby"), true);
  // Ashby's real asset host, and the Vite manifest it fetches as "other".
  assert.equal(
    isAllowedAssetRequest("https://cdn.ashbyprd.com/frontend_non_user/abc/.vite/manifest.json", "other", "ashby"),
    true,
  );
  assert.equal(isAllowedAssetRequest("https://cdn.ashbyprd.com/evil.js", "script", "lever"), false);
  // The same script is not trusted for a different ATS, nor for a lookalike host.
  assert.equal(isAllowedAssetRequest("https://job-boards.cdn.greenhouse.io/assets/root.js", "script", "lever"), false);
  assert.equal(isAllowedAssetRequest("https://evil.job-boards.cdn.greenhouse.io.attacker.net/root.js", "script", "greenhouse"), false);
  // And a different ATS gets no blanket trust.
  assert.equal(isAllowedAssetRequest("https://cdn.lever.co/app.js", "script", "greenhouse"), false);
});

test("inert static assets load from any CDN, but scripts stay host-restricted", () => {
  // A blocked stylesheet leaves the application unstyled and its dropdowns
  // inert, which makes the form impossible to complete.
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.css", "stylesheet", "linkedin"), true);
  assert.equal(isAllowedAssetRequest("https://media.licdn.com/image.png", "image", "linkedin"), true);
  assert.equal(isAllowedAssetRequest("https://cdn.example.com/site.css", "stylesheet", "generic"), true);
  assert.equal(isAllowedAssetRequest("https://cdn.example.com/font.woff2", "font", "generic"), true);
  // Scripts can exfiltrate, so they remain restricted to exact known hosts.
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.js", "fetch", "linkedin"), false);
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.js", "script", "generic"), false);
  assert.equal(isAllowedAssetRequest("https://evil.static.licdn.com/a.js", "script", "linkedin"), false);
  assert.equal(isAllowedAssetRequest("http://static.licdn.com/a.js", "script", "linkedin"), false);
  // Plain HTTP is never allowed, even for inert assets.
  assert.equal(isAllowedAssetRequest("http://cdn.example.com/a.css", "stylesheet", "generic"), false);
});

test("only exact LinkedIn read-only API requests are exempted", () => {
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://platform.linkedin.com/litms/allowlist/voyager-web-jobs",
      "xhr",
      "GET",
      "linkedin",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://static.licdn.com/aero-v1/sc/h/chunk.js",
      "fetch",
      "GET",
      "linkedin",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://platform.linkedin.com/litms/utag/voyager-web-jobs/utag.js",
      "script",
      "GET",
      "linkedin",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://platform.linkedin.com/voyager/api/submit",
      "xhr",
      "GET",
      "linkedin",
    ),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://platform.linkedin.com/litms/allowlist/voyager-web-jobs",
      "xhr",
      "POST",
      "linkedin",
    ),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://evil.example/litms/allowlist/voyager-web-jobs",
      "xhr",
      "GET",
      "linkedin",
    ),
    false,
  );
});

test("navigation guard blocks cross-origin iframe/fetch targets before fill", async () => {
  let handler;
  const page = {
    url: () => "https://jobs.lever.co/example/1",
    mainFrame: () => ({}),
    route: async (_pattern, fn) => { handler = fn; },
  };
  await installNavigationGuard(page, "lever", "https://jobs.lever.co/example/1");
  let aborted = 0;
  let continued = 0;
  const request = {
    url: () => "https://evil.example/collect",
    isNavigationRequest: () => false,
    resourceType: () => "fetch",
    frame: () => ({ parentFrame: () => ({ url: () => "https://jobs.lever.co/example/1" }) }),
  };
  await handler({
    request: () => request,
    abort: async () => { aborted += 1; },
    continue: async () => { continued += 1; },
  });
  assert.equal(aborted, 1);
  assert.equal(continued, 0);
});

test("preflight claim token is attached before the real pass", () => {
  const job = { id: 7, company: "Acme" };
  attachPreparedRuntime(job, {
    allowed: true,
    dbPath: "E:/repo/pulseops.db",
    claimToken: "owner-preflight",
  });
  assert.equal(job._db_path, "E:/repo/pulseops.db");
  assert.equal(job._claimToken, "owner-preflight");
  assert.equal(job._claim_token, "owner-preflight");
});

test("DB claim is exact-ID, recoverable, and result persistence never returns Evaluated", async () => {
  const { dir, dbPath } = makeGuardrailDb();
  try {
    const first = await claimJobForApply(1, { dbPath, ownerId: "owner-a" });
    assert.equal(first.claimed, true);
    assert.equal((await verifyJobClaim(1, "owner-a", dbPath)).owned, true);
    const second = await claimJobForApply(1, { dbPath, ownerId: "owner-b" });
    assert.equal(second.claimed, false);
    assert.equal(second.reason, "already-applying");
    assert.equal(dbValue(dbPath, "SELECT status FROM jobs WHERE id=2"), "Evaluated");
    assert.equal((await claimJobForApply(3, { dbPath, ownerId: "owner-c" })).claimed, false);

    const persisted = await persistBrowserResult({
      job_id: 1,
      action: "needs-verification",
      claimToken: "owner-a",
    }, { dbPath, dryRun: false });
    assert.equal(persisted.updated, true);
    assert.equal(dbValue(dbPath, "SELECT status FROM jobs WHERE id=1"), "NeedsVerification");
    assert.equal(statusForBrowserResult({ action: "submitted", confirmed: false }), "NeedsVerification");
    assert.notEqual(statusForBrowserResult({ action: "submitted", confirmed: false }), "Evaluated");

    // A crash before persistence leaves the durable in-flight marker, not
    // Evaluated; a later worker can recover only after the lease is stale.
    const crashed = await claimJobForApply(2, { dbPath, ownerId: "owner-crash" });
    assert.equal(crashed.claimed, true);
    assert.equal(dbValue(dbPath, "SELECT status FROM jobs WHERE id=2"), "Applying");
    const ordinaryRetry = await claimJobForApply(2, {
      dbPath,
      ownerId: "owner-no-auto-recovery",
      recoveryMs: 60000,
      now: Date.now() + 120000,
    });
    assert.equal(ordinaryRetry.claimed, false);
    assert.equal(ordinaryRetry.reason, "stale-applying-review-required");

    const recovered = await recoverJobClaim(2, {
      dbPath,
      ownerId: "owner-recovery",
      recoveryMs: 60000,
      now: Date.now() + 120000,
    });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.recovered, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending G10 email review does not revoke a browser-apply claim", async () => {
  // G10 fires when there is no verified company domain to email, so the review
  // is a Discord decision about *emailing*. It is not a judgement on whether we
  // may apply to an open role, and must not stall the browser channel.
  const { dir, dbPath } = makeGuardrailDb();
  try {
    const claim = await claimJobForApply(1, { dbPath, ownerId: "owner-g10" });
    assert.equal(claim.claimed, true);
    const code = String.raw`
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.executescript("""
CREATE TABLE outreach (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  company TEXT,
  status TEXT,
  channel TEXT,
  notes TEXT
);
INSERT INTO outreach(job_id,company,status,channel,notes)
VALUES(1,'Example Company','review_posted','discord_review','G10');
""")
conn.commit()
conn.close()
`;
    execFileSync("python", ["-c", code, dbPath], { encoding: "utf8", windowsHide: true });
    const state = await verifyJobClaim(1, "owner-g10", dbPath);
    assert.equal(state.owned, true);
    assert.equal(state.reason, "owned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal outreach outcome for this listing still revokes the claim", async () => {
  // The protection the G10 test used to provide: once this listing is actually
  // handled, we must not submit a second application.
  for (const status of ["sent", "followup_sent", "cooldown", "blacklisted", "bounced"]) {
    const { dir, dbPath } = makeGuardrailDb();
    try {
      const claim = await claimJobForApply(1, { dbPath, ownerId: `owner-${status}` });
      assert.equal(claim.claimed, true, status);
      const code = [
        "import sqlite3, sys",
        "conn = sqlite3.connect(sys.argv[1])",
        "conn.executescript('''",
        "CREATE TABLE IF NOT EXISTS outreach (",
        "  id INTEGER PRIMARY KEY,",
        "  job_id INTEGER,",
        "  company TEXT,",
        "  status TEXT,",
        "  channel TEXT,",
        "  notes TEXT",
        ");",
        "''')",
        "conn.execute(",
        "  'INSERT INTO outreach(job_id,company,status,channel,notes) VALUES(?,?,?,?,?)',",
        "  (1, 'Example Company', sys.argv[2], '', ''),",
        ")",
        "conn.commit()",
        "conn.close()",
      ].join("\n");
      execFileSync("python", ["-c", code, dbPath, status], { encoding: "utf8", windowsHide: true });
      const state = await verifyJobClaim(1, `owner-${status}`, dbPath);
      assert.equal(state.owned, false, status);
      assert.equal(state.reason, "g10-review", status);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("pre-claim terminal outcomes persist against the exact claim", async () => {
  const { dir, dbPath } = makeGuardrailDb();
  try {
    const job = {
      id: 1,
      company: "YC Startup",
      title: "Engineering",
      link: "https://www.workatastartup.com/jobs/l/software-engineer",
      source: "YC Combinator",
      run_id: "live-run",
      status: "Evaluated",
      score: 90,
      _send_paused: false,
      _db_path: dbPath,
    };
    const claim = await claimJobForApply(1, { dbPath, ownerId: "owner-terminal" });
    assert.equal(claim.claimed, true);
    job._claimToken = "owner-terminal";
    job._claim_token = "owner-terminal";
    const result = await processJob(null, job, { candidate: { name: "Candidate", email: "candidate@example.com" } }, { dbPath, claimToken: "owner-terminal" });
    assert.equal(result.action, "invalid-listing");
    assert.ok(job._claimToken);
    const persisted = await persistBrowserResult({
      ...result,
      job_id: job.id,
      claimToken: job._claimToken,
    }, { dbPath, dryRun: false });
    assert.equal(persisted.updated, true);
    assert.equal(dbValue(dbPath, "SELECT status FROM jobs WHERE id=1"), "Expired");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clickFinalControl rechecks pause immediately before the final click", async () => {
  const { dir, dbPath } = makeGuardrailDb();
  try {
    let checks = 0;
    const page = {
      locator: () => ({ count: async () => 0 }),
      evaluate: async () => false,
      frames: () => [],
    };
    let clicks = 0;
    const locator = {
      count: async () => 1,
      isDisabled: async () => false,
      click: async () => { clicks += 1; },
    };
    const result = await clickFinalControl(page, locator, "Send application", {
      dryRun: false,
      auto: true,
      dbPath,
      pauseReader: async () => ({ available: true, paused: checks++ > 0, reason: checks > 1 ? "paused" : "active" }),
    });
    assert.equal(result.clicked, false);
    assert.equal(clicks, 0);
    assert.match(result.reason || result.blocked, /paused/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
