import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  clickFinalAction,
  finalSubmissionAllowed,
  hasCaptcha,
  isAllowedLinkedInUrl,
  isEligibleJob,
  isSimulationJob,
  resolveDbPath,
  sendDM,
} from "../apps/browser-apply/linkedin_outreach.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSON = { name: "Alice Example", url: "https://www.linkedin.com/in/alice-example" };

function eligible(overrides = {}) {
  return {
    id: 42,
    company: "Example Company",
    title: "Backend Intern",
    link: "https://jobs.lever.co/example/1",
    source: "LinkedIn",
    run_id: "live-run",
    status: "Evaluated",
    score: 90,
    _send_paused: false,
    ...overrides,
  };
}

test("--live alone is not sufficient for a final send", async () => {
  assert.equal(finalSubmissionAllowed({ dryRun: false, auto: false }), false);
  assert.equal(finalSubmissionAllowed({ dryRun: true, auto: true }), false);
  assert.equal(finalSubmissionAllowed({ dryRun: false, auto: true }), false);

  let clicks = 0;
  const locator = {
    count: async () => 1,
    isDisabled: async () => false,
    click: async () => { clicks += 1; },
  };
  const result = await clickFinalAction(
    { url: () => PERSON.url },
    locator,
    { dryRun: false, auto: false, job: eligible(), person: PERSON },
  );
  assert.equal(result.clicked, false);
  assert.equal(result.reason, "live-and-auto-required");
  assert.equal(clicks, 0);
});

test("sendDM exits before touching a page when --auto is absent", async () => {
  let touched = false;
  const page = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("page must not be touched in live-without-auto mode");
    },
  });
  const result = await sendDM(page, PERSON, "hello", eligible(), { dryRun: false, auto: false });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "live-and-auto-required");
  assert.equal(touched, false);
});

test("the real --live CLI mode returns before any page/send work", () => {
  const moduleUrl = pathToFileURL(path.join(ROOT, "apps", "browser-apply", "linkedin_outreach.mjs")).href;
  const script = `
    import { sendDM } from ${JSON.stringify(moduleUrl)};
    let touched = false;
    const page = new Proxy({}, { get() { touched = true; throw new Error("page touched"); } });
    const result = await sendDM(page, { name: "Alice", url: "https://www.linkedin.com/in/alice" }, "hello", { id: 1, company: "Acme" });
    console.log(JSON.stringify({ result, touched }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", "--live"], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
  assert.deepEqual(result, { result: { sent: false, reason: "live-and-auto-required" }, touched: false });
});

test("job policy requires Evaluated, score >=75, real source, and no prior/review outcome", () => {
  assert.equal(isEligibleJob(eligible(), { requirePauseKnown: true }), true);
  for (const status of ["Applied", "Sent", "Verified", "NeedsReview", "NeedsVerification", "Expired", "Skipped"]) {
    assert.equal(isEligibleJob(eligible({ status }), { requirePauseKnown: true }), false, status);
  }
  assert.equal(isEligibleJob(eligible({ score: 74 }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ _outreach_statuses: ["Sent"] }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ _pending_g10_review: true }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ _outreach_statuses: ["review_posted"] }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ _send_paused: true }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ _send_paused: null }), { requirePauseKnown: true }), false);
  assert.equal(isEligibleJob(eligible({ source: "sim:Mock" }), { requirePauseKnown: true }), false);
});

test("simulation markers and exact LinkedIn host boundaries fail closed", () => {
  assert.equal(isSimulationJob({ source: "SIMULATED:Indeed India" }), true);
  assert.equal(isSimulationJob({ source: "LinkedIn [SIM]" }), true);
  assert.equal(isSimulationJob({ source: "LinkedIn", run_id: "sim-abc" }), true);
  assert.equal(isSimulationJob({ source: "LinkedIn", run_id: "live-abc" }), false);
  assert.equal(isAllowedLinkedInUrl("https://www.linkedin.com/in/alice"), true);
  assert.equal(isAllowedLinkedInUrl("https://linkedin.com/in/alice"), true);
  assert.equal(isAllowedLinkedInUrl("https://www.linkedin.com.evil.example/in/alice"), false);
  assert.equal(isAllowedLinkedInUrl("https://evil.linkedin.com/in/alice"), false);
  assert.equal(isAllowedLinkedInUrl("https://www.linkedin.com./in/alice"), false);
  assert.equal(isAllowedLinkedInUrl("https://www.linkedin.com:444/in/alice"), false);
  assert.equal(isAllowedLinkedInUrl("http://www.linkedin.com/in/alice"), false);
});

test("CAPTCHA probe failures are treated as a challenge", async () => {
  assert.equal(await hasCaptcha({
    locator: () => ({ count: async () => 1 }),
    evaluate: async () => false,
    frames: () => [],
  }), true);
  assert.equal(await hasCaptcha({
    locator: () => { throw new Error("probe unavailable"); },
    evaluate: async () => false,
    frames: () => [],
  }), true);
});

test("PULSEOPS_DB is authoritative and find:live stays preview-only", () => {
  const missing = path.join(ROOT, "output", "does-not-exist-pulseops.db");
  assert.equal(resolveDbPath({ PULSEOPS_DB: missing }, ROOT), missing);

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "browser-apply", "package.json"), "utf8"));
  assert.match(packageJson.scripts["find:live"], /--live/);
  assert.doesNotMatch(packageJson.scripts["find:live"], /--auto/);

  const source = fs.readFileSync(path.join(ROOT, "apps", "browser-apply", "linkedin_outreach.mjs"), "utf8");
  assert.match(source, /clickFinalAction/);
  assert.doesNotMatch(source, /sendInv\.click/);
  assert.doesNotMatch(source, /invitation(?:Button)?\.click/);
  assert.doesNotMatch(source, /send\.click/);
  assert.match(source, /send_paused/);
  assert.match(source, /review_posted/);
  assert.match(source, /CAPTCHA_BLOCKED|captcha-blocked/);
});
