/**
 * The apply gate's role test.
 *
 * isStrictTargetRole is the last thing standing between the queue and a
 * submission, so a gap in it is either an application sent to the wrong job or
 * an interview never applied for. Both have happened:
 *
 *   - substring markers rejected "Salesforce Developer" (sales), "Adios
 *     Engineer" (ios) and "Reactive Systems Developer" (react);
 *   - the deny list ran after the allow list, so it could never fire, and
 *     "Solutions Architect, AI" was treated as an engineering role;
 *   - titles the India boards use for entry-level roles ("Software Engineer
 *     Trainee", "Associate Software Engineer") matched nothing at all and were
 *     dropped by the generic body-check.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isStrictTargetRole } from "../apps/browser-apply/apply.mjs";

const ADMITTED = [
  "Backend Developer",
  "Backend Engineer - Java",
  "Java Developer (Spring Boot)",
  "Python Developer Intern",
  "Golang Developer",
  "Machine Learning Engineer",
  "AI/ML Engineer",
  "DevOps Engineer",
  "Site Reliability Engineer",
  // Entry-level phrasing that names no discipline. The candidate is 0.2 years
  // in; these are the titles the India boards actually use.
  "Software Engineer Trainee",
  "Associate Software Engineer",
  "SDE 1 - Backend",
  "Machine Learning Intern",
];

const REJECTED = [
  "Frontend Developer",
  "React Developer",
  "PHP Developer",
  "Backend Engineer (Ruby on Rails)",
  "Full Stack Developer",
  "Business Analyst",
  "Solutions Architect, AI",
  "Salesforce Developer", // contains "sales"
  "Adios Engineer",       // contains "ios"
  "Marketing Intern",     // entry marker, but no engineering noun
  "Associate Product Manager",
  "Engineering Manager",
];

test("in-scope roles are admitted at the gate", () => {
  for (const title of ADMITTED) {
    assert.equal(isStrictTargetRole(title), true, `expected "${title}" to be admitted`);
  }
});

test("out-of-scope roles are refused at the gate", () => {
  for (const title of REJECTED) {
    assert.equal(isStrictTargetRole(title), false, `expected "${title}" to be refused`);
  }
});

test("board chrome does not change the verdict", () => {
  assert.equal(
    isStrictTargetRole("Backend Developer Bangalore Founded in 2021 50-200 employees View job »"),
    true,
  );
  // The stack segment survives the cleaner on purpose: it is a disqualifier.
  assert.equal(
    isStrictTargetRole("Backend Developer Intern | Entry Level | Fresher | Node.js, Python"),
    false,
  );
  assert.equal(
    isStrictTargetRole("Backend Developer Intern | Entry Level | Fresher | Python, REST API / Remote"),
    true,
  );
});
