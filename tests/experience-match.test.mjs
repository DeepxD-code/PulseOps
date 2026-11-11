import assert from "node:assert/strict";
import test from "node:test";

import {
  experienceDates,
  isExperienceStepText,
  matchExperienceEntry,
  monthLabel,
  yearLabel,
} from "../apps/browser-apply/experience.mjs";

// Transcribed from cv.md, the candidate's own document.
const HISTORY = [
  {
    title: "Backend Developer",
    company: "AKS Intelligent Systems LLP",
    start_month: 5,
    start_year: 2026,
    end_month: 7,
    end_year: 2026,
    current: false,
  },
  {
    title: "Production Engineering - RFQ & Quotation Platform",
    company: "AKS Intelligent Systems LLP",
    start_month: 8,
    start_year: 2026,
    end_month: 10,
    end_year: 2026,
    current: false,
  },
  {
    title: "Open Source Contributor",
    company: "anomalyco/opencode",
    start_month: "October",
    start_year: "2025",
    current: true,
  },
];

test("month and year labels are the ones the selects offer", () => {
  assert.equal(monthLabel(5), "May");
  assert.equal(monthLabel("5"), "May");
  assert.equal(monthLabel("may"), "May");
  assert.equal(monthLabel("Sept"), "September");
  assert.equal(monthLabel("2026"), null);
  assert.equal(monthLabel(""), null);
  assert.equal(yearLabel(2026), "2026");
  assert.equal(yearLabel("2026"), "2026");
  assert.equal(yearLabel("May"), null);
  assert.equal(yearLabel("26"), null);
});

test("dates come from the entry, and a current role has no end", () => {
  assert.deepEqual(experienceDates(HISTORY[0]), {
    startMonth: "May",
    startYear: "2026",
    endMonth: "July",
    endYear: "2026",
    current: false,
  });
  assert.deepEqual(experienceDates(HISTORY[2]), {
    startMonth: "October",
    startYear: "2025",
    endMonth: null,
    endYear: null,
    current: true,
  });
  assert.equal(experienceDates({ title: "x", company: "y", start_month: 5 }), null);
});

test("the form's own title decides between two roles at one employer", () => {
  // #1033's wizard showed "Backend Engineer" at "AKS Intelligent Systems".
  const found = matchExperienceEntry(HISTORY, {
    title: "Backend Engineer",
    company: "AKS Intelligent Systems",
  });
  assert.ok(found, "the May-July role matches");
  assert.equal(found.dates.startMonth, "May");
  assert.equal(found.dates.endMonth, "July");

  const other = matchExperienceEntry(HISTORY, {
    title: "Production Engineer",
    company: "AKS Intelligent Systems LLP",
  });
  assert.ok(other);
  assert.equal(other.dates.startMonth, "August");

  // A title that belongs to neither role at that employer is left unanswered
  // rather than guessed from the company alone.
  assert.equal(
    matchExperienceEntry(HISTORY, { title: "Marketing Lead", company: "AKS Intelligent Systems" }),
    null,
  );
});

test("an employer the profile does not state is never filled", () => {
  assert.equal(matchExperienceEntry(HISTORY, { title: "Backend Engineer", company: "Meril" }), null);
  assert.equal(matchExperienceEntry(HISTORY, { title: "", company: "" }), null);
  assert.equal(matchExperienceEntry([], { title: "Backend Engineer", company: "AKS" }), null);
});

test("the work-experience step is recognised by its own words", () => {
  assert.ok(
    isExperienceStepText(
      "Apply to Heads Up For Tails 3/5 pages Edit experience Save Your title Company Dates of employment From Month Year To Month Year",
    ),
  );
  assert.ok(isExperienceStepText("Add work experience Dates of employment From To"));
  // The contact and review steps are not this form.
  assert.ok(!isExperienceStepText("Contact info First name Last name Email address 1/5 pages"));
  assert.ok(!isExperienceStepText("Review your application"));
  // A profile page that mentions dates is not an application step.
  assert.ok(!isExperienceStepText("Dates of employment From To"));
});
