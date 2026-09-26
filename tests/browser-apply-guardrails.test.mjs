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
  isAllowedNavigationUrl,
  isBlacklistedJob,
  isEligibleJob,
  isSimulationJob,
  isStrictTargetRole,
  isSubmissionControlLabel,
  isAshbyJobListing,
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

test("Ashby company boards are rejected but job-scoped listings are allowed", () => {
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/vercel"), false);
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/sprinto"), false);
  assert.equal(isAshbyJobListing("https://jobs.ashbyhq.com/vercel/9f1c2b44-1234"), true);
  assert.equal(isAshbyJobListing("not-a-url"), false);
});

test("application surface waits through resume-loader screens", async () => {
  let calls = 0;
  const page = {
    evaluate: async () => ({ loading: calls++ < 2 }),
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForApplicationSurface(page, 5000), true);
  assert.equal(calls, 3);
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

test("only exact LinkedIn passive asset hosts are exempted from the origin guard", () => {
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.css", "stylesheet", "linkedin"), true);
  assert.equal(isAllowedAssetRequest("https://media.licdn.com/image.png", "image", "linkedin"), true);
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.js", "fetch", "linkedin"), false);
  assert.equal(isAllowedAssetRequest("https://static.licdn.com/a.js", "script", "generic"), false);
  assert.equal(isAllowedAssetRequest("https://evil.static.licdn.com/a.js", "script", "linkedin"), false);
  assert.equal(isAllowedAssetRequest("http://static.licdn.com/a.js", "script", "linkedin"), false);
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

test("a G10 review created after claim revokes final-action ownership", async () => {
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
VALUES(1,'Example Company','needs_review','discord_review','G10');
""")
conn.commit()
conn.close()
`;
    execFileSync("python", ["-c", code, dbPath], { encoding: "utf8", windowsHide: true });
    const state = await verifyJobClaim(1, "owner-g10", dbPath);
    assert.equal(state.owned, false);
    assert.equal(state.reason, "g10-review");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
