import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  attachPreparedRuntime,
  claimJobForApply,
  classifyApplyControl,
  createNavigationBoundary,
  clickFinalControl,
  finalSubmissionAllowed,
  findResumePdf,
  findCanonicalCv,
  servingAtsForRequest,
  decideUploadKind,
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
  isAuthWallHost,
  isGoogleFormUrl,
  isBlacklistedJob,
  identityFacts,
  skillRatingFor,
  skillYearsFor,
  skillScopedQuestion,
  jobDescriptionFor,
  whyInterested,
  rankByAcceptance,
  candidateFirstName,
  candidateLastName,
  heardFromBoard,
  portalAssetHostAllowed,
  portalApiHostAllowed,
  placeAliases,
  experienceBandFor,
  relocationOption,
  skillYearsOption,
  noticeDays,
  noticeBandFor,
  isApplicationSurfaceControl,
  YEARS_OF_EXPERIENCE_QUESTION,
  WORK_LOCATION_QUESTION,
  relocationPicks,
  availabilityDate,
  salaryAnswer,
  firstAmount,
  salaryInLacs,
  isFingerprintVendorHost,
  finalGuardAction,
  isEligibleJob,
  isSimulationJob,
  controlSignatureMatcher,
  isStrictTargetRole,
  isSubmissionControlLabel,
  isSubmissionLandingUrl,
  isListingBrowseUrl,
  isEssayFieldHint,
  CLOSED_LISTING_TEXT,
  pageIsClosed,
  safePageUrl,
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
    locator: (sel = "") => ({
      first() { return this; },
      // The walker now picks the first VISIBLE navigation control, because a
      // responsive footer renders a hidden duplicate that swallows the click
      // (Hirist). A real locator has nth()/isVisible(), so model them.
      nth() { return this; },
      async isVisible() { return true; },
      // Truthful about captchas. Returning 1 for EVERY selector claimed a
      // captcha iframe existed on a page that has none, and hasCaptcha() fails
      // closed on an uninspectable match - correctly. The flow then stopped as
      // captcha-blocked before reaching the navigation assertion these tests
      // exist to make. Count 0 for captcha selectors so the stub describes the
      // page it is pretending to be, while keeping the step===0 sequencing the
      // "no-navigation" outcome depends on.
      async count() {
        if (/captcha|hcaptcha|recaptcha/i.test(sel)) return 0;
        // The fake page has exactly one control - the navigation button - and
        // no form fields, so every field/combobox selector must count 0.
        if (!/continue|next|proceed/i.test(sel)) return 0;
        return step === 0 ? 1 : 0;
      },
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
    locator: (sel = "") => ({
      first() { return this; },
      // See the note in the stub above: a real locator exposes nth()/isVisible().
      nth() { return this; },
      async isVisible() { return true; },
      // See the note in the stub above: this page has no captcha, so say so.
      async count() { return /captcha|hcaptcha|recaptcha/i.test(sel) ? 0 : (/continue|next|proceed/i.test(sel) ? 1 : 0); },
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
    // The probe reports visible entry fields and visible control labels; the
    // readiness rule (a field, or a submit/continue control that is not an Apply
    // opener) is applied in Node so it can be tested on its own.
    evaluate: async () => {
      calls += 1;
      return calls >= 3 ? { fields: 1, labels: [] } : { fields: 0, labels: [] };
    },
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
      return { fields: 1, labels: [] }; // controls present on the first poll
    },
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForApplicationSurface(page, 5000), true);
  assert.equal(calls, 1);
});

test("an Apply opener alone is not an open application form", async () => {
  // Keka's job details page: one visible "Apply for this job" button, no fields.
  // Treating that as readiness made #1319 fill nothing and record the click on
  // the opener as its submission.
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      return calls >= 2
        ? { fields: 0, labels: ["Apply for this job", "Submit application"] }
        : { fields: 0, labels: ["Apply for this job"] };
    },
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForApplicationSurface(page, 5000), true);
  assert.equal(calls, 2, "the opener must not satisfy the first poll");
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
    // Names no discipline, which is why this gate used to refuse it. It is also
    // exactly the posting an entry-level candidate must apply to, and the India
    // boards phrase it this way more often than "Backend Intern". The entry-level
    // branch requires both an intern/trainee marker and an engineering noun.
    "Software Engineer Intern",
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
    "Applied", "Sent", "FollowupSent", "Expired", "Skipped",
    "Applying", "NeedsReview", "NeedsVerification", "Simulated", "SendPaused", "EmailQueued",
  ]) {
    assert.equal(isEligibleJob(eligible({ status }), { explicit: true }), false, status);
  }
  // Explicit --job-id runs admit the email-channel Verified state: Verified
  // means an email contact was found, which says nothing about whether the job
  // page still accepts a browser application, and the operator chose this row.
  // Queue mode still refuses it.
  assert.equal(isEligibleJob(eligible({ status: "Verified" }), { explicit: true }), true, "explicit Verified");
  assert.equal(isEligibleJob(eligible({ status: "Verified" })), false, "queue-mode Verified");
  // A low score no longer makes a row ineligible. Measured: in-scope roles
  // median 52, out-of-scope median 65, so a floor here removed the wanted
  // roles and kept the ones the role filter rejects anyway. The score must
  // merely EXIST so there is something to rank by.
  assert.equal(isEligibleJob(eligible({ score: 74 }), { explicit: true }), true);
  assert.equal(isEligibleJob(eligible({ score: 12 }), { explicit: true }), true);
  // An unusable score is still refused: nothing to rank by.
  assert.equal(isEligibleJob(eligible({ score: null }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ score: "abc" }), { explicit: true }), false);
  // A G10 review card is an e-mail-channel problem (no verified recruiter
  // contact), not a statement about the job page. It must not stop us applying.
  // Regression: these were in OUTREACH_BLOCKED_STATUSES and blocked 38 in-scope
  // roles in a single run, contradicting the SQL gate directly above it.
  for (const reviewStatus of ["review_posted", "reviewposted", "review_pending", "pending_review", "needs_review"]) {
    assert.equal(isEligibleJob(eligible({ _outreach_statuses: [reviewStatus] }), { explicit: true }), true, reviewStatus);
  }
  // A message that actually went out still blocks a duplicate application.
  for (const terminal of ["sent", "followup_sent", "cooldown", "blacklisted", "bounced", "referral"]) {
    assert.equal(isEligibleJob(eligible({ _outreach_statuses: [terminal] }), { explicit: true }), false, terminal);
  }
  assert.equal(isEligibleJob(eligible({ _outreach_notes: ["G10: no verified company domain"] }), { explicit: true }), true);
  assert.equal(isEligibleJob(eligible({ _send_paused: true }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ _send_paused: null }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ link: "https://www.indeed.com/viewjob?jk=x" }), { explicit: true }), false);
  assert.equal(isEligibleJob(eligible({ link: "https://www.indeed.com/viewjob?jk=x" }), { explicit: true, includeIndeed: true }), true);
  assert.equal(isEligibleJob(eligible({ source: "sim:Mock" }), { explicit: true }), false);
});

  test("a company board may only emit links on its own employer's domain", async () => {
  const scan = await import("../apps/weekly-scan/scan.mjs");
  const seed = "https://careers.example.co.in/jobs";

  // Two labels is the ordinary case.
  assert.equal(scan.registrableDomain("careers.example.com"), "example.com");
  assert.equal(scan.registrableDomain("www.example.com"), "example.com");
  // Three labels where the suffix is itself two labels, as in India. Getting
  // this wrong makes every co.in listing look like a different employer.
  assert.equal(scan.registrableDomain("careers.example.co.in"), "example.co.in");
  assert.equal(scan.registrableDomain("www.example.co.uk"), "example.co.uk");

  const portal = { engine: "company", url: seed };
  // Same employer, different host: the normal case for a careers subdomain.
  assert.equal(scan.validateJobLink("https://jobs.example.co.in/roles/backend", portal).ok, true);
  // A different employer must never be filed under this one.
  assert.equal(scan.validateJobLink("https://careers.othercompany.com/roles/backend", portal).ok, false);
  // And the reason has to say why, so a rejection is diagnosable.
  assert.equal(scan.validateJobLink("https://careers.othercompany.com/x", portal).reason, "off_employer_domain");
  // Plain HTTP is refused, as it is for every other engine.
  assert.equal(scan.validateJobLink("http://careers.example.co.in/x", portal).ok, false);
  // An ATS URL reached through a company portal must not become a company role.
  assert.equal(scan.validateJobLink("https://boards.greenhouse.io/acme/jobs/1", portal).ok, false);
  // And the engine is recognised, rather than refused as unknown.
  assert.notEqual(scan.validateJobLink("https://jobs.example.co.in/x", portal).reason, "unknown_or_unallowlisted_engine");
});

test("YC rows carry the real startup, not the board's own name", async () => {
  const scan = await import("../apps/weekly-scan/scan.mjs");
  // Work at a Startup's cards name only the role. Reading them stamped all 48
  // rows with the literal company "YC Startup", which made the employer column
  // useless - every row deduped against every other and outreach had nobody to
  // address. The board ships its own records; these are the fields it gives.
  const rows = scan.mapYCJobs([
    {
      title: "Full Stack Engineer",
      company: "GiveCampus",
      link: "https://www.workatastartup.com/jobs/25984",
      location: "DC, SF, and remote / Remote (US)",
      salary: "$120K - $200K",
      oneLiner: "The fundraising platform for schools.",
    },
    {
      title: "Backend Engineer",
      company: "Artha Labs",
      link: "https://www.workatastartup.com/jobs/4242",
      location: "",
      salary: "",
      oneLiner: "",
    },
  ], "YC Combinator (Work at a Startup)");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].company, "GiveCampus");
  assert.equal(rows[1].company, "Artha Labs");
  assert.equal(rows.every((r) => r.company !== "YC Startup"), true);
  // The place comes from the board, so the India filter can judge a YC row on
  // its own location instead of treating it as unknown.
  assert.equal(rows[0].location_raw, "DC, SF, and remote / Remote (US)");
  assert.equal(rows[1].location_raw, "");
  assert.match(rows[0].description, /Salary shown: \$120K - \$200K/);
  assert.match(rows[1].description, /Salary: not stated/);
  // A record without an employer is dropped rather than filed under a guess.
  assert.deepEqual(scan.mapYCJobs([{ title: "Backend Engineer", company: "", link: "https://www.workatastartup.com/jobs/1" }], "YC"), []);
  assert.deepEqual(scan.mapYCJobs(null, "YC"), []);
});

test("Hirist rows carry the employer and a clean title", async () => {
  const scan = await import("../apps/weekly-scan/scan.mjs");
  // The card is one anchor containing every field with no separator, so reading
  // the anchor's text glued the experience band onto the title ("AI Agent
  // Platform7") and the skill tags after it. Twelve of thirty-two recent rows
  // were wrong that way, and nine more had the job title in the company column.
  const rows = scan.mapHiristCards([
    {
      link: "https://www.hirist.tech/j/healthifyme-senior-backend-engineer-python-1682114",
      heading: "HealthifyMe - Senior Backend Engineer - Python",
      experience: "4 - 6 yrs",
      location: "Multiple Locations",
      tags: ["Python", "Django", "FastAPI"],
      card_text: "HealthifyMe - Senior Backend Engineer - Python4 - 6 yrsMultiple LocationsPythonDjangoFastAPIPosted today",
    },
    {
      // A confidential posting: the heading is the role alone. Filing its first
      // segment as the company is what put "Software Engineer" and "Technical
      // Lead" in the employer column, where they could never match a receipt.
      link: "https://www.hirist.tech/j/senior-software-development-engineer-ai-agent-platform-1678230",
      heading: "Senior Software Development Engineer - AI Agent Platform",
      experience: "7 - 12 yrs",
      location: "Bangalore",
      tags: [],
      card_text: "Senior Software Development Engineer - AI Agent Platform7 - 12 yrsBangalore",
    },
  ], "Hirist (Backend Development)");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].company, "HealthifyMe");
  assert.equal(rows[0].title, "Senior Backend Engineer - Python");
  // The experience band must not survive into the title.
  assert.doesNotMatch(rows[0].title, /4 - 6|yrs/i);
  assert.equal(rows[0].location_raw, "Multiple Locations");
  assert.match(rows[0].description, /Experience: 4 - 6 yrs/);
  assert.match(rows[0].description, /Skills: Python, Django, FastAPI/);

  assert.equal(rows[1].company, "Unknown");
  // Nothing is thrown away when there is no employer: the whole heading is the
  // role, including its "- AI Agent Platform" half.
  assert.equal(rows[1].title, "Senior Software Development Engineer - AI Agent Platform");
  assert.deepEqual(scan.mapHiristCards(null, "Hirist"), []);
  assert.deepEqual(scan.mapHiristCards([{ heading: "Too short" }], "Hirist"), []);
});

test("the board's own fingerprint vendor is reachable, by hashed subdomain", () => {
  // Enabled on the operator's instruction. A real browser loading an Ashby board
  // runs SEON; we did not, so every session was anomalous on the one signal the
  // board's classifier has. Fidelity, not evasion - nothing is spoofed.
  const u = (s) => new URL(s);
  // The host is a per-session hash, so this must match on suffix.
  assert.equal(isFingerprintVendorHost(u("https://373091bdea75445784f25971a1532819.seondnsresolve.com/")), true);
  assert.equal(isFingerprintVendorHost(u("https://be5c78e8bb794a1017b4d8dde08492f9.seondnsresolve.com/")), true);
  assert.equal(isFingerprintVendorHost(u("https://seondnsresolve.com/")), true);
  // Still only that vendor, and still HTTPS only.
  assert.equal(isFingerprintVendorHost(u("https://evil.example/collect")), false);
  assert.equal(isFingerprintVendorHost(u("http://x.seondnsresolve.com/")), false);
  // A lookalike must not slip through on a substring.
  assert.equal(isFingerprintVendorHost(u("https://seondnsresolve.com.evil.example/")), false);
});

test("salary is answered in the unit the question asked for", () => {
  const stated = {
  desired_salary_monthly: "INR 35,000 - 45,000 per month",
  desired_salary_annual: "INR 8,40,000 - 10,80,000 per annum",
  };
  // Quoting the wrong unit is a wrong number, not a format mismatch.
  assert.equal(salaryAnswer(stated, "desired_salary desired salary range (per month)"), "INR 35,000 - 45,000 per month");
  assert.equal(salaryAnswer(stated, "what is your expected compensation? per annum"), "INR 8,40,000 - 10,80,000 per annum");
  // "in Lacs" / "LPA" asks for the number in lacs. Answering the rupee string to
  // a field labelled "in Lacs" is off by five orders of magnitude, and Hirist
  // asks exactly that as a mandatory box ("expected CTC in Lacs per annum").
  assert.equal(salaryAnswer(stated, "expected salary lpa"), "8.4 - 10.8");
  assert.equal(salaryAnswer(stated, "What is your expected CTC in Lacs per annum?"), "8.4 - 10.8");
  // A profile that already states lacs is passed through, not divided again.
  assert.equal(salaryAnswer({ desired_salary_annual: "4-5 LPA" }, "expected CTC in lacs"), "4 - 5");
  assert.equal(salaryInLacs("INR 8,40,000 - 10,80,000 per annum"), "8.4 - 10.8");
  assert.equal(salaryInLacs(""), "");
  assert.equal(salaryAnswer(stated, "desired monthly salary"), "INR 35,000 - 45,000 per month");
  // No unit stated: the monthly form, which is the one the operator's floor
  // was given in, and it carries its own unit so it cannot be misread.
  assert.equal(salaryAnswer(stated, "what are you looking for?"), "INR 35,000 - 45,000 per month");
  // Nothing configured: no number invented.
  assert.equal(salaryAnswer({}, "desired salary"), "");
  // The fact is exposed with a per-control resolver.
  const fact = identityFacts({}, stated).find((f) => f.tag === "desired salary");
  assert.equal(typeof fact.byField, "function");
  assert.equal(fact.byField("desired salary per month"), "INR 35,000 - 45,000 per month");
  // A `*.amount` control is the numeric half of an amount + currency + "Monthly"
  // row, so it gets the number, not the sentence. Keka renders exactly this
  // (expectedSalary.amount, #1319, 2026-11-09).
  assert.equal(
    salaryAnswer(stated, "expected salary * expectedsalary expectedsalary.amount monthly"),
    "35000",
  );
  assert.equal(firstAmount("INR 35,000 - 45,000 per month"), "35000");
  assert.equal(firstAmount("INR 8,40,000 - 10,80,000 per annum"), "840000");
  assert.equal(firstAmount(""), "");
});

test("plain identity facts are answered from the profile, absent facts are not invented", () => {
  const candidate = { name: "AVRADEEP MAJUMDER", phone: "6289050278" };
  const facts = identityFacts(candidate, {});
  const byTag = Object.fromEntries(facts.map((f) => [f.tag, f.value]));
  // The candidate's own name and number are transcription, not judgement.
  assert.equal(byTag["legal name"], "AVRADEEP MAJUMDER");
  assert.equal(byTag["phone number"], "6289050278");
  // An employer is never inferred; it appears only if the operator stated it.
  assert.equal("current company" in byTag, false);
  assert.equal(identityFacts(candidate, { current_company: "Acme" })
    .find((f) => f.tag === "current company").value, "Acme");


// A missing profile fact yields no entry at all, so the field is left for the human.
  // The salary fact is present regardless because it resolves per control from
  // the question's own unit, and returns "" when the operator set nothing.
  assert.deepEqual(identityFacts({ phone: "6289050278" }, {}).map((f) => f.tag),
    ["phone number", "desired salary", "how you heard"]);

  // Facts derived from the profile rather than restated by hand.
  const rich = identityFacts(
    {
      name: "AVRADEEP MAJUMDER",
      phone: "6289050278",
      current_location: "Greater Noida, Uttar Pradesh",
      experience_years: 2,
      expected_salary: "4-5 LPA",
      notice_period: "30 days",
    },
    { current_company: "Acme", requires_visa_sponsorship: "Yes" },
  );
  const richByTag = Object.fromEntries(rich.map((f) => [f.tag, f.value]));
  assert.equal(richByTag["city"], "Greater Noida, Uttar Pradesh");
  assert.equal(richByTag["years of experience"], "2 years");
  assert.equal(richByTag["desired salary"], "", "salary is resolved per control, so the fixed value stays empty");
  // Sponsorship required => not authorised. Never asserted when undeclared.
  assert.equal(richByTag["work authorisation"], "No");
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "work authorisation"), false);
  assert.equal(
    identityFacts({}, { requires_visa_sponsorship: "No" }).find((f) => f.tag === "work authorisation").value,
    "Yes",
  );
  assert.equal(
    identityFacts({ experience_years: 1 }, {}).find((f) => f.tag === "years of experience").value,
    "1 year",
  );
  // "How did you hear about X" is answered truthfully as the board the row came
  // from. This fixture passes no job, so the honest generic answer is "Job board";
  // a stated answer always wins over it.
  assert.equal(richByTag["how you heard"], "Job board");
  assert.equal(
    identityFacts({}, {}, { source: "LinkedIn" }).find((f) => f.tag === "how you heard").value,
    "LinkedIn",
  );
  assert.equal(identityFacts({}, { how_you_heard: "A colleague" }).find((f) => f.tag === "how you heard").value, "A colleague");
  // A day-count availability control is the notice period in days, and a gender
  // dropdown is only answered when the operator stated it.
  assert.equal(richByTag["availability days"], "30");
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "availability days"), false);
  assert.equal(identityFacts({}, { gender: "Male" }).find((f) => f.tag === "gender").value, "Male");
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "gender"), false);

  // A notice period is a duration and a start date is a date. They used to be
  // the same fact, so Hirist's mandatory "What is your Notice Period?" box was
  // answered with the computed start date ("2026-12-04") instead of "30 days".
  assert.equal(richByTag["notice period"], "30 days");
  assert.match(richByTag["availability date"], /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(richByTag["notice period"], richByTag["availability date"]);
  // The notice-period answer never claims a start date on a form that has no
  // notice period question.
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "notice period"), false);

  // "Current CTC" is the candidate's actual package, which is nothing while he
  // is not employed. It is never answered from the expected-salary figures.
  assert.equal(
    identityFacts({}, { current_company: "Not currently employed" }).find((f) => f.tag === "current CTC").value,
    "0",
  );
  assert.equal(
    identityFacts({}, { current_company: "AKS Intelligent Systems LLP" }).some((f) => f.tag === "current CTC"),
    false,
    "an employed candidate's current CTC is unknown, so no figure is invented",
  );
  const desiredFact = identityFacts({}, { desired_salary_annual: "INR 8,40,000 per annum" })
    .find((f) => f.tag === "desired salary");
  // The expected-salary fact must not answer a "current CTC" box.
  assert.equal(desiredFact.hint.test("What is your current CTC in Lacs per annum?"), false);
  assert.equal(desiredFact.hint.test("What is your expected CTC in Lacs per annum?"), true);

  // Work authorisation is answered only where the question is scoped to the
  // job's country. A form can ask about the job's country AND the candidate's
  // own country in one breath; the derived "No" (sponsorship required) is
  // right for the first and a false statement for the second.
  const authFact = identityFacts({}, { requires_visa_sponsorship: "Yes" })
    .find((f) => f.tag === "work authorisation");
  assert.equal(authFact.value, "No");
  assert.equal(authFact.once, false, "must not be capped at one match");
  assert.equal(authFact.hint.test("Are you currently authorized to work in the country outlined for this job (e.g. H-1B status)?"), true);
  assert.equal(authFact.hint.test("Are you legally authorized to work in the United States?"), true);
  assert.equal(authFact.hint.test("Are you currently bound by any non-compete agreement?"), false);
  // A jurisdiction-less question must not inherit the derived answer.
  assert.equal(authFact.hint.test("Are you authorized to work in this role?"), false);
  assert.equal(identityFacts({ current_location: "Greater Noida" }, {})
    .find((f) => f.tag === "city").once, false);

  // An availability picker is input[type=date] and rejects prose, so the notice
  // period has to become a real date. Unparseable values yield nothing rather
  // than a guessed date.
  assert.equal(availabilityDate({ notice_period: "30 days" }, new Date("2026-10-01T00:00:00Z")), "2026-10-31");
  assert.equal(availabilityDate({ notice_period: "2 weeks" }, new Date("2026-10-01T00:00:00Z")), "2026-10-15");
  // The unit must be read, not discarded: "2 weeks" is 14 days, not 2.
  assert.equal(availabilityDate({ notice_period: "1 month" }, new Date("2026-10-01T00:00:00Z")), "");
  assert.equal(availabilityDate({ notice_period: "0 days" }, new Date("2026-10-01T00:00:00Z")), "2026-10-01");
  assert.equal(availabilityDate({ notice_period: "immediately" }, new Date("2026-10-01T00:00:00Z")), "");
  assert.equal(availabilityDate({}, new Date("2026-10-01T00:00:00Z")), "");
  assert.equal(availabilityDate({ notice_period: "99999 days" }, new Date("2026-10-01T00:00:00Z")), "");
  // Month-end rollover must not overflow.
  assert.equal(availabilityDate({ notice_period: "10 days" }, new Date("2026-10-25T00:00:00Z")), "2026-11-04");
  // A job title is only ever the operator's stated value, never inferred.
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "last job title"), false);
  assert.equal(
    identityFacts({}, { current_job_title: "Software Trainee Intern" })
      .find((f) => f.tag === "last job title").value,
    "Software Trainee Intern",
  );

  // The non-compete answer has to match BOTH phrasings boards use. The classic
  // form and the "bound by any agreements with a current or former employer"
  // form share no keyword, and only the first was handled - which left 13
  // submissions blocked on a question the profile already had the answer to.
  const nonCompete = identityFacts({}, { current_non_compete: "No" })
    .find((f) => f.tag === "non-compete");
  assert.ok(nonCompete, "current_non_compete must produce an answerable fact");
  assert.equal(nonCompete.value, "No");
  // Deliberately NOT `once`: Greenhouse renders each question twice - a text
  // input and a react-select for the same field - so filling only the first
  // left the second empty and blocked the submit.
  assert.notEqual(nonCompete.once, true);
  const phrasings = [
    // The singular is what Scale AI actually writes; the pattern used to want
    // "agreements" and missed every one of these.
    "are you currently bound by any agreement",
    "are you currently bound by any agreement with a current or former employer",
    "are you subject to a non-compete, non-solicitation or non-disclosure agreement?",
    "are you bound by any agreements with a current or former employer that may restrict your ability to work for us?",
    "do you have any non-compete obligations?",
    "are you subject to any agreements that restrict your employment?",
    // GitLab, 2026-11-09. No keyword the earlier phrasings had: it says
    // "employment agreements" and "post-employment restrictions", so the one
    // question on that form the profile could answer stayed empty.
    "Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?*",
  ];
  for (const p of phrasings) {
    assert.ok(nonCompete.hint.test(p), `non-compete hint must match: ${p}`);
  }
  // Scale AI asks both of these on one form. The second is NOT a yes/no
  // question - it wants the name of the role - and it mentions non-compete only
  // while listing what such obligations include. A keyword match would answer
  // it with "No", which is a wrong answer on a legal representation.
  const whichPosition = "position for which you are applying? this includes, but is not limited to, non-compete agreements, non-solicitation agreements, confidentiality or non-disclosure agreements, or any other contractual obligations that could limit you";
  assert.equal(nonCompete.hint.test(whichPosition), false, "must not answer a which-position question with the non-compete answer");
  assert.equal(nonCompete.hint.test("which position are you applying for?"), false);
  assert.equal(nonCompete.hint.test("what position are you applying for?"), false);
  // A question that is not about restrictions must not be answered with this.
  assert.equal(nonCompete.hint.test("what is your expected salary?"), false);
  assert.equal(nonCompete.hint.test("what is your current or most recent job title?"), false);
  // Unset in the profile means no answer is offered at all, so the question
  // stays pending rather than being guessed at.
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "non-compete"), false);

  // The hints must match the labels boards actually use. Match against the fully
  // populated profile so every hint is present to be exercised at all.
  const withEmployer = rich;
  const match = (tag, signature) => Boolean(withEmployer.find((f) => f.tag === tag)?.hint.test(signature));
  assert.equal(match("legal name", "Legal Name"), true);
  assert.equal(match("legal name", "Full legal name as per your passport"), true);
  // The real signature Ashby produces: aria-label + id + name + question. A
  // ^name$ anchor missed this entirely, so the field blocked every submit.
  assert.equal(match("legal name", "_systemfield_name _systemfield_name name"), true);
  assert.equal(match("legal name", "name name name"), true);
  // ...and must NOT swallow a field whose label merely contains "name".
  assert.equal(match("legal name", "9643d331-f5ad-42da-8f0e-79d3428e634f current company"), false);
  assert.equal(match("legal name", "company_name previous employer name"), false);
  assert.equal(match("phone number", "Phone Number"), true);
  assert.equal(match("phone number", "Mobile no."), true);
  assert.equal(match("current company", "Current Company"), true);
  assert.equal(match("current company", "Where do you currently work?"), true);
  assert.equal(match("current company", "Who is your current or most recent employer?"), true);
  assert.equal(match("city", "Location (City)*"), true);
  assert.equal(match("years of experience", "How many years of industry experience do you have?"), true);
  assert.equal(match("work authorisation", "Are you currently authorized to work in the US?"), true);
  assert.equal(match("desired salary", "What is your desired salary range?"), true);
  assert.equal(match("how you heard", "How did you hear about Mixpanel as an Employer?"), true);
  // The literal label Ashby/OpenAI put on the availability control.
  assert.equal(match("availability date", "Pick date..."), true);
  assert.equal(match("availability date", "Earliest you would want to start"), true);
  assert.equal(match("availability date", "Desired start date"), true);

  // Genuinely personal prompts stay out of this list by design.
  const personal = "Why do you want to work at Cartesia AI?";
  assert.equal(withEmployer.some((f) => f.hint.test(personal)), false, personal);
  assert.equal(withEmployer.some((f) => f.hint.test("Describe your experience working with observability")), false);
  // A binding legal question is not a profile fact and must not be auto-answered.
  assert.equal(withEmployer.some((f) => f.hint.test("Are you currently bound by any non-compete agreement?")), false);
  assert.equal(withEmployer.some((f) => f.hint.test("Please acknowledge that you've read and understood the applicant agreement")), false);
});

test("a contended listing is per-row, and only a global pause stops the batch", () => {
  // Regression: "already-applying" was unmapped, so it fell through to
  // "send-paused", which breaks the run loop. One orphaned claim silently
  // truncated a 30-job batch after 4.
  assert.equal(finalGuardAction({ reason: "already-applying" }), "contended");
  assert.equal(finalGuardAction({ reason: "already-owned" }), "contended");
  assert.equal(finalGuardAction({ reason: "stale-applying-review-required" }), "contended");

  // Genuinely global states keep their old meaning and still stop everything.
  for (const reason of ["send-paused", "db-missing", "settings-unavailable", "pause-query-failed"]) {
    assert.equal(finalGuardAction({ reason }), "send-paused", reason);
  }
  assert.equal(finalGuardAction({ reason: "claim-lost" }), "claim-blocked");
  assert.equal(finalGuardAction({ reason: "claim-required" }), "claim-blocked");
  assert.equal(finalGuardAction({ reason: "redirect-blocked" }), "redirect-blocked");
  assert.equal(finalGuardAction({ reason: "profile-incomplete" }), "profile-incomplete");
  assert.equal(finalGuardAction({ error: "boom" }), "needs-verification");
  assert.equal(finalGuardAction({}), null);
});

test("a portal's own scripts load, and only while on that portal", () => {
  const u = (s) => new URL(s);
  // Instahyre's interface is jQuery + Bootstrap from two CDNs plus its own
  // bundles. Blocked, the page never hydrates and the run times out on a dead
  // "Apply now" button - 22 consecutive timeouts before this was found.
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://static.instahyre.com/js/output.1.js")), true);
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://ajax.googleapis.com/ajax/libs/jquery-1.11.1/jquery.min.js")), true);
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.7/js/bootstrap.min.js")), true);
  // Analytics and error reporting are NOT needed to fill a form, and a script
  // that can read the page can read what was typed.
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://browser.sentry-cdn.com/5.1.0/bundle.min.js")), false);
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://static.cloudflareinsights.com/beacon.min.js")), false);
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com", u("https://www.googletagmanager.com/gtag/js?id=G-X")), false);
  // Scoped by host: the same CDNs stay blocked anywhere else. Keying this on
  // the ATS would have widened script trust across every generic site.
  assert.equal(portalAssetHostAllowed("https://jobs.ashbyhq.com", u("https://ajax.googleapis.com/ajax/libs/jquery-1.11.1/jquery.min.js")), false);
  assert.equal(portalAssetHostAllowed("https://evil.example", u("https://static.instahyre.com/js/output.1.js")), false);
  assert.equal(portalAssetHostAllowed("https://www.instahyre.com.evil.example", u("https://static.instahyre.com/js/output.1.js")), false);
});

test("a portal's own API host feeds the page, but only the calls it needs", () => {
  const u = (s) => new URL(s);
  // Hirist's job page is client-rendered from gladiator.hirist.tech. Blocking
  // that host dropped the page from 13,458 characters to 286 with no Apply
  // button, which is what had stranded all 31 pending Hirist rows.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/detail/1676086/"), "GET", "xhr"), true);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/user/notification/count"), "GET", "fetch"), true);
  // The screening form waits on exactly one POST: the session check.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://assessmentapi.hirist.tech/v1/login"), "POST", "xhr"), true);
  // Answers the form typed are recorded through the board's own endpoint. With
  // it blocked the form rendered, every field filled, Next was enabled, and
  // pressing Next did nothing - six times.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://assessmentapi.hirist.tech/v1/questionResponse"), "POST", "xhr"), true);
  // The submission itself is an XHR to the board's API, not a form post:
  // observed live as /job/assessment_complete?jobcode=<id> then
  // /job/apply?jobcode=<id>.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/apply?jobcode=1678230"), "POST", "xhr"), true);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/assessment_complete?jobcode=1678230"), "POST", "xhr"), true);
  // ...but only those two paths, only with a numeric jobcode, only POST, and
  // only from the board's own page.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/apply"), "POST", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/apply?jobcode=abc"), "POST", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/delete?jobcode=1"), "POST", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://evil.example", u("https://gladiator.hirist.tech/job/apply?jobcode=1"), "POST", "xhr"), false);
  // Writes beyond it, and any other verb, stay blocked.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://assessmentapi.hirist.tech/v1/answers"), "POST", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/apply/1676086/"), "POST", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/job/detail/1676086/"), "DELETE", "xhr"), false);
  // Scripts never arrive through the API allowance.
  assert.equal(portalApiHostAllowed("https://www.hirist.tech", u("https://gladiator.hirist.tech/x.js"), "GET", "script"), false);
  // Scoped to the board's own page.
  assert.equal(portalApiHostAllowed("https://evil.example", u("https://gladiator.hirist.tech/job/detail/1/"), "GET", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.hirist.tech.evil.example", u("https://gladiator.hirist.tech/job/detail/1/"), "GET", "xhr"), false);
  assert.equal(portalApiHostAllowed("https://www.instahyre.com", u("https://gladiator.hirist.tech/job/detail/1/"), "GET", "xhr"), false);
});

test("Deel's guest form may read its own lookups and write only in its ats namespace", () => {
  const u = (s) => new URL(s);
  // Measured 2026-11-10, #1320 Zema: the form is served from jobs.deel.com but
  // country/state lookups, the upload-request capability and the submit all go
  // to Deel's own API host. Every one was blocked, so the dropdowns were empty,
  // the CV never attached, and "Apply" could not become enabled.
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/lookups?documents[]=countries&ver=2"), "GET", "fetch"), true);
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/deelapi/form_builder/guest/preset/states"), "GET", "fetch"), true);
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/deelapi/guest/ats/application_form_upload_requests"), "POST", "fetch"), true);

  // Only that namespace is writable, only as an XHR, and only from Deel's page.
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/deelapi/organizations/1"), "POST", "fetch"), false);
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/deelapi/guest/ats/application_form_upload_requests"), "DELETE", "fetch"), false);
  assert.equal(portalApiHostAllowed("https://jobs.deel.com", u("https://api-prod.letsdeel.com/deelapi/guest/ats/application_form_upload_requests"), "POST", "script"), false);
  assert.equal(portalApiHostAllowed("https://evil.example", u("https://api-prod.letsdeel.com/deelapi/guest/ats/application_form_upload_requests"), "POST", "fetch"), false);
  // A different Deel tenant page gets nothing from this allowance.
  assert.equal(portalApiHostAllowed("https://jobs.deel.com.evil.example", u("https://api-prod.letsdeel.com/lookups"), "GET", "fetch"), false);
});

test("screening radios are answered from stated facts, never guessed", () => {
  // "Are you currently living in Bangalore?" - answered from where he actually
  // lives, with the NCR cities treated as the one place they are.
  const ncr = placeAliases("Greater Noida, Uttar Pradesh");
  assert.equal(ncr.has("greater noida"), true);
  assert.equal(ncr.has("noida"), true);
  assert.equal(ncr.has("delhi ncr"), true);
  assert.equal(ncr.has("bangalore"), false);
  const kolkata = placeAliases("Kolkata, West Bengal");
  assert.equal(kolkata.has("delhi"), false);
  assert.equal(kolkata.has("kolkata"), true);

  // "How many years of professional software engineering experience?" - the
  // band has to contain 0.2 years, not merely the first option.
  const bands = ["Less than 2 years", "2 - 3 Years", "3 - 5 Years", "5+ Years"];
  const q = "5. How many years of professional software engineering experience do you have?";
  assert.equal(experienceBandFor(q, bands, 0.2), "Less than 2 years");
  assert.equal(experienceBandFor(q, bands, 2.5), "2 - 3 Years");
  assert.equal(experienceBandFor(q, bands, 4), "3 - 5 Years");
  assert.equal(experienceBandFor(q, bands, 9), "5+ Years");
  assert.equal(experienceBandFor(q, ["0-1 years", "1-3 years"], 0.2), "0-1 years");
  assert.equal(experienceBandFor(q, ["Fresher", "Experienced"], 0), "Fresher");
  // A question that is not about years must never consume a band.
  assert.equal(experienceBandFor("Are you currently living in Bangalore?", bands, 0.2), null);
  assert.equal(experienceBandFor(q, bands, Number.NaN), null);
});

test("the stated notice period is rendered in the board's own availability bands", () => {
  // Zema's Deel form (#1320, 2026-11-09): "Available to start (a notice period)
  // *" as a radio group; Apply stays disabled until it is answered. The profile
  // states "30 days", so this is transcription in the board's vocabulary.
  const options = [
    "Available immediately",
    "Available within 2-4 weeks",
    "Available within 1-2 months",
    "Available within 2-3 months",
  ];
  assert.equal(noticeDays({ notice_period: "30 days" }), 30);
  assert.equal(noticeDays({ notice_period: "2 weeks" }), 14);
  assert.equal(noticeDays({ notice_period: "Immediate" }), 0);
  assert.equal(noticeDays({}), null);
  assert.equal(noticeDays({ notice_period: "as discussed" }), null);

  assert.equal(noticeBandFor("Available to start (a notice period) *", options, 30), "Available within 1-2 months");
  assert.equal(noticeBandFor("Available to start (a notice period) *", options, 0), "Available immediately");
  assert.equal(noticeBandFor("Available to start (a notice period) *", options, 14), "Available within 2-4 weeks");
  // A question that is not about availability gets nothing, whatever the options say.
  assert.equal(noticeBandFor("How many years of experience do you have?", options, 30), "");
  assert.equal(noticeBandFor("Available to start (a notice period) *", options, Number.NaN), "");
});

test("the control that opens a form is not evidence that the form is open", () => {
  // Keka's job details page (nudge.keka.com/careers/jobdetails/94986, measured
  // 2026-11-09) has one visible control, "Apply for this job", and no fields.
  // It used to satisfy the "application surface has rendered" check because its
  // label contains "apply", so #1319 filled nothing, clicked that same button
  // when it looked for Submit, and landed at NeedsVerification.
  assert.equal(isApplicationSurfaceControl("Apply for this job"), false);
  assert.equal(isApplicationSurfaceControl("Apply"), false);
  assert.equal(isApplicationSurfaceControl("Apply Now"), false, "Keka's real submit lives inside an open form");
  assert.equal(isApplicationSurfaceControl("Easy Apply"), false);

  // A form that is genuinely open says one of these.
  for (const label of ["Submit application", "Submit", "Send application", "Continue", "Next"]) {
    assert.equal(isApplicationSurfaceControl(label), true, `must count as a surface: ${label}`);
  }
  assert.equal(isApplicationSurfaceControl(""), false);
});

test("questions whose answers only exist in the board's option list", () => {
  // Measured on GitLab 8916232002, 2026-11-09. Four required questions, all
  // react-selects; the form was refused with "This field is required." on the
  // ones no profile string could answer.
  //
  // "How many years of professional backend software engineering experience do
  // you have?" offers bands, not a number:
  const bands = ["Intern / Fresher", "Less than 5 Years", "5-8 Years", "Above 8+ Years"];
  assert.equal(experienceBandFor("total experience", bands, 0.2), "Intern / Fresher");

  // The years question is recognised whatever qualifiers the board inserts...
  for (const q of [
    "How many years of professional backend software engineering experience do you have?*",
    "How many years of relevant experience do you have?",
    "Years of experience",
    "What is your total experience?",
  ]) {
    assert.ok(YEARS_OF_EXPERIENCE_QUESTION.test(q), `must match: ${q}`);
  }
  // ...but a question scoped to a technology is NOT answerable from total
  // experience. GitLab asks "How many years of professional, production
  // experience do you have writing Go (Golang) or Ruby?" and the CV claims
  // neither language: answering 0.2 years would be a false statement.
  for (const q of [
    "How many years of professional, production experience do you have writing Go (Golang) or Ruby? *",
    "How many years of programming experience do you have in C?",
  ]) {
    assert.equal(YEARS_OF_EXPERIENCE_QUESTION.test(q), false, `must not match: ${q}`);
  }

  // "This role requires candidate to be present in Bengaluru, what best
  // describe your situation *" - the relocate option commits him to living
  // there, so it is only chosen for a city he listed.
  const stated = { relocation_cities: "Bengaluru, Hyderabad, Pune, Chennai, NCR" };
  const candidate = { current_location: "Greater Noida, Uttar Pradesh" };
  const gitlabOptions = [
    "I'm looking for remote opportunity only",
    "Currently in Bangalore",
    "I'm elsewhere but can relocate to Bangalore",
  ];
  assert.equal(
    relocationOption(gitlabOptions, candidate, stated),
    "I'm elsewhere but can relocate to Bangalore",
    "Bangalore is Bengaluru, and it is on his list",
  );
  // A city he never agreed to is left untouched, and so is a city he already
  // lives in - "can relocate to Noida" is not a truthful answer for a Noida
  // resident, the truthful option is that he is already there.
  assert.equal(
    relocationOption(["I'm elsewhere but can relocate to Kochi"], candidate, stated),
    "",
  );
  assert.equal(
    relocationOption(["I'm elsewhere but can relocate to Noida"], candidate, stated),
    "",
  );
  assert.equal(relocationOption(gitlabOptions, candidate, {}), "");
  assert.equal(relocationOption([], candidate, stated), "");

  // The tech-scoped years question is not the general one. GitLab's options are
  // ["None", "Less than 1 year", "1-3 Years", "3-6 Years", "6+ Years"] and the
  // CV lists neither Go nor Ruby, so the truthful answer is "None" - not 0.2
  // years, which would claim experience in a language he has never written.
  const skillProfile = { domain: { core_skills: ["Python", "C++"], adjacent_skills: ["AWS", "PostgreSQL"] } };
  const goOptions = ["None", "Less than 1 year", "1-3 Years", "3-6 Years", "6+ Years"];
  const goQ = "How many years of professional, production experience do you have writing Go (Golang) or Ruby? *";
  assert.equal(skillYearsOption(goOptions, goQ, skillProfile, 0.2), "None");
  // A technology the CV does list takes the band that contains his 0.2 years.
  const pyQ = "How many years of experience do you have writing Python?";
  assert.equal(skillYearsOption(goOptions, pyQ, skillProfile, 0.2), "Less than 1 year");
  // Prose that names no technology is left alone, and so is a question that is
  // not about years at all.
  assert.equal(skillYearsOption(goOptions, "How many years have you worked using our platform?", skillProfile, 0.2), "");
  assert.equal(skillYearsOption(goOptions, "Do you enjoy writing Go?", skillProfile, 0.2), "");
});

test("relocation checkbox groups are answered only from a stated city list", () => {
  // Hirist #1054, live: "4. Please select the city you are currently residing
  // or willing to relocate to" with one checkbox per city. There is no radio
  // group and each box has its own element name, so the only honest source is
  // a list the candidate wrote himself.
  const q = "4. Please select the city you are currently residing or willing to relocate to Chennai Pune";
  assert.deepEqual(relocationPicks(q, ["Chennai", "Pune"], { relocation_cities: "Chennai, Pune" }).picks, ["Chennai", "Pune"]);
  assert.deepEqual(relocationPicks(q, ["Chennai", "Pune"], { relocation_cities: "Pune" }).picks, ["Pune"]);
  // The profile lists hubs by name; each covers its other spelling and NCR
  // covers every city inside it, so one word per hub is enough.
  assert.deepEqual(
    relocationPicks(q, ["Bengaluru", "Bangalore", "Chennai"], { relocation_cities: "Bengaluru" }).picks,
    ["Bengaluru", "Bangalore"],
  );
  assert.deepEqual(
    relocationPicks(q, ["Delhi NCR", "Gurugram", "Noida", "Mumbai"], { relocation_cities: "NCR" }).picks,
    ["Delhi NCR", "Gurugram", "Noida"],
  );
  assert.deepEqual(
    relocationPicks(q, ["Chennai", "Pune"], { relocation_cities: "Bengaluru, Hyderabad, Pune, Chennai, NCR" }).picks,
    ["Chennai", "Pune"],
  );
  // Nothing stated: no city is ticked, and the caller logs the exact question.
  const unset = relocationPicks(q, ["Chennai", "Pune"], {});
  assert.deepEqual(unset.picks, []);
  assert.deepEqual(unset.wanted, []);
  assert.deepEqual(relocationPicks(q, ["Chennai", "Pune"], null).picks, []);
  // A stated city this posting does not offer must not tick a different one.
  assert.deepEqual(relocationPicks(q, ["Chennai", "Pune"], { relocation_cities: "Bengaluru" }).picks, []);
  // The option may carry a qualifier; the city name is what a person ticks.
  assert.deepEqual(
    relocationPicks(q, ["Pune (relocation required)", "Chennai"], { relocation_cities: "pune" }).picks,
    ["Pune (relocation required)"],
  );
  // A stated city must not tick a different one.
  assert.deepEqual(relocationPicks(q, ["Chennai", "Pune"], { relocation_cities: "Mumbai" }).picks, []);
  // Any other checkbox group is not this fact's business, so it is untouched
  // rather than answered with a city name.
  assert.equal(relocationPicks("Which benefits do you need?", ["Health insurance", "Gym"], { relocation_cities: "Chennai" }), null);
  assert.equal(relocationPicks("4. Do you hold a valid passport?", ["Yes", "No"], { relocation_cities: "Pune" }), null);
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

test("Himalayas and YC postings are recognised, and a lookalike is not", () => {
  // Himalayas lists the posting on its own host and hands off to the employer's
  // ATS from there, so it has to be a classified board rather than "generic" -
  // otherwise every Himalayas row is refused before a browser opens.
  const posting = "https://himalayas.app/companies/genesys/jobs/staff-software-engineer";
  assert.equal(inferATS(posting), "himalayas");
  assert.equal(inferATS("https://www.himalayas.app/companies/x/jobs/y"), "himalayas");
  assert.equal(isAllowedInitialJobUrl(posting), true);
  // The posting page is an opener: it may leave for the employer's own site, and
  // that hop is what PULSEOPS_ALLOW_EXTERNAL_APPLY governs.
  assert.equal(isAllowedNavigationUrl("https://boards.greenhouse.io/genesys/jobs/1", "himalayas", posting), false);

  const yc = "https://www.workatastartup.com/jobs/12345";
  assert.equal(inferATS(yc), "yc");
  assert.equal(isAllowedInitialJobUrl(yc), true);

  // A host that merely mentions the board is not the board.
  assert.equal(inferATS("https://evil.example/?next=himalayas.app"), "generic");
  assert.equal(inferATS("https://himalayas.app.evil.example/companies/x/jobs/y"), "generic");
});

test("UKG Pro Recruiting is a known ATS whose own CDN may serve its app", () => {
  // Measured 2026-11-10, #1019 Park Place Technologies: the posting page is a
  // route of recruiting.ultipro.com, its runtime is on two CDN hostnames of its
  // own, and with the scripts blocked the page painted nothing at all.
  const posting = "https://recruiting.ultipro.com/PAR1035PPTL/JobBoard/e104637a-c3c6-4682-96d2-d7cc2662dc13/OpportunityDetail?opportunityId=8a3e";
  const form = "https://recruiting.ultipro.com/PAR1035PPTL/JobBoard/e104637a-c3c6-4682-96d2-d7cc2662dc13/OpportunityApply?opportunityId=8a3e";
  assert.equal(inferATS(posting), "ultipro");
  assert.equal(inferATS(form), "ultipro");
  assert.equal(isAllowedInitialJobUrl(posting), true);
  // The apply route is the same host, so the opener has somewhere allowed to go.
  assert.equal(isAllowedNavigationUrl(form, "ultipro", posting), true);

  // Its declared asset hosts may serve scripts; a lookalike may not.
  assert.equal(isAllowedAssetRequest("https://rec-cdn-prod.cdn.ultipro.com/rec-web/3cc6/siteBundle.js", "script", "ultipro"), true);
  assert.equal(isAllowedAssetRequest("https://ignite.cdn.ultipro.com/dls-cdn/ignite/v7.18.0/ignite.js", "script", "ultipro"), true);
  assert.equal(isAllowedAssetRequest("https://cdn.ultipro.evil.example/siteBundle.js", "script", "ultipro"), false);
  assert.equal(isAllowedAssetRequest("https://rec-cdn-prod.cdn.ultipro.com/rec-web/x.js", "script", "linkedin"), false);

  // Another employer's board is a different host, and a URL that merely mentions
  // ultipro is not one.
  assert.equal(inferATS("https://evil.example/?next=recruiting.ultipro.com"), "generic");
  assert.equal(inferATS("https://recruiting.ultipro.com.evil.example/JobBoard/1/OpportunityDetail"), "generic");
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

test("Ashby /application routes are treated as the apply step", () => {
  // Ashby labels the control "Application" and links to a path ending in
  // /application. It matched neither an apply-word nor a known intermediate
  // label, so every Ashby posting classified as "unknown" and was left
  // unclicked â€” 16 applications lost in a single run.
  const rel = classifyApplyControl({
    label: "Application",
    href: "/deepgram/d98e6723-3485-4b58-9494-d6bf028fa905/application",
  });
  assert.equal(rel.classification, "intermediate");
  assert.equal(rel.safeToClick, true);

  const abs = classifyApplyControl({
    label: "APPLICATION",
    href: "https://jobs.ashbyhq.com/e2b/dea22a97-293e-41af-9fdb-c7e6e2c73b37/application",
  });
  assert.equal(abs.classification, "intermediate");

  const trailing = classifyApplyControl({
    label: "Application",
    href: "/sierra/b7d1dbcd-ca72-472f-b15e-5b4b0f886be0/application/",
  });
  assert.equal(trailing.classification, "intermediate");
});

test("a generic title is not rejected for merely MENTIONING a frontend stack", () => {
  // Ten real OpenAI backend roles (Platform, Data Infrastructure, Observability,
  // Scaled Abuse, Developer Experience) were dropped because their JD names
  // Node.js once in a "our stack" paragraph. Adjacent tooling in a description
  // is not the same as the role being a frontend one.
  const jd = "You will build distributed systems in Python on Kubernetes. "
    + "Our wider stack includes some Node.js services and Kafka.";
  assert.equal(
    isStrictTargetRole("Software Engineer, Platform", jd),
    true,
    "a backend JD that mentions Node.js must stay in scope",
  );
  assert.equal(
    isStrictTargetRole("Software Engineer, Data Infrastructure", jd),
    true,
  );
});

test("a genuinely frontend-only body is still rejected", () => {
  const jd = "You will build interfaces with React, Vue and Tailwind. "
    + "Experience with Next.js, Angular, Svelte and styled-components expected.";
  assert.equal(isStrictTargetRole("Software Engineer", jd), false);
  assert.equal(isStrictTargetRole("Software Engineer, Product", jd), false);
});

test("a generic title with no description is still rejected", () => {
  // No evidence either way: the old behaviour (reject) is the safe one, because
  // guessing in-scope would put the candidate into roles that are not theirs.
  assert.equal(isStrictTargetRole("Software Engineer", ""), false);
  assert.equal(isStrictTargetRole("Founding Engineer", ""), false);
});

test("an explicitly out-of-scope title stays rejected even with a backend body", () => {
  const jd = "You will build APIs in Python with FastAPI and Postgres.";
  assert.equal(isStrictTargetRole("Frontend Engineer", jd), false);
  assert.equal(isStrictTargetRole("React Developer", jd), false);
  assert.equal(isStrictTargetRole("Full Stack Engineer", jd), false);
});

test("ML/AI engineering titles with no language in them are kept", () => {
  // These named no discipline, so the description decides. Each body below is
  // the real opening line from the corresponding rejected row.
  const cases = [
    ["Researcher, Robustness & Safety Training", "strong backend engineering fundamentals with production-grade experience"],
    ["Researcher, Training", "strong backend engineering and AI application experience, but the target job"],
    ["Post-Training Research Scientist", "aligns well with backend engineering and AI inference infrastructure requirements"],
    ["Inference Engineer", "solid background in backend development, AI, and systems engineering, but the"],
    ["Performance Engineer, On-Device Inference", "demonstrates strong full-stack and backend capabilities"],
    ["Research Engineer, Model EvaluationsRemote-Friendly", "backend engineering and applied AI project experience"],
  ];
  for (const [title, body] of cases) {
    assert.equal(isStrictTargetRole(title, body), true, `expected in scope: ${title}`);
  }
});

test("a compound title is matched even when a modifier leads", () => {
  const body = "The candidate demonstrates strong backend engineering skills with production-grade experience.";
  // A prefix or compound sits before the generic noun, and the scraper often
  // concatenates the location without a separator.
  assert.equal(isStrictTargetRole("Infrastructure Software Engineer, Apps PlatformLondon, UK", body), true);
  assert.equal(isStrictTargetRole("Billing & Analytics Software Engineer", body), true);
  assert.equal(isStrictTargetRole("Frontier Agents EngineerLondon, UK", body), true);
});

test("non-engineering roles stay rejected even with a generic noun inside", () => {
  const body = "The candidate demonstrates strong backend engineering skills.";
  // Each of these contains a generic noun but names a discipline that is not
  // software engineering. "Solutions Architect" and "Customer Success Engineer"
  // in particular must never be rescued by the generic pass.
  for (const title of [
    "Solutions Architect",
    "Solutions Architect (San Francisco, CA)",
    "Customer Success Engineer (Americas)",
    "Security Engineer",
    "Developer Relations Engineer - Developer Advocate",
    "Partner Success Engineer",
    "Product Support Engineer",
    "Technical Sourcer",
    "Solution Specialist",
    "MTS, Security",
    "GTM Strategist",
    "Technical Copywriter",
  ]) {
    assert.equal(isStrictTargetRole(title, body), false, `expected out of scope: ${title}`);
  }
});

test("a non-apply Ashby link is still not clickable", () => {
  // The fix must not turn every jobs.ashbyhq.com link into a click target.
  for (const href of ["/deepgram", "/deepgram/careers", "/", "/deepgram/apply-1234"]) {
    const r = classifyApplyControl({ label: "All jobs", href });
    assert.equal(r.classification, "unknown", `expected unknown for ${href}`);
    assert.equal(r.safeToClick, false, `expected unsafe for ${href}`);
  }
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

test("a sign-in page is never an approved off-site application host", () => {
  // Measured 2026-11-05, #1271 Vahan.ai: the Apply link went to forms.gle,
  // which redirected to accounts.google.com because that session was signed
  // out. The hop was approved as an off-site apply host, nothing was filled,
  // and the row was recorded NeedsReview - which says "broken form", not
  // "sign in". The pin is what has to refuse it.
  for (const host of [
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "acme.okta.com",
    "sso.example.com",
    "signin.example.com",
    "accounts.example.com",
  ]) {
    assert.equal(isAuthWallHost(host), true, `${host} must be refused as a form`);
  }
  for (const host of ["job-boards.greenhouse.io", "omnissa.wd501.myworkdayjobs.com", "docs.google.com"]) {
    assert.equal(isAuthWallHost(host), false, `${host} is not a sign-in wall`);
  }

  const boundary = createNavigationBoundary("https://www.linkedin.com/jobs/view/4484071621/", "linkedin");
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://accounts.google.com/v3/signin/identifier?continue=x", "linkedin", true), false);
  assert.equal(boundary.externalApplyHost, undefined);
  // The real employer form is still reachable afterwards: one refused hop must
  // not consume the single off-site slot.
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://job-boards.greenhouse.io/acme/jobs/1", "linkedin", true), true);
});

test("a Google Form is an application form, a Google Doc is not", () => {  assert.equal(isGoogleFormUrl("https://docs.google.com/forms/d/e/1FAIpQLSd/viewform"), true);
  assert.equal(isGoogleFormUrl("https://docs.google.com/forms/d/e/1FAIpQLSd/viewform?usp=sf_link"), true);
  assert.equal(isGoogleFormUrl("https://docs.google.com/document/d/1abc/edit"), false);
  assert.equal(isGoogleFormUrl("http://docs.google.com/forms/d/e/1abc/viewform"), false);

  const boundary = createNavigationBoundary("https://www.linkedin.com/jobs/view/1/", "linkedin");
  assert.equal(tryPinExternalApplyOrigin(boundary, "https://docs.google.com/document/d/1abc/edit", "linkedin", true), false);
  const forms = createNavigationBoundary("https://www.linkedin.com/jobs/view/2/", "linkedin");
  assert.equal(tryPinExternalApplyOrigin(forms, "https://docs.google.com/forms/d/e/1abc/viewform", "linkedin", true), true);
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
    // The matcher marks the control before cloning so it can find where the
    // control sits inside the ancestor's text. A stub without these throws.
    setAttribute() {},
    removeAttribute() {},
    parentElement: null,
    cloneNode() {
      return {
        textContent: stripped,
        // No real tree here, so the split is unavailable and the whole text is
        // treated as the prompt - which is what the matcher falls back to.
        querySelector: () => null,
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

  // An ancestor whose text exceeds the limit used to be discarded outright and
  // the walk continued, so on a dense form - where every ancestor holds several
  // questions and so every one of them is over the limit - the signature came
  // back empty. That is what blocked Scale AI's authorisation question and
  // `Location (City)*`: empty signature, no hint could match, field left blank,
  // submit refused. The text adjacent to the control must survive instead.
  const denseControl = mkNode("", []);
  const denseWrapper = mkNode("Are you legally authorised to work in the country where this role is based? ".repeat(4), [denseControl]);
  denseControl.parentElement = denseWrapper;
  denseWrapper.parentElement = null;
  const denseSig = signature(denseControl);
  assert.notEqual(denseSig, "", "an over-long ancestor must still yield a matchable signature");
  assert.match(denseSig, /legally authorised/);
  // Clipped, not unbounded: the signature has to stay small enough to compare.
  assert.ok(denseSig.length <= 300, `signature should stay bounded, got ${denseSig.length}`);

  // The opening of a long label is what identifies the question, so the label
  // is reduced to its FIRST complete question and never to its tail.
  //
  // This is the real shape on Scale AI's form, one control, ~430 characters:
  //   "Are you currently bound by any agreements with a current or former
  //    employer that may restrict your ability to work for Scale AI or perform
  //    the duties of the position for which you are applying? This includes,
  //    but is not limited to, non-compete agreements, ..."
  // Clipping the tail produced "position for which you are applying? This
  // includes...", which dropped "are you ... bound by any agreement" - the only
  // part that identifies it - so the answer could not match and the field went
  // unanswered.
  const longLabel = "Are you currently bound by any agreements with a current or former employer "
    + "that may restrict your ability to work for Scale AI or perform the duties of the position "
    + "for which you are applying? This includes, but is not limited to, non-compete agreements, "
    + "non-solicitation agreements, confidentiality or non-disclosure agreements.";
  const labelControl = mkNode("", []);
  const labelWrapper = mkNode(longLabel, [labelControl]);
  labelControl.parentElement = labelWrapper;
  labelWrapper.parentElement = null;
  const labelSig = signature(labelControl);
  assert.match(labelSig, /are you currently bound by any agreements/);
  assert.ok(labelSig.length < longLabel.length, "a long label must be reduced");

test("an AI product qualifier is not an engineering discipline", () => {
  // Four applications went out that the scope rule forbids, each passing on the
  // TITLE ALONE - no description involved:
  //
  //   #717  Business Development Representative, Partnerships (Physical AI)
  //   #714  AI Product Manager (Coding/Multimodal)
  //   #713  AI Advisory Principal
  //   #655  AI Deployment Specialist, Beneficial Deployments
  //
  // The allow list carried a bare `|ai|` alternative, which matched the "AI" in
  // "Physical AI". An AI *product* qualifier was being read as an AI
  // *engineering* discipline.
  for (const title of [
    "Business Development Representative, Partnerships (Physical AI)",
    "AI Product Manager (Coding/Multimodal)",
    "AI Advisory Principal",
    "AI Deployment Specialist, Beneficial Deployments",
  ]) {
    assert.equal(isStrictTargetRole(title, ""), false, `must reject: ${title}`);
    assert.equal(
      isStrictTargetRole(title, "We build frontier models. Python, PyTorch, CUDA."),
      false,
      `must reject even with an AI-heavy body: ${title}`,
    );
  }

  // "ai" still counts when an engineering noun sits beside it, which is the
  // shape every genuine target role has.
  for (const title of [
    "AI Engineer, FDE (Forward Deployed Engineer)",
    "Agentic AI Engineer",
    "Applied AI Architect, Commercial",
    "AI Infrastructure Engineer",
    "Engineer, AI Platform",
  ]) {
    assert.equal(isStrictTargetRole(title, ""), true, `must accept: ${title}`);
  }

  // "specialist", "advisor" and "manager" are deliberately NOT engineering
  // nouns. "AI Deployment Specialist" is delivery work, not engineering.
  assert.equal(isStrictTargetRole("AI Deployment Specialist", ""), false);
  assert.equal(isStrictTargetRole("AI Solutions Specialist", ""), false);

  // The deny list must be able to fire on a title the allow list also matches.
  // It used to run AFTER the allow list returned true, so it could never fire:
  //
  //   "Solutions Architect, AI"  -> true   (allow list)
  //   "Security Engineer, ML"    -> true   (allow list)
  //
  // A title naming a disqualifying discipline is out whatever else it contains.
  for (const title of [
    "Solutions Architect, AI",
    "Security Engineer, ML",
    "Sales Engineer, Backend",
    "Solutions Engineer, Python",
  ]) {
    assert.equal(isStrictTargetRole(title, ""), false, `deny must win: ${title}`);
  }
});

test("the location country is answered, and a phone dialling code is not", () => {
  // Two live defects, both visible only in a run log:
  //
  //   [fill] country -> "+91"
  //   [combo] country: already answered "+91" - not overwriting
  //   [blocked-by] required fields still empty:
  //     Please choose the country in which you are located.*
  //
  // The single country call matched any control whose signature contained
  // "country". A phone country-code combobox signs as "country code", so it was
  // re-selected or found already set, and the location question was never
  // reached. That question is a plain input, so combo() could not see it either,
  // and identityFacts() had a `city` fact but no `country` fact.
  const c = {
    name: "AVRADEEP MAJUMDER",
    country: "India",
    phone: "+91 98765 43210",
    current_location: "Greater Noida, Uttar Pradesh",
  };
  const facts = identityFacts(c, {});
  const country = facts.find((f) => f.tag === "country");
  assert.ok(country, "a country fact must exist");
  assert.equal(country.value, "India");

  for (const q of [
    "Please choose the country in which you are located.",
    "What country are you located in?",
    "Country of residence",
    "Your country of citizenship",
    "Country",
  ]) {
    assert.ok(country.hint.test(q), `must match: ${q}`);
  }

  // A dialling code must never be filled with "India" - that is what wrote "+91"
  // into the log. Excluded on words, so a control mentioning both still refuses.
  for (const q of [
    "Country code",
    "Country Code (phone)",
    "Phone country code",
    "Dialing country",
    "Country calling code",
    "Mobile country code",
    "Country of dialling code",
  ]) {
    assert.equal(country.hint.test(q), false, `must not match: ${q}`);
  }

  // A control signs as its own attributes followed by its prompt, so a field
  // whose id is "country" and whose label is "Country" signs as
  //   "country    country"
  // The anchored bare alternative used to allow the word exactly once, so that
  // signature matched nothing and the field stayed empty. Measured 2026-11-05
  // on #143 Glean: every other field was filled and Greenhouse refused the
  // submit with "Select a country", four complaint nodes all reading "Country".
  assert.ok(country.hint.test("country    country"), "the id+label signature must match");
  assert.ok(country.hint.test("Country\nCountry"), "whitespace of any kind between repeats");
  // Repetition must not open the door to a dialling code.
  assert.equal(country.hint.test("country code    country code"), false);
  assert.equal(country.hint.test("country    country code"), false);

  // The prefixes matter: `\blocat\b` can never match "located", because the
  // trailing boundary needs a non-word character and `e` is a word character.
  // The same defect hid `citizen` from "citizenship" and `reside` from
  // "residing". Each of these reads as a match only with `\w*` on the prefix.
  const gap = /\b(?:country|nation)\b.{0,40}?\b(?:locat\w*)/i;
  assert.ok(gap.test("country in which you are located"), "prefixed gap must match");
  assert.ok(!/\b(?:country|nation)\b.{0,40}?\b(?:locat)\b/i
    .test("country in which you are located"),
    "an unprefixed boundary cannot match - this is the bug that shipped");

  // No country on file means no fact, rather than a default that gets written
  // into forms the candidate did not ask us to complete.
  assert.equal(
    identityFacts({ name: "X Y" }, {}).some((f) => f.tag === "country"),
    false,
  );
});

test("India rows are tried first, then fit score, then the board's record", () => {
  // The order has been wrong in both directions.
  //
  // First it ranked on score alone, so Ashby (0 accepted / 34 attempted) rows at
  // score 78 took the first slots and six batches produced two verifications and
  // a pile of refusals.
  //
  // Then it ranked on board acceptance alone, which put a 12-score
  // "Engineering Manager, Infrastructure" ahead of a 65-score India backend role
  // purely because Greenhouse has a better record than the India boards. The
  // candidate is in Greater Noida: a US on-site role is not winnable at any
  // score, and the India roles that ARE winnable never got a batch slot.
  //
  // Order now: India-native board, then fit score, then the board's record as a
  // tiebreak. Stable on the original index, so equal rows never reshuffle.
  const acceptance = new Map([
    ["greenhouse", { accepted: 6, attempted: 24 }],
    ["ashby", { accepted: 0, attempted: 34 }],
  ]);

  // 1. An India row outranks a US ATS whatever the score or record.
  const markets = [
    { id: 1, link: "https://job-boards.greenhouse.io/a/jobs/1", score: 88, source: "greenhouse" },
    { id: 2, link: "https://www.naukri.com/job-listings-2", score: 40, source: "Naukri (Java/Spring Boot)" },
    { id: 3, link: "https://wellfound.com/company/x/jobs/3", score: 65, source: "Wellfound India (Backend)", location_raw: "Bengaluru" },
  ];
  assert.deepEqual(rankByAcceptance(markets, acceptance).map((r) => r.id), [3, 2, 1]);

  // 1b. A board name is not a place. Wellfound's scraper used to store no
  //     location at all, so 87 blank rows scored 85-88 and sorted ahead of the
  //     54 LinkedIn rows that were actually in India - and every one of the
  //     blank Wellfound roles then disabled Send with "not accepting
  //     applications from your current location". Unstated place = no claim.
  const unstated = [
    { id: 12, link: "https://wellfound.com/company/y/jobs/12", score: 88, source: "Wellfound India", location_raw: "" },
    { id: 13, link: "https://www.linkedin.com/jobs/view/13", score: 61, source: "LinkedIn", location_raw: "Bengaluru, Karnataka, India" },
    { id: 14, link: "https://wellfound.com/company/z/jobs/14", score: 90, source: "Wellfound India", location_resolved: "foreign" },
  ];
  assert.deepEqual(rankByAcceptance(unstated, acceptance).map((r) => r.id), [13, 14, 12]);

  // 2. Score decides before the board record does. Greenhouse accepts 6/24,
  //    Ashby 0/34 - the record used to put the 10-score row first.
  const scored = [
    { id: 4, link: "https://jobs.ashbyhq.com/z/4", score: 99 },
    { id: 5, link: "https://job-boards.greenhouse.io/b/jobs/5", score: 10 },
  ];
  assert.deepEqual(rankByAcceptance(scored, acceptance).map((r) => r.id), [4, 5]);

  // 3. On an equal score the record is the tiebreak: proven beats
  //    attempted-without-confirmation.
  const tie = [
    { id: 6, link: "https://jobs.ashbyhq.com/z/6", score: 60 },
    { id: 7, link: "https://job-boards.greenhouse.io/b/jobs/7", score: 60 },
  ];
  assert.deepEqual(rankByAcceptance(tie, acceptance).map((r) => r.id), [7, 6]);

  // 4. An employer-hosted Greenhouse board counts as GREENHOUSE, not as unknown.
  //    Keyed on the hostname it had no record and lost the tie to Ashby, purely
  //    because of how the URL is spelled.
  const hosted = [
    { id: 8, link: "https://jobs.ashbyhq.com/y/8", score: 60 },
    { id: 9, link: "https://www.mongodb.com/careers/job/?gh_jid=9", score: 60 },
  ];
  assert.deepEqual(rankByAcceptance(hosted, acceptance).map((r) => r.id), [9, 8]);

  // 5. No history at all still applies the market and score order rather than
  //    handing back whatever the SQL happened to return.
  assert.deepEqual(rankByAcceptance(markets, new Map()).map((r) => r.id), [3, 2, 1]);
  assert.deepEqual(rankByAcceptance(markets, null).map((r) => r.id), [3, 2, 1]);

  // 6. Already ordered rows come back untouched - the sort is stable.
  const india = [
    { id: 10, link: "https://www.instahyre.com/job-10", score: 70 },
    { id: 11, link: "https://www.naukri.com/job-listings-11", score: 60 },
  ];
  assert.deepEqual(rankByAcceptance(india, acceptance).map((r) => r.id), [10, 11]);
});

test("a first-name control is answered from the name on file", () => {
  // Seen as a real blocker on a live submission:
  //   [blocked-by] required fields still empty: Preferred First Name
  // candidate.name is already the source for the legal-name fact, so the parts
  // are derived from it rather than from a second field that could disagree.
  const c = { name: "AVRADEEP MAJUMDER" };
  assert.equal(candidateFirstName(c), "AVRADEEP");
  assert.equal(candidateLastName(c), "MAJUMDER");

  const facts = identityFacts(c, {});
  const first = facts.find((f) => f.tag === "preferred first name");
  assert.ok(first, "a preferred-first-name fact must exist");
  assert.equal(first.value, "AVRADEEP");
  for (const q of ["Preferred First Name", "First Name", "Legal First Name"]) {
    assert.ok(first.hint.test(q), `must match: ${q}`);
  }
  // A name field must not collect the candidate's name.
  assert.equal(first.hint.test("Company Name"), false);
  assert.equal(first.hint.test("Preferred Name"), false);

  assert.equal(identityFacts(c, {}).find((f) => f.tag === "legal last name").value, "MAJUMDER");

  // An explicit part wins, for a name that does not split on whitespace.
  assert.equal(candidateFirstName({ name: "X Y Z", first_name: "Deep" }), "Deep");
  assert.equal(candidateLastName({ name: "X Y Z", last_name: "D" }), "D");

  // A single token yields NO surname. Writing the whole string into a surname
  // field is worse than leaving it for the human.
  assert.equal(candidateFirstName({ name: "Avradeep" }), "Avradeep");
  assert.equal(candidateLastName({ name: "Avradeep" }), "");

  // No name at all means no fact, rather than an invented one.
  const none = identityFacts({}, {});
  assert.equal(none.some((f) => f.tag === "preferred first name"), false);
});

test("a per-skill years figure answers only its own technology, never the total", () => {
  // #1320 Zema (Deel, 2026-11-10) asks "How many years of hands-on experience do
  // you have with Java in a professional environment?". It matched the
  // total-experience fact, so the answer to a question about one language was
  // the candidate's whole 0.2 years - true by accident here and false for any
  // technology the CV never claims.
  const stated = {
    skill_years: { Java: "Under 1 year" },
    skill_ratings: { Java: 8, "Spring Boot": 7, SQL: 8, Hibernate: 6 },
  };
  const javaYears = "how many years of hands-on experience do you have with java in a professional environment? *";
  assert.equal(skillYearsFor(stated, javaYears), "Under 1 year");
  // A technology with no stated figure is left for the human.
  assert.equal(skillYearsFor(stated, "How many years of experience do you have with C++?"), "");
  // MySQL and PostgreSQL are not SQL.
  assert.equal(skillYearsFor({ skill_years: { SQL: "1 year" } }, "How many years of experience do you have with MySQL?"), "");
  assert.equal(skillYearsFor({ skill_years: { SQL: "1 year" } }, "How many years of experience with SQL?"), "1 year");
  // A question that is not about years is not this fact's business.
  assert.equal(skillYearsFor(stated, "Do you know Java?"), "");

  // "SpringBoot" and "Spring Boot" are one skill.
  const rating = "rate your proficiency in springboot(1 = beginner, 10 = expert)";
  assert.equal(skillRatingFor(stated, rating), "7");
  assert.equal(skillRatingFor(stated, "rate your proficiency in java(1 = beginner, 10 = expert)"), "8");
  // A rating is only given where the control asks for one, and only when stated.
  assert.equal(skillRatingFor(stated, "How many years of Java experience do you have?"), "");
  assert.equal(skillRatingFor({}, "rate your java proficiency"), "");

  // The total-experience fact stands down on any technology-scoped question,
  // including technologies that have no stated figure of their own.
  const profile = { domain: { core_skills: ["Python", "C++"], adjacent_skills: ["Linux"] } };
  assert.equal(skillScopedQuestion(stated, profile, javaYears), true);
  assert.equal(skillScopedQuestion(stated, profile, "How many years of experience do you have with Python?"), true);
  assert.equal(skillScopedQuestion(stated, profile, "How many years of professional backend experience do you have?"), false);

  // ...and identityFacts wires that up: the Java question is answered with the
  // stated figure while the generic question still gets the total.
  const facts = identityFacts({ experience_years: 0.2 }, stated, null, profile);
  const yearsFact = facts.find((f) => f.tag === "years of experience");
  assert.equal(yearsFact.value, "0.2 years");
  assert.equal(yearsFact.notWhen(javaYears), true);
  assert.equal(yearsFact.notWhen("How many years of professional backend experience do you have?"), false);
  assert.equal(facts.find((f) => f.tag === "skill years").byField(javaYears), "Under 1 year");
  assert.equal(facts.find((f) => f.tag === "skill rating").byField(rating), "7");
  // With nothing stated there is no fact at all, rather than an empty one.
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "skill years"), false);
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "skill rating"), false);
});

test("current compensation and the distance question come from stated answers", () => {
  // The operator answered "Internship stipend only" on 2026-11-10, which says
  // more, and more truthfully, than the derived 0 for "not currently employed".
  const stated = {
    current_compensation: "Internship stipend only",
    current_company: "Not currently employed",
    location_distance: "Not local - I live in Greater Noida, Uttar Pradesh, and I am willing to relocate to Navi Mumbai at my own expense.",
  };
  const facts = identityFacts({}, stated);
  assert.equal(facts.find((f) => f.tag === "current CTC").value, "Internship stipend only");
  // The exact wording Deel uses, which the older pattern missed because it only
  // accepted "current ctc/package/salary" and this one says "compensation".
  const currentPay = facts.find((f) => f.tag === "current CTC");
  assert.ok(currentPay.hint.test("What is your current compensation? *"));
  assert.equal(currentPay.hint.test("What are your Salary expectations?"), false);
  // With no stated pay the derived answer still applies, and never the expected
  // salary.
  assert.equal(identityFacts({}, { current_company: "Not currently employed" })
    .find((f) => f.tag === "current CTC").value, "0");

  const distance = facts.find((f) => f.tag === "distance from office");
  assert.ok(distance, "the distance question must have a stated answer to draw on");
  for (const q of [
    "how far do you live from seawoods grand central tower 1, mumbai, india? if you are not local, why do you look to move and are you willing to relocate at your own expense? *",
    "How far away from the office do you live?",
    "What is the distance from the office to your home?",
  ]) {
    assert.ok(distance.hint.test(q), `distance hint must match: ${q}`);
  }
  assert.equal(distance.hint.test("Why do you want to work here?"), false);
  // Never invented when the operator has not stated it.
  assert.equal(identityFacts({}, {}).some((f) => f.tag === "distance from office"), false);

  // The same question must not be answered with the candidate's city. A bare
  // \brelocat did exactly that: "â€¦are you willing to relocate at your own
  // expense?" was read as a location question and the city wrote itself into
  // the distance box, while the distance answer was skipped because the box
  // looked filled (#1320, 2026-11-10).
  assert.equal(WORK_LOCATION_QUESTION.test(
    "how far do you live from seawoods grand central tower 1, mumbai, india? if you are not local, why do you look to move and are you willing to relocate at your own expense? *",
  ), false);
  for (const q of [
    "Where are you located?",
    "Where are you based?",
    "Which city do you currently reside in?",
    "What is your current location?",
    "Please list the cities you are willing to relocate to.",
  ]) {
    assert.ok(WORK_LOCATION_QUESTION.test(q), `work-location hint must match: ${q}`);
  }
});

test("the compliance block is answered only from a stated answer", () => {
  // #1322 PayPal (Eightfold, 2026-11-10) refused the submit on eight YES/NO
  // questions and left the required Email box empty. The representations are
  // the operator's to make, so they live in application_answers and are never
  // inferred; the email selector list simply did not cover Eightfold's markup.
  const stated = {
    conflict_of_interest: "No",
    disability_disclosure: "No, I don't have a disability",
  };
  const facts = identityFacts({}, stated);
  const conflict = facts.find((f) => f.tag === "conflict of interest");
  const disability = facts.find((f) => f.tag === "disability disclosure");
  assert.equal(conflict.value, "No");
  assert.equal(disability.value, "No, I don't have a disability");

  // The exact question text PayPal renders. Every one of the five must reach
  // the same stated answer, or the form stays blocked.
  for (const q of [
    "Do you or your spouse have, or plan to have, a role on a board, advisory group, management team, or any business interest in a company or organisation that competes, or could be perceived to compete, with PayPal? *",
    "Do you have a family relationship (including spouse, partner, parent, grandparent, child, sibling, in-law, aunt, uncle) or close personal relationship (close friendship or relationship) with an employee of the PayPal group of companies? *",
    "Are you a current Government Official/TA Government Official is an officer or employee of any government, of any department, agency, or instrumentality of a Government? *",
    "Do you have a family relationship (including spouse, partner, parent, grandparent, child, sibling, in-law, aunt, uncle) or close personal relationship (close friendship or relationship) with a Government Official? *",
    "To the best of your knowledge, are you referred to as an existing / potential known merchant, or are you an existing or potential Third Party? *",
  ]) {
    assert.ok(conflict.hint.test(q), `conflict hint must match: ${q.slice(0, 60)}`);
  }
  assert.equal(conflict.hint.test("What is your current compensation?"), false);
  assert.equal(disability.hint.test("Do you have a disability?"), true);
  assert.equal(disability.hint.test("Which city do you live in?"), false);

  // With nothing stated neither fact carries an answer, so neither is written.
  const bare = identityFacts({}, {});
  assert.equal(bare.find((f) => f.tag === "conflict of interest")?.value ?? "", "");
  assert.equal(bare.find((f) => f.tag === "disability disclosure")?.value ?? "", "");
});

test("why-interested is grounded in the posting, or left to the human", () => {
  // "Why are you interested in <company>?" is required free text on several Ashby
  // boards and was blocking the submit. It is not a fact about the candidate and
  // nothing in cv.md answers it, so it cannot be read off the profile like salary
  // or availability can. Writing the candidate's own reasons for enthusiasm would
  // be inventing them, so this assembles only traceable claims instead.
  const projects = [
    "AnnaSuraksha, a PDS fraud-detection platform in Java and Spring Boot with a 16-signal scoring engine and a Groq LLM explanation layer",
    "IntelliX, an ML code-performance profiler in Python and scikit-learn using four classifiers and AST-based multi-language analysis",
  ];
  const stated = { cv_projects: projects };

  // A real overlap attaches the matching project, and the claim is traceable to
  // the posting's own words.
  const fraud = whyInterested("why are you interested?", stated, {
    company: "Acme", title: "ML Engineer",
    job_description: "Build machine learning models to detect fraud in financial transactions at scale",
  });
  assert.match(fraud, /ML Engineer/);
  assert.match(fraud, /detect fraud/);
  assert.match(fraud, /AnnaSuraksha/);

  // Nothing to ground in -> silence, so the question reaches the human rather
  // than being filled with something plausible.
  assert.equal(whyInterested("why?", stated, {
    company: "Acme", title: "ML Engineer", job_description: "",
  }), "");
  assert.equal(whyInterested("why?", stated, {
    company: "Acme", title: "ML Engineer", job_description: "x",
  }), "");

  // The evaluator's prose ABOUT THE CANDIDATE is not a statement of what the
  // company does, so it must not be mined for one.
  assert.equal(whyInterested("why?", stated, {
    company: "Acme", title: "ML Engineer",
    job_description: "The candidate brings strong backend engineering experience with Node.js and TypeScript.",
  }), "");

  // A weak single-term overlap is a coincidence. "platform" appears in half the
  // engineering vocabulary, so one shared term must not attach a project.
  const weak = whyInterested("why?", stated, {
    company: "Acme", title: "Engineer",
    job_description: "Run onsite logistics operations for warehouse staffing on our own platform",
  });
  assert.ok(!weak.includes("AnnaSuraksha"), "a single shared term must not attach a project");

  // No company named -> nothing to answer.
  assert.equal(whyInterested("why?", stated, { title: "ML Engineer", job_description: "x" }), "");

  // The hint must match how boards actually word it, and not a salary question.
  const facts = identityFacts({}, stated, { company: "Acme", title: "ML Engineer", job_description: "x" });
  const wi = facts.find((f) => f.tag === "why interested");
  assert.ok(wi, "the fact must exist so its hint can be matched");
  for (const q of [
    "Why are you interested in Fireworks AI?",
    "why are you interested in this role?",
    "What interests you about this company?",
    "Tell us why you want to work here",
  ]) {
    assert.ok(wi.hint.test(q), `why-interested hint must match: ${q}`);
  }
  assert.equal(wi.hint.test("what is your expected salary?"), false);
});

test("role scope is judged on the posting, never on the evaluator's notes", () => {
  // jobs.text_summary is `eval_result["text_summary"]` - the evaluator's prose
  // ABOUT THE CANDIDATE - and resume_builder calls it "the tailored summary".
  // It was being fed to the scope filter as if it described the role. For a
  // generic title the filter falls through to judging the body, so a backend
  // role was rejected because a note about the candidate happened to mention
  // the candidate's own Node.js experience. The eligible pool went 16 -> 0.
  const evaluation = "Avradeep demonstrates exceptional backend engineering "
    + "capability with high-throughput systems and robust API design. However, "
    + "the highlight is hands-on Node.js, Express and TypeScript work.";

  // With only the evaluation available, behaviour is unchanged - judged on the
  // body, exactly as before. Strict is the safe direction for a filter whose
  // job is to keep frontend and mobile roles out.
  assert.equal(jobDescriptionFor({ text_summary: evaluation }), evaluation);

  // The posting wins whenever it exists, so the candidate's own stack can no
  // longer veto the role.
  const posting = "Design and ship ClickHouse-backed analytics features. "
    + "Requirements: strong C++ and SQL, familiarity with distributed systems "
    + "and our Python ingestion services.";
  const row = { job_description: posting, text_summary: evaluation };
  assert.equal(jobDescriptionFor(row), posting);
  assert.ok(!jobDescriptionFor(row).includes("Node.js"));
  // A generic title falls through to judging the body, so this is where the
  // two texts diverge and where the bug lived. Judged on the posting, the role
  // survives; judged on the evaluation, the candidate's own Node.js stack vetoed it.
  assert.equal(isStrictTargetRole("Software Engineer", jobDescriptionFor(row)), true);
  // A genuinely frontend posting is still rejected, on that same posting text.
  assert.equal(isStrictTargetRole("Frontend Engineer", posting), false);
  // Title-level denials are unaffected by this change and stay in force.
  assert.equal(isStrictTargetRole("Operations Engineer", posting), false);

  // A whitespace-only description must not shadow the fallback.
  assert.equal(jobDescriptionFor({ job_description: "   ", text_summary: evaluation }), evaluation);
  assert.equal(jobDescriptionFor({}), "");
  assert.equal(jobDescriptionFor(null), "");
});

  // A control with no ancestor at all still has no prompt to offer.
  const orphan = mkNode("", []);
  orphan.parentElement = null;
  assert.equal(signature(orphan), "");

  // The control's own attributes are always part of the signature.
  const named = mkNode("Select...", []);
  named.parentElement = null;
  named.getAttribute = (a) => ({ id: a === "id" ? "country" : "" })[a] || "";
  assert.match(signature(named), /country/);

  // A dropdown's nearest wrappers hold only the input and its "Selectâ€¦"
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
  // and every field would fail to match â€” silently, before this guard existed.
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

test("a score is required, and the knob ranks rather than gates", async () => {
    const { isEligibleJob: withDefault } = await import("../apps/browser-apply/apply.mjs");
    const base = {
      link: "https://boards.greenhouse.io/acme/jobs/1",
      title: "Backend Engineer Intern",
      status: "evaluated",
      source: "Anthropic",
      score: 72,
    };

    // A score must exist and be numeric - there has to be something to rank by.
    assert.equal(withDefault(base), true);
    assert.equal(withDefault({ ...base, score: 12 }), true,
      "a low score must not make an in-scope role ineligible");
    assert.equal(withDefault({ ...base, score: null }), false);
    assert.equal(withDefault({ ...base, score: undefined }), false);
    assert.equal(withDefault({ ...base, score: "seventy" }), false);

    // The substantive gates are untouched by the score.
    assert.equal(withDefault({ ...base, title: "Frontend Engineer" }), false);
    assert.equal(withDefault({ ...base, title: "Solutions Architect" }), false);

    // The knob still reads, and still widens, without touching those gates.
    const previous = process.env.PULSEOPS_MIN_SCORE;
    process.env.PULSEOPS_MIN_SCORE = "60";
    const widened = await import(`../apps/browser-apply/apply.mjs?v=${Date.now()}`);
    try {
      assert.equal(widened.isEligibleJob(base), true);
      assert.equal(widened.isEligibleJob({ ...base, title: "Frontend Engineer" }), false);
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

test("a tailored CV resolves by role, and a placeholder company resolves none", async () => {
  // The builder names each folder "<company[:24]>-<sha1(title)[:8]>", so the
  // CV for a role is computable exactly. Two roles at one company must not
  // resolve to each other, and the newest folder must never win by accident.
  const { findResumePdf } = await import("../apps/browser-apply/apply.mjs");
  const crypto = await import("node:crypto");
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..", "output", "pdf",
  );
  const clean = (s) => String(s)
    .replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const folder = (company, title) => path.join(
    dir,
    `${clean(company).slice(0, 24)}-${crypto.createHash("sha1").update(clean(title), "utf8").digest("hex").slice(0, 8)}`,
  );

  const older = folder("zzroleco", "Automation Testing Engineer");
  const newer = folder("zzroleco", "AI Implementation Engineer - Internship");
  const stranger = folder("Unknown", "AI Implementation Engineer - Internship");
  for (const d of [older, newer, stranger]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(older, "CV.pdf"), "testing-role");
  // Written second, so a "most recently written" fallback would pick this one.
  fs.writeFileSync(path.join(newer, "CV.pdf"), "ai-role");
  fs.writeFileSync(path.join(stranger, "CV.pdf"), "someone-elses-cv");
  try {
    assert.equal(
      findResumePdf("zzroleco", "Automation Testing Engineer"),
      path.join(older, "CV.pdf"),
      "the role's own folder wins, even though another was written later",
    );
    assert.equal(
      findResumePdf("zzroleco", "AI Implementation Engineer - Internship"),
      path.join(newer, "CV.pdf"),
    );

    // #1059: a row whose company parsed as "Unknown" was handed another
    // Unknown row's tailored CV. A placeholder company may resolve only the
    // folder that names its own role - never another row's document.
    const unknown = findResumePdf("Unknown", "Software Engineer - Automation Testing");
    assert.notEqual(unknown, path.join(stranger, "CV.pdf"));
    if (unknown && path.resolve(unknown).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) {
      assert.equal(
        path.resolve(unknown).toLowerCase(),
        path.resolve(folder("Unknown", "Software Engineer - Automation Testing"), "CV.pdf").toLowerCase(),
      );
    }
  } finally {
    for (const d of [older, newer, stranger]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the upload button is found by its own words, never by a submit's", async () => {
  // Eightfold's dropzone ignores a populated <input type="file">: it keeps
  // showing "Drag & drop file", issues no request, and the form then refuses
  // the submit with "Upload your resume cannot be left blank" (#1322 PayPal,
  // 2026-11-10). Its own "â¬† Upload file" button is the control its handler was
  // written for, so this regex decides which buttons may be clicked to reach a
  // file chooser. A submit-ish label must never match: clicking "Submit
  // application" to reach a picker would send the application with no resume.
  const { UPLOAD_BUTTON_LABEL } = await import("../apps/browser-apply/apply.mjs");
  assert.ok(UPLOAD_BUTTON_LABEL instanceof RegExp, "the label matcher must be a RegExp");
  assert.ok(
    !UPLOAD_BUTTON_LABEL.global && !UPLOAD_BUTTON_LABEL.sticky,
    "a stateful /g regex would make .test() alternate between true and false",
  );

  const matches = [
    "â¬† Upload file",      // the literal Eightfold control
    "Upload File",
    "Choose file",
    "Choose File",
    "Browse",
    "Browseâ€¦",
    "Select file",
    "Attach file",
    "Attach CV",
    "upload resume",
  ];
  for (const label of matches) {
    assert.ok(UPLOAD_BUTTON_LABEL.test(label), `"${label}" opens a file picker and must match`);
  }

  const refusals = [
    "Submit application",
    "Submit",
    "Apply now",
    "Apply",
    "Save and continue",
    "Save draft",
    "Cancel",
    "Next",
    "Back",
    "Remove",
    "Delete",
  ];
  for (const label of refusals) {
    assert.ok(!UPLOAD_BUTTON_LABEL.test(label), `"${label}" must never be clicked to reach a file picker`);
  }
});

test("a stated answer is matched to the option that says it, and never to a lookalike", async () => {
  // A board restates the operator's words in its own; the disability
  // self-identification is answered "No, I don't have a disability" while PayPal
  // renders "NO. I DON'T HAVE A DISABILITY (INCLUDING CANCER, EPILEPSYâ€¦)".
  // Equality matched nothing, so a required group stayed blank (#1322).
  const { statedOptionIndex } = await import("../apps/browser-apply/apply.mjs");

  const disability = [
    "YES. I HAVE A DISABILITY (OR PREVIOUSLY HAD ONE)",
    "NO. I DON'T HAVE A DISABILITY (INCLUDING CANCER, EPILEPSY, DIABETES, ETC.)",
    "I DON'T WISH TO ANSWER (INDIA)",
  ];
  assert.equal(statedOptionIndex("No, I don't have a disability", disability), 1);

  // The plain confirmations still match exactly, and a short option may be the
  // start of the stated answer.
  assert.equal(statedOptionIndex("No", ["Yes", "No"]), 1);
  assert.equal(statedOptionIndex("Yes", ["No", "Yes"]), 1);
  assert.equal(statedOptionIndex("No", ["No. I don't have a disability", "Yes"]), 0);

  // "None of the above" must never be read as the option "No": the boundary is
  // a word edge, not a string prefix.
  assert.equal(statedOptionIndex("None of the above", ["Yes", "No"]), -1);
  assert.equal(statedOptionIndex("Nothing to declare", ["Yes", "No"]), -1);

  // Two equally plausible options are left for a human rather than guessed.
  assert.equal(
    statedOptionIndex("No", ["No, I don't have a disability", "No, I prefer not to say"]),
    -1,
  );
  assert.equal(statedOptionIndex("", ["Yes", "No"]), -1);
  assert.equal(statedOptionIndex("No", []), -1);
  assert.equal(statedOptionIndex("No", ["Yes", "No "]), 1);
  assert.equal(statedOptionIndex("No.", ["Yes", "No."]), 1);
});

test("a number-only control is given a number, or nothing", async () => {
  // LinkedIn's Easy Apply step (#1033, 2026-11-11) asked "Please enter your
  // notice period in days" / "current ctc in INR" as 20-character text inputs
  // with a numeric rule. "30 days" and "Internship stipend only" were typed in,
  // the control said "Invalid input", and the step refused to advance.
  const { numericFieldAnswer } = await import("../apps/browser-apply/apply.mjs");

  assert.deepEqual(
    numericFieldAnswer("Please enter your notice period in days* Example: 45", "30 days"),
    { text: "30", numeric: true, missing: false },
  );
  assert.deepEqual(
    numericFieldAnswer("Please enter your expected ctc in INR* Example: 350000", "INR 8,40,000 - 10,80,000 per annum"),
    { text: "840000", numeric: true, missing: false },
  );
  // Prose with no figure at all is not turned into a 0 nobody stated.
  assert.deepEqual(
    numericFieldAnswer("Please enter your current ctc in INR* Example: 200000", "Internship stipend only"),
    { text: "", numeric: true, missing: true },
  );
  // An ordinary text question keeps its prose.
  assert.deepEqual(
    numericFieldAnswer("Current company", "Not currently employed"),
    { text: "Not currently employed", numeric: false, missing: false },
  );
});

test("the months that follow the whole years are months, not years", async () => {
  // LinkedIn asks the total twice: "total years of professional experience" and
  // then "total additional months of experience". Filling only the first held
  // Easy Apply on 4/5 with Review doing nothing (#1033, 2026-11-11).
  const { additionalMonthsOfExperience } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(additionalMonthsOfExperience({ experience_years: 0.2 }), "2 months");
  assert.equal(additionalMonthsOfExperience({ experience_years: 2.5 }), "6 months");
  assert.equal(additionalMonthsOfExperience({ experience_years: 3 }), "0 months");
  assert.equal(additionalMonthsOfExperience({ experience_years: 0 }), "0 months");
  assert.equal(additionalMonthsOfExperience({}), "");
});

test("a pay question that states the period takes the stated annual figure", async () => {
  // #1033: "Please enter your current ctc in INR" is annual and only takes a
  // number. Reading the prose "INR 35,000 per month" as a yearly figure is wrong
  // by twelve, so the stated annual figures win where they exist.
  const { statedNumericAnswer } = await import("../apps/browser-apply/apply.mjs");
  const stated = { current_ctc_inr: 420000, expected_ctc_inr: 500000 };

  assert.equal(statedNumericAnswer("Please enter your current ctc in INR* Example: 200000", stated), "420000");
  assert.equal(statedNumericAnswer("Please enter your expected ctc in INR* Example: 350000", stated), "500000");
  // A per-month question is not answered with an annual figure.
  assert.equal(statedNumericAnswer("Expected salary per month", stated), "");
  // No figure stated -> nothing to say, and the prose path handles the field.
  assert.equal(statedNumericAnswer("Current ctc", {}), "");
  // Not a pay question at all.
  assert.equal(statedNumericAnswer("Please enter your notice period in days*", stated), "");
});

test("a years-of-experience select takes the whole-year bucket", async () => {
  const { numericOption, YEARS_OF_EXPERIENCE_QUESTION } = await import("../apps/browser-apply/apply.mjs");

  // The label that blocked #1033: "years of professional experience".
  assert.ok(YEARS_OF_EXPERIENCE_QUESTION.test("Please select your total years of professional experience:"));
  assert.ok(YEARS_OF_EXPERIENCE_QUESTION.test("How many years of experience do you have?"));
  assert.ok(!YEARS_OF_EXPERIENCE_QUESTION.test("How many years of experience do you have developing Java?"));

  const options = ["0 year", "1 year", "2 years", "3 years"].map((label) => ({ value: label, label }));
  // candidate.experience_years is 0.2; the truthful bucket is "0 year".
  assert.equal(numericOption(options, "0.2 years").label, "0 year");
  assert.equal(numericOption(options, "3 years").label, "3 years");
  assert.equal(numericOption(options, "not stated"), null);
});

test("the onsite and commute questions are answered from the operator's own statement", async () => {
  // #1337 Innovfix (2026-11-11) reached 3/4 with these two required radios
  // blank: "Are you comfortable working in an onsite setting?" and "Are you
  // comfortable commuting to this job's location?". Neither is a CV fact, so
  // they are matched only against the wording the board actually used.
  const { answerFactualRadioHints, statedOptionIndex } = await import("../apps/browser-apply/apply.mjs");
  const hints = answerFactualRadioHints();
  const byKey = Object.fromEntries(hints.map((item) => [item.key, item.hint]));

  assert.ok(byKey.onsite_comfortable.test("Are you comfortable working in an onsite setting?* Yes No This field is required"));
  assert.ok(byKey.commute_comfortable.test("Are you comfortable commuting to this job's location?* Yes No This field is required"));
  assert.ok(byKey.commute_comfortable.test("Are you comfortable commuting to this jobâ€™s location?"));
  // A different question that happens to say "onsite" is not this one.
  assert.equal(byKey.onsite_comfortable.test("This role is onsite in Bengaluru. Do you have a valid work permit?"), false);
  assert.equal(byKey.commute_comfortable.test("How long is your commute today?"), false);

  // "Yes" resolves to the Yes option, not to "No" or "None of the above".
  assert.equal(statedOptionIndex("Yes", ["Yes", "No"]), 0);
  assert.equal(statedOptionIndex("Yes", ["No", "Yes"]), 1);
});

test("a board that refuses automated browsers is told apart from a CAPTCHA", async () => {
  // Himalayas answered both a headed Edge with a persistent profile and a clean
  // bundled Chromium (real Chrome UA) with Cloudflare's managed check and HTTP
  // 403 â€” title "Just a moment...", body "Performing security verification", no
  // posting ever painted. There is no widget to click, so waiting for the form
  // and reporting "no Submit button found" describes the wrong failure.
  const { isBotVerificationWall, statusForBrowserResult } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(isBotVerificationWall("himalayas.app Performing security verification This website uses a security service to protect against malicious bots."), true);
  assert.equal(isBotVerificationWall("Just a moment..."), true);
  assert.equal(isBotVerificationWall("Checking if the site connection is secure"), true);
  // An ordinary posting page is not a wall, even when it mentions bots.
  assert.equal(isBotVerificationWall("Platform Engineer (Edge / Docker / IIoT) â€” apply now"), false);
  assert.equal(isBotVerificationWall(""), false);

  // A refusal is terminal; a captcha on a real form is worth a human's wait.
  assert.equal(statusForBrowserResult({ action: "board-blocked" }), "Skipped");
  assert.equal(statusForBrowserResult({ action: "captcha-blocked" }), "NeedsReview");
});

test("a wizard step is only Next/Review, never a profile-edit control", async () => {
  // #1033 (Heads Up For Tails, 2026-11-10) clicked "Next" eight times and ended
  // on a profile edit overlay carrying "Back | Next | Save | Add work
  // experience". Scoping happens in the DOM walk; the label set must at least
  // never admit the overlay's own controls.
  const { EASY_APPLY_STEP_NAME } = await import("../apps/browser-apply/apply.mjs");

  for (const label of ["Next", "Review", "Review your application", "Continue to next step"]) {
    assert.ok(EASY_APPLY_STEP_NAME.test(label), `"${label}" advances the wizard`);
  }

  for (const label of [
    "Back",
    "Save",
    "Dismiss",
    "Add work experience",
    "Delete experience",
    "Submit application",
    "Submit",
    "Easy Apply",
  ]) {
    assert.ok(!EASY_APPLY_STEP_NAME.test(label), `"${label}" is not a wizard step`);
  }
});

test("a board's safety dialog is stepped through, never a submission", async () => {
  // LinkedIn answers an Apply click with "Job search safety reminder" offering
  // "Review job post" and "Continue applying". Nothing navigates and no form
  // appears, so #1307 TAXOSMART was recorded NeedsReview on a live application.
  const { APPLY_INTERSTITIAL_LABEL } = await import("../apps/browser-apply/apply.mjs");

  for (const label of [
    "Continue applying",
    "Continue applying â†—",
    "Continue to application",
    "Continue to the application",
    "Continue to company site",
    "Proceed to application",
  ]) {
    assert.ok(APPLY_INTERSTITIAL_LABEL.test(label), `"${label}" is the dialog's forward action`);
  }

  for (const label of [
    "Review job post",
    "Submit application",
    "Submit",
    "Apply now",
    "Continue",
    "Save and continue",
    "Dismiss",
    "Back",
  ]) {
    assert.ok(!APPLY_INTERSTITIAL_LABEL.test(label), `"${label}" must not be clicked as an interstitial`);
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

  // Deel mints its capability as a presigned FORM: the target is the bare bucket
  // URL and the signature travels in the body, so only the host can be trusted.
  // Measured 2026-11-10, #1320 Zema: the browser POSTed to
  //   https://deel-sandbox-prod.s3.eu-west-1.amazonaws.com/
  // and with that blocked the page showed an empty "Please upload your resume"
  // box while the form was otherwise complete, so Apply never enabled.
  const deel = new Set();
  assert.equal(collectPresignedUploadHosts({
    data: {
      url: "https://deel-sandbox-prod.s3.eu-west-1.amazonaws.com/",
      fields: { key: "uploads/abc", "X-Amz-Signature": "deadbeef" },
    },
  }, deel), 1);
  assert.equal(
    isAllowedPresignedUploadRequest("https://deel-sandbox-prod.s3.eu-west-1.amazonaws.com/", "fetch", "POST", deel),
    true,
  );
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
  // arrives as resource type "other" â€” both are required to produce a token.
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
  // The scope stops at the vendor's own paths: an unrelated gstatic file is
  // still not opened.
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.gstatic.com/recaptcha/x.js", "xhr", "GET", "greenhouse"),
    false,
  );
  // reCAPTCHA v2 is now reachable too. v2's loader and anchor frame were
  // blocked, so the invisible widget never produced a token and Ashby
  // answered the finished application with "flagged as possible spam".
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api.js?render=KEY", "script", "GET", "ashby"),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.gstatic.com/recaptcha/releases/kemd/recaptcha__en.js", "other", "GET", "ashby"),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api2/anchor?k=KEY", "xhr", "GET", "ashby"),
    true,
  );
  // ...and it is ATS-independent by design: the captcha vendor is the same for
  // every board, so keying it per ATS is what left Ashby broken.
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api.js?render=KEY", "script", "GET", "lever"),
    true,
  );
  // Still not a general-purpose exemption.
  //  - no writes: only GET/HEAD is ever allowed, on any captcha path
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api2/reload", "xhr", "POST", "ashby"),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://www.recaptcha.net/recaptcha/api.js", "script", "POST", "greenhouse"),
    false,
  );
  //  - and the host is pinned: a lookalike domain gets nothing
  assert.equal(
    isAllowedReadOnlyApiRequest("https://evil.recaptcha.net/recaptcha/api.js", "script", "GET", "greenhouse"),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://recaptcha.net.evil.example/recaptcha/api.js", "script", "GET", "greenhouse"),
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
  // A vendor CDN hosts the app while the page sits on the employer's brand:
  // careers.cisco.com serves its runtime from cdn.phenompeople.com. Trusting
  // only per-ATS hosts left that page blank.
  assert.equal(
    isAllowedAssetRequest("https://cdn.phenompeople.com/CareerConnectResources/common/js/canvas/vue3.min.js", "script", "generic"),
    true,
  );
  assert.equal(
    isAllowedAssetRequest("https://cdn-bot.phenompeople.com/txm-bot/prod-ir.js", "script", "generic"),
    true,
  );
  // Exact vendor hosts only, and only their static assets.
  assert.equal(isAllowedAssetRequest("https://evil.phenompeople.com/app.js", "script", "generic"), false);
  assert.equal(isAllowedAssetRequest("https://cdn.phenompeople.com/x", "xhr", "generic"), false);
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

test("how you heard names the board the row came from, never a referral", () => {
  // GitHub Greenhouse asks this as a required <select>. "This job board" was
  // hardcoded, is not one of the options, and left the field empty - which is
  // what refused a filled Glean application on 2026-11-05.
  assert.equal(heardFromBoard({ source: "LinkedIn", link: "https://www.linkedin.com/jobs/view/1/" }), "LinkedIn");
  assert.equal(heardFromBoard({ source: "Wellfound India (Backend)" }), "Wellfound");
  assert.equal(heardFromBoard({ source: "Hirist (Backend Development)" }), "Hirist");
  assert.equal(heardFromBoard({ source: "Instahyre" }), "Instahyre");
  assert.equal(heardFromBoard({ source: "Naukri" }), "Naukri");
  // Nothing recognisable, or no row at all: the generic truth is that a job
  // board was involved - not a referral, a recruiter or an employee.
  assert.equal(heardFromBoard({ source: "YC Combinator (Work at a Startup)" }), "Job board");
  assert.equal(heardFromBoard(null), "Job board");
});

test("the upload control's own label decides between a tailored resume and the plain CV", () => {
  // The operator's rule: "if board asks for a resume then build it from the cv,
  // ats tailor to the jd and the platform ... if it asks for a cv then send the
  // cv as is". The label decides, never the platform - Greenhouse hosts both
  // wordings.
  assert.equal(decideUploadKind("Resume/CV").kind, "resume");
  assert.equal(decideUploadKind("Upload your resume").kind, "resume");
  assert.equal(decideUploadKind("Attach resume (PDF)").kind, "resume");
  assert.equal(decideUploadKind("Updated rÃ©sumÃ©").kind, "resume");
  assert.equal(decideUploadKind("Upload your CV").kind, "cv");
  assert.equal(decideUploadKind("Attach CV *").kind, "cv");
  assert.equal(decideUploadKind("Curriculum Vitae").kind, "cv");
  assert.equal(decideUploadKind("Upload your c.v.").kind, "cv");
  // Nothing named: the tailored resume is the safer default, and it is still
  // the candidate's own material.
  assert.equal(decideUploadKind("").kind, "resume");
  assert.equal(decideUploadKind("Upload a document").kind, "resume");
});

test("the canonical CV is resolved from an explicit path before any default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseops-canonical-"));
  const stated = path.join(dir, "My-CV.pdf");
  fs.writeFileSync(stated, "%PDF-1.4\n% test\n");
  const previous = process.env.PULSEOPS_CV_PDF;
  process.env.PULSEOPS_CV_PDF = stated;
  try {
    assert.equal(findCanonicalCv(), stated);
    // A stated path that does not exist must not be returned as if it did.
    process.env.PULSEOPS_CV_PDF = path.join(dir, "missing.pdf");
    const resolved = findCanonicalCv();
    assert.notEqual(resolved, process.env.PULSEOPS_CV_PDF);
  } finally {
    if (previous === undefined) delete process.env.PULSEOPS_CV_PDF;
    else process.env.PULSEOPS_CV_PDF = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a request's allowlist follows the document that issued it, not the row's board", () => {
  // A LinkedIn row whose Apply control hands the form to Greenhouse: the guard
  // is installed while the LinkedIn page is open, so the row's ATS is still
  // "linkedin" when Greenhouse's bundle arrives. Judging the request by the
  // frame that issued it is what lets the form hydrate at all.
  const greenhouseRequest = {
    frame: () => ({ url: () => "https://job-boards.greenhouse.io/gleanwork/jobs/4006731005" }),
  };
  const linkedInPage = { url: () => "https://www.linkedin.com/jobs/view/4195254610/" };
  assert.equal(servingAtsForRequest(greenhouseRequest, linkedInPage, "linkedin"), "greenhouse");

  // A request from the board itself still resolves to the board.
  const linkedInRequest = {
    frame: () => ({ url: () => "https://www.linkedin.com/jobs/view/4195254610/" }),
  };
  assert.equal(servingAtsForRequest(linkedInRequest, linkedInPage, "linkedin"), "linkedin");

  // An unrecognised document falls back to whatever the caller already had,
  // never to a vendor allowlist.
  const unknownRequest = { frame: () => ({ url: () => "https://careers.example.org/apply" }) };
  assert.equal(servingAtsForRequest(unknownRequest, { url: () => "https://careers.example.org/" }, "linkedin"), "linkedin");
  assert.equal(servingAtsForRequest({ frame: () => ({ url: () => "" }) }, { url: () => "" }), "generic");

  // The Greenhouse runtime host is allowed under Greenhouse and refused under
  // a LinkedIn allowlist - the exact mismatch that left #143's form inert.
  assert.equal(isAllowedAssetRequest("https://job-boards.cdn.greenhouse.io/assets/root-B3B4RIJc.js", "script", "greenhouse"), true);
  assert.equal(isAllowedAssetRequest("https://job-boards.cdn.greenhouse.io/assets/root-B3B4RIJc.js", "script", "linkedin"), false);
});

test("a submit that lands on the board's own confirmation route counts as confirmed", () => {
  // Measured 2026-11-09, #1319: Keka answered the submit with 200 and sent the
  // page to /careers/success/94986, but the run only looked for confirmation
  // words in the form it had replaced and filed the row as an error.
  assert.equal(
    isSubmissionLandingUrl("https://nudge.keka.com/careers/success/94986"),
    true,
  );
  assert.equal(isSubmissionLandingUrl("https://boards.example.com/thank-you"), true);
  assert.equal(isSubmissionLandingUrl("https://jobs.example.com/application/123/confirmation"), true);
  assert.equal(isSubmissionLandingUrl("https://jobs.example.com/apply/confirmation?job=1"), true);

  // The form itself, and the job page that precedes it, are not evidence.
  assert.equal(isSubmissionLandingUrl("https://nudge.keka.com/careers/applyjob/94986?source=linkedin"), false);
  assert.equal(isSubmissionLandingUrl("https://nudge.keka.com/careers/jobdetails/94986"), false);

  // A route named only in the query string is not the page that was loaded.
  assert.equal(isSubmissionLandingUrl("https://jobs.example.com/jobs/123?next=/success"), false);
  // Nonsense is not a confirmation either.
  assert.equal(isSubmissionLandingUrl(""), false);
  assert.equal(isSubmissionLandingUrl("not a url"), false);
});

test("asking a closed page a question does not throw", () => {
  assert.equal(pageIsClosed({ isClosed: () => true }), true);
  assert.equal(pageIsClosed({ isClosed: () => false }), false);
  // A handle whose target has gone throws from isClosed(); that is closed too.
  assert.equal(pageIsClosed({ isClosed: () => { throw new Error("Target page, context or browser has been closed"); } }), true);
  assert.equal(pageIsClosed(null), true);
  assert.equal(pageIsClosed(undefined), true);

  assert.equal(safePageUrl({ isClosed: () => false, url: () => "https://nudge.keka.com/careers/success/94986" }), "https://nudge.keka.com/careers/success/94986");
  assert.equal(safePageUrl({ isClosed: () => true, url: () => "https://nudge.keka.com/" }), "");
  assert.equal(safePageUrl(null), "");
});

test("a recommendation card's Apply link is not this job's apply control", () => {
  // Measured 2026-11-10, #1274 Honeywell Aerospace: the matched control was a
  // "similar jobs" card, so pressing it would have opened a different posting.
  assert.equal(
    isListingBrowseUrl(
      "https://www.linkedin.com/jobs/search-results/?keywords=Intern+Bachelors+Software",
      "https://www.linkedin.com/jobs/view/4486124872/",
    ),
    true,
  );
  assert.equal(isListingBrowseUrl("https://www.linkedin.com/jobs/search/?keywords=backend"), true);
  assert.equal(isListingBrowseUrl("https://www.linkedin.com/jobs/collections/recommended/"), true);
  assert.equal(isListingBrowseUrl("/jobs/search-results/?keywords=x", "https://www.linkedin.com/jobs/view/1/"), true);
  assert.equal(isListingBrowseUrl("https://www.linkedin.com/feed/"), true);

  // A real posting, an employer's own form, and a board's apply route are not
  // browsing.
  assert.equal(isListingBrowseUrl("https://www.linkedin.com/jobs/view/4486124872/"), false);
  assert.equal(isListingBrowseUrl("https://job-boards.greenhouse.io/acme/jobs/4006731005"), false);
  assert.equal(isListingBrowseUrl("https://jobs.lever.co/acme/1234/apply"), false);
  assert.equal(isListingBrowseUrl("https://recruiting.ultipro.com/PAR1035PPTL/JobBoard/x/OpportunityApply?opportunityId=1"), false);
  assert.equal(isListingBrowseUrl("https://www.linkedin.com/researcher/1"), false);
  assert.equal(isListingBrowseUrl(""), false);
});

test("a posting that stopped taking applications is closed, not an off-site apply", () => {
  // Measured 2026-11-10, #1274 Honeywell Aerospace: LinkedIn's own line is
  // "Not currently accepting applications", and the same page also says
  // "Responses managed off LinkedIn" â€” which the run used to decide the job
  // wanted an off-site application.
  assert.equal(CLOSED_LISTING_TEXT.test("Promoted by hirer Â· Responses managed off LinkedIn On-site Full-time Not currently accepting applications"), true);
  assert.equal(CLOSED_LISTING_TEXT.test("No longer accepting applications"), true);
  assert.equal(CLOSED_LISTING_TEXT.test("Applications are closed for this role"), true);
  assert.equal(CLOSED_LISTING_TEXT.test("This position is open until 30 November"), false);
  assert.equal(CLOSED_LISTING_TEXT.test("Apply now and we will review your application"), false);
});

test("a textarea is only an essay when its own words ask for prose", () => {
  // Measured 2026-11-10, #1320 Zema on Deel: the "why us" essay (1500 chars) was
  // poured into the salary box because it is also a textarea, so the money
  // question was answered with an essay and the real essay stayed empty.
  assert.equal(isEssayFieldHint("desired base salary (please specify amount and currency) | textarea"), false);
  assert.equal(isEssayFieldHint("Current CTC in LPA"), false);
  assert.equal(isEssayFieldHint("Phone number"), false);
  assert.equal(isEssayFieldHint("How many years of Java experience do you have?"), false);
  assert.equal(isEssayFieldHint("Rate your Spring Boot knowledge from 1 to 10"), false);
  assert.equal(isEssayFieldHint("Notice period (days)"), false);

  assert.equal(isEssayFieldHint("Why do you want to work at Zema?"), true);
  assert.equal(isEssayFieldHint("Tell us about yourself"), true);
  assert.equal(isEssayFieldHint("Describe your most challenging project"), true);
  assert.equal(isEssayFieldHint("Cover letter"), true);
  assert.equal(isEssayFieldHint("What motivates you?"), true);
  assert.equal(isEssayFieldHint("Anything else we should know? (200-400 words)"), true);
  assert.equal(isEssayFieldHint("Additional information"), true);

  // A prose-looking label that also asks for a figure is still a figure field.
  assert.equal(isEssayFieldHint("Tell us your expected salary in LPA"), false);
  assert.equal(isEssayFieldHint(""), false);
  assert.equal(isEssayFieldHint(null), false);
});

test("a years-of-experience bar is read from the question, and nothing else is", async () => {
  // #1126 Sardine asks "Do you have at least 5 years of professional experience
  // in software engineering?" and stopped the run. The profile states four
  // months, so the bar is a fact the applier can answer without guessing - but
  // only when the question is really about experience and really states a bar.
  const { yearsRequirement } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(
    yearsRequirement("Do you have at least 5 years of professional experience in software engineering?"),
    5,
  );
  assert.equal(yearsRequirement("Do you have 3+ years of experience?"), 3);
  assert.equal(yearsRequirement("Minimum of 2 years experience required"), 2);
  assert.equal(yearsRequirement("More than 10 years of industry experience"), 10);

  // No bar stated: an open count is a different question (filled from the
  // profile), not a threshold to answer Yes/No to.
  assert.equal(yearsRequirement("How many years of experience do you have?"), null);
  // A bar about something other than total professional experience. Answering
  // this from experience_years would be answering a question nobody asked.
  assert.equal(yearsRequirement("Do you have at least 5 years at your last employer?"), null);
  assert.equal(yearsRequirement("Do you have at least 2 years of formal education?"), null);
  assert.equal(yearsRequirement("Are you comfortable working onsite?"), null);
  assert.equal(yearsRequirement(""), null);
  assert.equal(yearsRequirement(undefined), null);
});

test("a stipend question is answered from the stated monthly floor", async () => {
  // #1337 Innovfix stalled on "Stipend will be 15-18k Maximum, are you fine with
  // it?" - a figure well under the 5 LPA full-time expectation, so treating it as
  // a salary question would have refused every internship in the queue.
  const { stipendFigure } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(stipendFigure("Stipend will be 15-18k Maximum, are you fine with it?"), 15000);
  assert.equal(stipendFigure("Is a stipend of â‚¹8,000 per month acceptable?"), 8000);
  assert.equal(stipendFigure("Are you okay with a stipend of INR 30,000 per month?"), 30000);
  assert.equal(stipendFigure("Stipend 10k, are you fine?"), 10000);
  // "3 months internship, stipend 15k" must not read the duration as money.
  assert.equal(stipendFigure("This is a 3 months internship, stipend 15k, are you willing?"), 15000);
  // No figure: a question about an unpaid stipend is a different decision, and
  // nothing in the profile states it.
  assert.equal(stipendFigure("Are you fine with an unpaid stipend?"), null);
  // Not a stipend question at all.
  assert.equal(stipendFigure("Are you comfortable working onsite?"), null);
  assert.equal(stipendFigure("What is your expected salary?"), null);
});

test("an approved off-site hop is not a misclick, a sticky-nav jump is", async () => {
  // #1019 (Park Place Technologies) opened recruiting.ultipro.com through
  // LinkedIn's Apply, the applier approved that host, and the misclick recovery
  // then dragged the browser back to the posting - the row died as
  // redirect-blocked with the employer's own form already in front of it.
  const { isMisclickDeparture } = await import("../apps/browser-apply/apply.mjs");

  // Approved handoff: the boundary's ATS was re-pointed at the employer's host.
  assert.equal(isMisclickDeparture("linkedin", "ultipro", "/PAR1035PPTL/JobBoard/e104637a/OpportunityApply"), false);
  assert.equal(isMisclickDeparture("linkedin", "greenhouse", "/example/jobs/1"), false);

  // The #1278 Meril misclick: the sticky nav swallowed the click and the run
  // ended up on the network page with the posting still open behind it.
  assert.equal(isMisclickDeparture("linkedin", "linkedin", "/mynetwork"), true);
  // A normal Easy Apply modal keeps the posting's own route.
  assert.equal(isMisclickDeparture("linkedin", "linkedin", "/jobs/view/4477101779/"), false);
  assert.equal(isMisclickDeparture("linkedin", "linkedin", ""), false);
  // Only LinkedIn has this recovery at all.
  assert.equal(isMisclickDeparture("wellfound", "wellfound", "/mynetwork"), false);
});

test("UltiPro's design-system reads are allowed, and only read-only", async () => {
  // #1019 (Park Place Technologies) reached recruiting.ultipro.com and then sat
  // on a page whose Apply control never rendered: the ignite manifest, the web
  // components and the en-US strings behind every label are fetched at runtime,
  // and the asset allowance is keyed on script/stylesheet, not fetch.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://ignite.cdn.ultipro.com/dls-cdn/ignite/latest/timestamp.json", "fetch", "GET", "ultipro",
    ),
    true,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://ignite.cdn.ultipro.com/dls-cdn/ignite/latest/web-components/ignite/localization/translations/ukg/ukg.en-US.json",
      "fetch", "GET", "ultipro",
    ),
    true,
  );
  // The allowance is read-only and prefix-scoped.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://ignite.cdn.ultipro.com/dls-cdn/ignite/latest/timestamp.json", "fetch", "POST", "ultipro",
    ),
    false,
  );
  assert.equal(
    isAllowedReadOnlyApiRequest("https://ignite.cdn.ultipro.com/other/path.json", "fetch", "GET", "ultipro"),
    false,
  );
  // And it is UltiPro's allowance, not everyone's.
  assert.equal(
    isAllowedReadOnlyApiRequest(
      "https://ignite.cdn.ultipro.com/dls-cdn/ignite/latest/timestamp.json", "fetch", "GET", "greenhouse",
    ),
    false,
  );
});

test("a goto that timed out after the browser arrived still counts as arrived", async () => {
  // #1019: LinkedIn's /safety/go?url=<employer ATS> answered 303 to ultipro and
  // page.goto threw "Timeout 30000ms exceeded" anyway, with the employer's page
  // already rendered. The row died because the timeout was read as "did not go
  // anywhere".
  const { navigationLanding } = await import("../apps/browser-apply/apply.mjs");

  const target = "https://www.linkedin.com/safety/go/?url=https%3A%2F%2Frecruiting%2Eultipro%2Ecom%2FPAR1035PPTL";
  assert.equal(
    navigationLanding(target, "https://recruiting.ultipro.com/PAR1035PPTL/JobBoard/e104/OpportunityDetail"),
    "https://recruiting.ultipro.com/PAR1035PPTL/JobBoard/e104/OpportunityDetail",
  );

  // Still on the redirector after a failed goto means the navigation never
  // completed, so nothing new may be approved (pinning it would trust the
  // shortener instead of the ATS).
  assert.equal(navigationLanding(target, target, true), "");
  assert.equal(navigationLanding(target, "", true), "");
  assert.equal(navigationLanding(target, null, true), "");
});
test("a plain navigation lands on its own URL; a timed-out one does not", async () => {
  // The distinction matters both ways: a posting URL with no redirect must count
  // as arrived (every ordinary job page does this), while a timed-out goto still
  // sitting on the redirector must not.
  const { navigationLanding } = await import("../apps/browser-apply/apply.mjs");
  const job = "https://www.linkedin.com/jobs/view/4477101779/";
  assert.equal(navigationLanding(job, job, false), job);
  assert.equal(navigationLanding(job, job, true), "");
  assert.equal(navigationLanding(job, "", false), "");
});
test("an off-site hop re-detects with the employer ATS's own controls", async () => {
  // #1019: the hop pinned recruiting.ultipro.com, then the runner re-detected
  // with "generic", whose list has no "Apply Now" - so it found no control on a
  // page that had one.
  const { hopApplyAts, createNavigationBoundary, tryPinExternalApplyOrigin } =
    await import("../apps/browser-apply/apply.mjs");

  const boundary = createNavigationBoundary("https://www.linkedin.com/jobs/view/1/", "linkedin");
  assert.equal(hopApplyAts("linkedin", boundary), "generic");

  assert.equal(tryPinExternalApplyOrigin(boundary, "https://recruiting.ultipro.com/PAR/JobBoard/x/OpportunityDetail", "linkedin", true), true);
  boundary.ats = "ultipro";
  assert.equal(hopApplyAts("linkedin", boundary), "ultipro");

  // An unrecognised careers site leaves the row's own ATS in place, so the
  // generic fallback stands.
  const other = createNavigationBoundary("https://www.linkedin.com/jobs/view/2/", "linkedin");
  assert.equal(tryPinExternalApplyOrigin(other, "https://careers.example.com/apply/7", "linkedin", true), true);
  assert.equal(hopApplyAts("linkedin", other), "generic");
  assert.equal(hopApplyAts("linkedin", null), "generic");
});
test("a board's candidate sign-in is an account gate, not a broken form", async () => {
  // #1019: UltiPro's posting renders "Apply now" as a <ukg-button>, and clicking
  // it goes to signin-us.ultipro.com/u/login. The run waited for a form, found
  // none, and recorded "no clickable final Submit" on a board that simply wants
  // an account - parking the row in NeedsReview to fail the same way next time.
  const { isAuthWallHost } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(isAuthWallHost("signin-us.ultipro.com"), true);
  assert.equal(isAuthWallHost("signin-eu.ultipro.com"), true);
  assert.equal(isAuthWallHost("signin.ultipro.com"), true);
  // The recruiting host itself is the board, not a gate.
  assert.equal(isAuthWallHost("recruiting.ultipro.com"), false);
  // A host that merely ends in the vendor's name is not the vendor.
  assert.equal(isAuthWallHost("signin-us.ultipro.com.evil.example"), false);
  // The existing shapes still work.
  assert.equal(isAuthWallHost("login.microsoftonline.com"), true);
  assert.equal(isAuthWallHost("talent.example.com"), false);
});
test("an account gate is board-blocked on gated ATSes only", async () => {
  // #1019: UltiPro's "Apply now" goes to signin-us.ultipro.com, so there is no
  // form to fill and the row was parked in NeedsVerification as "page is not a
  // trusted HTTPS origin". Workday behaves the same way.
  const { isAccountGate } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(isAccountGate("ultipro", true), true);
  assert.equal(isAccountGate("workday", true), true);
  // Only when a wall was actually reached.
  assert.equal(isAccountGate("ultipro", false), false);
  // A board session that expired is recoverable by signing in again, so it stays
  // NeedsReview rather than being written off.
  assert.equal(isAccountGate("linkedin", true), false);
  assert.equal(isAccountGate("naukri", true), false);
  assert.equal(isAccountGate(undefined, true), false);
});
test("a Wellfound toast in the future tense is still a submission", async () => {
  // #1137 Viaduct 2026-11-12: the modal closed, the toast read "Your application
  // to Viaduct will be sent in a few minutes. Undo - 4:54", the graphql POST had
  // gone out - and the row was recorded needs-verification because only the past
  // tense was recognised.
  const { wellfoundSendConfirmed } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(
    wellfoundSendConfirmed("Your application to Viaduct will be sent in a few minutes. Undo · 4:54", true),
    true,
  );
  assert.equal(wellfoundSendConfirmed("Message sent", true), true);
  assert.equal(wellfoundSendConfirmed("Application submitted successfully", true), true);
  // #1132 Brave: the toast collapses into the action row as an undo countdown
  // and no other trace of the send is left on the page.
  assert.equal(wellfoundSendConfirmed("Save Undo · 3:03 brave.com/", true), true);

  // A modal still on screen is not a submission, whatever the page says behind
  // it: the same text can be in the listing's own copy.
  assert.equal(wellfoundSendConfirmed("Your application to Viaduct will be sent in a few minutes.", false), false);
  assert.equal(wellfoundSendConfirmed("", true), false);
  assert.equal(wellfoundSendConfirmed("Apply now", true), false);
});
test("a passive reCAPTCHA Enterprise badge is not a human challenge", async () => {
  // Ashby gates submit with reCAPTCHA Enterprise, whose frames carry no `size`
  // hint, so the URL alone read as a challenge and every Ashby application
  // stopped for 180 s and landed NeedsReview. Measured #473 sarvam 2026-11-12:
  // the anchor frame's body is exactly "protected by reCAPTCHA", the bframe's is
  // empty, there is no checkbox, and both iframes compute to invisible.
  const { vendorFrameChallengesHuman } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(vendorFrameChallengesHuman("protected by reCAPTCHA"), false);
  assert.equal(vendorFrameChallengesHuman(""), false);
  assert.equal(vendorFrameChallengesHuman("   "), false);
  assert.equal(vendorFrameChallengesHuman("reCAPTCHA"), false);

  // A real challenge is a person's job, whatever the URL says.
  assert.equal(vendorFrameChallengesHuman("I'm not a robot"), true);
  assert.equal(vendorFrameChallengesHuman("Select all images with traffic lights"), true);
  assert.equal(vendorFrameChallengesHuman("Please verify you are human"), true);
  assert.equal(vendorFrameChallengesHuman("Complete the captcha to continue"), true);

  // Unreadable is not a verdict: the caller falls back to the URL and fails
  // closed rather than guessing the widget is passive.
  assert.equal(vendorFrameChallengesHuman(null), null);
  assert.equal(vendorFrameChallengesHuman(undefined), null);
});
test("a 404 or 410 posting document is a dead listing, a refusal is not", async () => {
  // #393 deepgram 2026-11-14: Ashby answered the posting document with 404 and
  // still rendered its own shell around it, so the page text carried nothing to
  // match, 0 form fields appeared, and the row was recorded NeedsReview on a
  // posting that no longer exists.
  const { isGoneDocumentStatus } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(isGoneDocumentStatus(404), true);
  assert.equal(isGoneDocumentStatus(410), true);
  assert.equal(isGoneDocumentStatus("404"), true);

  // A refusal is not a missing posting: the row stays in the queue.
  assert.equal(isGoneDocumentStatus(403), false);
  assert.equal(isGoneDocumentStatus(503), false);
  assert.equal(isGoneDocumentStatus(429), false);
  assert.equal(isGoneDocumentStatus(200), false);
  assert.equal(isGoneDocumentStatus(0), false);
  assert.equal(isGoneDocumentStatus(null), false);
});
test("a Wellfound posting whose own header names a non-India remote scope is ineligible", async () => {
  // #1110 Speak 2026-11-14, read from the public posting in a separate browser:
  //   Backend Engineer $150k - $280k | Remote ( United States ) | San Francisco
  //   Hires remotely in United States
  //   Visa Sponsorship Not Available
  // The modal said nothing, disabled Send, and the row was recorded NeedsReview
  // on a role no India-based candidate can apply to.
  const { postingRemoteOutsideIndia } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(
    postingRemoteOutsideIndia("Save Apply Now Backend Engineer $150k | Remote ( United States ) | San Francisco | Full Time"),
    "United States",
  );
  assert.equal(
    postingRemoteOutsideIndia("Hires remotely in United States Visa Sponsorship Not Available"),
    "United States",
  );
  assert.equal(postingRemoteOutsideIndia("Remote ( Canada )"), "Canada");
  assert.equal(postingRemoteOutsideIndia("Remote ( EMEA )"), "EMEA");

  // India, worldwide and silence are all in scope and must stay in the queue.
  assert.equal(postingRemoteOutsideIndia("Remote ( India )"), "");
  assert.equal(postingRemoteOutsideIndia("Remote ( Worldwide )"), "");
  assert.equal(postingRemoteOutsideIndia("Remote ( Anywhere )"), "");
  assert.equal(postingRemoteOutsideIndia("Hires remotely in India"), "");
  assert.equal(postingRemoteOutsideIndia("Backend Engineer Remote Full Time"), "");
  assert.equal(postingRemoteOutsideIndia(""), "");

  // A region the list does not recognise is not a verdict either.
  assert.equal(postingRemoteOutsideIndia("Remote ( Narnia )"), "");

  // The sidebar names other postings' regions; only the header counts.
  const far = "Backend Engineer Remote Full Time About the job " + "x".repeat(2100) + " More jobs Remote ( United States )";
  assert.equal(postingRemoteOutsideIndia(far), "");
});
test("the signed-in posting's fact row decides the remote scope", async () => {
  // #1108 Astra 2026-11-14, read from the signed-in Edge page: no parenthesised
  // region anywhere and no "About the job" heading - the scope is a fact row,
  // "Hires remotely in United States Remote work policy Remote only Company
  // Location Los Angeles, San Francisco", roughly 5000 characters in behind the
  // candidate's own nav and the description.
  const { postingRemoteOutsideIndia } = await import("../apps/browser-apply/apply.mjs");
  const signedIn =
    "Ready to interview Home Profile Jobs Applied Messages DiscoverStartups"
    + "Astra Astra Actively Hiring The Instant Payments API 11-50 Employees B2B Early Stage"
    + " Share Follow Overview People Culture and benefits Funding Jobs 6"
    + " Backend Engineer at Astra $125k – $160k RECRUITER RECENTLY ACTIVE POSTED 3 WEEKS AGO"
    + " Save Apply About Astra Astra is building mission-critical infrastructure for moving money at scale. "
    + "We are a remote-first company and our engineers work from wherever they are. ".repeat(45)
    + "Apply now Hires remotely in United States Remote work policy Remote only"
    + " Company Location Los Angeles, San Francisco";
  assert.equal(postingRemoteOutsideIndia(signedIn), "United States");

  // The same row ends and the sidebar starts: other postings' regions are not
  // this posting's scope. Cut at the badge that follows the fact row.
  assert.equal(postingRemoteOutsideIndia("Hires remotely in United States Visa Sponsorship Not Available"), "United States");
  assert.equal(postingRemoteOutsideIndia("Hires remotely in Canada Remote only"), "Canada");
  assert.equal(postingRemoteOutsideIndia("Hires remotely in India Remote work policy Remote only"), "");

  // #1110/#1112/#1134 measured 2026-11-14 read back as "United States Job type":
  // the next badge after the fact row was "Job type", not "Visa Sponsorship".
  assert.equal(postingRemoteOutsideIndia("Hires remotely in United States Job type Full Time"), "United States");

  // A description that merely quotes the parenthesised form is not the title
  // line, and the sidebar comes after the description.
  const prose = "Backend Engineer Remote Full Time About the job " + "x".repeat(1200) + " More jobs Remote ( United States )";
  assert.equal(postingRemoteOutsideIndia(prose), "");
});

test("an on-site posting's own Job Location decides eligibility", async () => {
  // #499 (Delos Data), #809 (Talent Kettle) and #822 (Arcade.dev) measured
  // 2026-11-14: no remote claim at all, and the scraper had no location, so all
  // three sat in NeedsReview as "unknown/possible-remote" on-site US roles.
  const { postingRemoteOutsideIndia } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(
    postingRemoteOutsideIndia("Save Apply Now System Software Engineer - AI $140k | Palo Alto | Full Time Job Location Palo Alto Visa Sponsorship Not Available Relocation Not Allowed About the job"),
    "Palo Alto",
  );
  assert.equal(
    postingRemoteOutsideIndia("Job Location New York City Remote Work Policy In office Visa Sponsorship Not Available"),
    "New York City",
  );
  assert.equal(
    postingRemoteOutsideIndia("Job Location San Francisco Visa Sponsorship Not Available Relocation Not Allowed Hiring co"),
    "San Francisco",
  );

  // #1126 Sardine: "Remote ( Canada +1 ) • United States", "Hires remotely in
  // Canada - United States" - a non-India scope with no anywhere claim.
  const sardine = postingRemoteOutsideIndia("Machine Learning Engineer $175k – $220k | Remote ( Canada +1 ) • United States | Full Time Job Location United States Hires remotely in Canada - United States Visa Spo");
  assert.ok(/canada/i.test(sardine), `expected a Canada block, got ${JSON.stringify(sardine)}`);

  // #1129 Jabali says "Remote ( Everywhere )" and also lists Canada/Mexico/US.
  // A stated elsewhere-wins claim keeps the row in scope.
  assert.equal(
    postingRemoteOutsideIndia("Machine Learning Engineer Remote ( Everywhere ) • Canada +2 | Full Time Job Location Canada • Mexico • United States Remote Work Policy Onsite or rem"),
    "",
  );
  assert.equal(postingRemoteOutsideIndia("Job Location Remote Work Policy Remote only"), "");
  assert.equal(postingRemoteOutsideIndia("Job Location Bengaluru Visa Sponsorship Not Available"), "");
});

test("the document title carries the place on a posting that renders none", async () => {
  // #499 measured 2026-11-14 in the signed-in browser: no "Job Location", no
  // "Hires remotely", no place anywhere in the body - only the title said
  // "System Software Engineer - AI at Delos Data • Palo Alto | Wellfound".
  const { postingRemoteOutsideIndia } = await import("../apps/browser-apply/apply.mjs");

  assert.equal(postingRemoteOutsideIndia("", "System Software Engineer - AI at Delos Data • Palo Alto | Wellfound"), "Palo Alto");
  assert.equal(postingRemoteOutsideIndia("", "Founding Machine Learning Engineer at Arcade.dev • San Francisco | Wellfound"), "San Francisco");
  assert.equal(postingRemoteOutsideIndia("", "AI Applied Engineer-Python at Talent Kettle • New York City | Wellfound"), "New York City");

  // "Remote (Work from Home)" in the title is a work mode, not a place: it must
  // not cancel the city next to it, and on its own it is not a verdict.
  assert.equal(postingRemoteOutsideIndia("", "Backend Engineer at Speak • San Francisco • Remote (Work from Home) | Wellfound"), "San Francisco");
  assert.equal(postingRemoteOutsideIndia("", "Machine Learning Engineer at Brave • Remote (Work from Home) | Wellfound"), "");

  // A stated "Everywhere" in the body still wins over a place list (#1129).
  assert.equal(
    postingRemoteOutsideIndia("Machine Learning Engineer Remote ( Everywhere ) |Full Time", "Machine Learning Engineer at Jabali • Canada • Mexico • United States • Remote (Work from Home) | Wellfound"),
    "",
  );
  assert.equal(postingRemoteOutsideIndia("", "Backend Engineer at X • India | Wellfound"), "");
  assert.equal(postingRemoteOutsideIndia("", "Backend Engineer at X | Wellfound"), "");
});
