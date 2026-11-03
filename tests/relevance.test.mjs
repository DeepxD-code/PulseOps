/**
 * Title cleaning and relevance ranking for the weekly portal scan.
 *
 * The cases mirror tests/test_title_clean.py: the scanner and the evaluator must
 * agree about what a job is called, so a divergence here is a bug in one of the
 * two, not a stylistic difference.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanTitle,
  isInScopeTitle,
  isExcludedSeniority,
  isOffDomainTitle,
  selectRelevantJobs,
} from "../apps/weekly-scan/lib/relevance.mjs";

test("cleanTitle strips board chrome", () => {
  assert.equal(
    cleanTitle("Backend Developer Bangalore Founded in 2021 50-200 employees View job »"),
    "Backend Developer",
  );
  assert.equal(cleanTitle("Engineering Manager6"), "Engineering Manager");
  assert.equal(
    cleanTitle("Software Engineer, Data SystemsFull-time · Remote (US)"),
    "Software Engineer, Data Systems",
  );
  assert.equal(
    cleanTitle("Senior Java Backend EngineerIn officeChennai L - 35L"),
    "Senior Java Backend Engineer",
  );
  assert.equal(cleanTitle("Backend Engineer | Bangalore"), "Backend Engineer");
  assert.equal(cleanTitle(""), "");
});

test("cleanTitle is idempotent", () => {
  const once = cleanTitle("Backend Developer Bangalore Founded in 2021 50-200 employees View job »");
  assert.equal(cleanTitle(once), once);
});

test("cleanTitle drops a company blurb glued to the role (YC)", () => {
  const raw =
    "HiveMarketing automation for event promoters (email, sms, ads, CRM) " +
    "Senior Software Engineer, Data SystemsFull-time · Remote (US)";
  assert.equal(cleanTitle(raw), "Senior Software Engineer, Data Systems");
});

test("in-scope titles are recognised, off-domain and off-stack are not", () => {
  assert.equal(isInScopeTitle("Backend Engineer"), true);
  assert.equal(isInScopeTitle("Machine Learning Engineer"), true);
  assert.equal(isInScopeTitle("Golang Developer"), true);

  assert.equal(isInScopeTitle("Product Manager"), false);
  assert.equal(isInScopeTitle("Sales Director"), false);
  // Off-stack languages are in-scope by role family and pure waste by stack.
  assert.equal(isInScopeTitle("Backend Engineer (Ruby)"), false);
});

test("seniority and domain classifiers read the cleaned title", () => {
  assert.equal(isExcludedSeniority("Senior Backend Engineer"), true);
  assert.equal(isExcludedSeniority("Backend Engineer"), false);
  assert.equal(isOffDomainTitle("Salesforce Developer"), false); // "sales" substring
  assert.equal(isOffDomainTitle("AI Sales Director"), true);
});

test("selectRelevantJobs spends the cap on hireable postings", () => {
  const jobs = [
    { title: "AI Sales Director", location_raw: "San Francisco, CA" },
    { title: "Senior Staff Backend Engineer", location_raw: "Remote (US)" },
    { title: "Backend Engineering Intern", location_raw: "Bengaluru, India" },
    { title: "Machine Learning Engineer", location_raw: "Remote" },
    { title: "Business Development Representative", location_raw: "New York, NY" },
  ];

  const selected = selectRelevantJobs(jobs, 2);
  assert.equal(selected.length, 2);

  const titles = selected.map((job) => job.title);
  assert.ok(
    titles.includes("Backend Engineering Intern"),
    `expected the India entry-level role to survive the cap, got ${JSON.stringify(titles)}`,
  );
  assert.ok(!titles.includes("AI Sales Director"));
  assert.ok(!titles.includes("Business Development Representative"));
});

test("selectRelevantJobs keeps every row when max exceeds the list", () => {
  const jobs = [{ title: "Backend Engineer" }, { title: "Data Scientist" }];
  assert.equal(selectRelevantJobs(jobs, 40).length, 2);
  assert.equal(selectRelevantJobs(jobs, undefined).length, 2);
});
