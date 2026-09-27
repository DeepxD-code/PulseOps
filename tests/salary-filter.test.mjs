import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_MONTHLY_INR,
  basicHtmlTextFromHtml,
  monthlyInrFromText,
  statedSalaryTooLow,
} from "../apps/browser-apply/salary.mjs";

test("a stated salary under 10k INR per month is skipped", () => {
  for (const text of [
    "Salary: Rs 8,000 per month",
    "₹6,000/month for interns",
    "Pay is INR 9000 per month",
    "₹0.8 LPA per annum",
    "₹1,00,000 p.a",
    "stipend of 5k monthly",
  ]) {
    const { skip } = statedSalaryTooLow(text);
    assert.equal(skip, true, text);
  }
});

test("an acceptable stated salary is kept, and the floor itself counts as acceptable", () => {
  for (const text of [
    "₹15,000 per month",
    "Rs 1,000,000 per annum",
    "₹12 LPA",
    "₹18,00,000 p.a",
    "40k pm",
    "salary: ₹3,00,000 per month",
    "Compensation 10k pm",
  ]) {
    assert.equal(statedSalaryTooLow(text).skip, false, text);
  }
  assert.equal(statedSalaryTooLow("10k pm").monthly, MIN_MONTHLY_INR);
});

test("a role with no stated salary is never skipped", () => {
  for (const text of [
    "Great backend role, competitive salary",
    "Backend Engineer at Acme",
    "We offer equity and great learning",
    "",
    null,
    undefined,
  ]) {
    assert.deepEqual(statedSalaryTooLow(text), { skip: false, monthly: null });
  }
});

test("ranges use the lower bound", () => {
  assert.equal(statedSalaryTooLow("₹8 - 12 LPA").skip, false);
  assert.equal(statedSalaryTooLow("₹0.5 - 12 LPA").skip, true);
});

test("basic HTML reader strips chrome and keeps content", () => {
  const html = `
    <html><head><title>Careers</title>
      <style>.btn{color:red}</style>
      <script>window.tracker = 1;</script>
    </head>
    <body>
      <!-- nav -->
      <h1>Backend Engineer</h1>
      <p>Salary: &#8377;15,000 per month</p>
      <ul><li>Java</li><li>Spring Boot</li></ul>
      <a href="/apply">Apply now</a>
    </body></html>`;
  const text = basicHtmlTextFromHtml(html);
  assert.match(text, /Backend Engineer/);
  assert.match(text, /₹15,000 per month/);
  assert.match(text, /Apply now/);
  assert.doesNotMatch(text, /window\.tracker/);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /nav/);
});

test("basic HTML reader tolerates empty and nullish input", () => {
  assert.equal(basicHtmlTextFromHtml(""), "");
  assert.equal(basicHtmlTextFromHtml(null), "");
  assert.equal(basicHtmlTextFromHtml(undefined), "");
});

test("salary parsing agrees with the floor constant", () => {
  assert.equal(monthlyInrFromText("₹1,20,000 per annum"), 10000);
  assert.equal(monthlyInrFromText("₹15,00,000 p.a"), 125000);
  assert.equal(monthlyInrFromText("8k pm"), 8000);
  assert.equal(monthlyInrFromText("no pay info"), null);
});
