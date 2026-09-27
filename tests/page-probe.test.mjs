import assert from "node:assert/strict";
import test from "node:test";

import { BASIC_HTML, STYLED_PAGE, detectBasicHtml } from "../apps/browser-apply/page-probe.mjs";

const PLAIN_JOB_PAGE = `<!doctype html>
<html><head><title>Backend Engineer</title></head>
<body>
  <h1>Backend Engineer</h1>
  <p>Build and maintain backend services.</p>
  <p>Requirements: Java, Spring Boot, SQL, REST APIs.</p>
  <p>Salary: Rs 15,000 per month. Location: Bengaluru.</p>
  <form action="/apply" method="post">
    <input name="first_name"><input name="email" type="email">
    <textarea name="cover"></textarea>
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

test("a plain server-rendered job page is detected as basic HTML", () => {
  const result = detectBasicHtml(PLAIN_JOB_PAGE);
  assert.equal(result.mode, BASIC_HTML);
  assert.equal(result.basic, true);
  assert.match(result.text, /Backend Engineer/);
  assert.match(result.text, /Rs 15,000 per month/);
  assert.equal(result.signals.hasVisibleForm, true);
});

test("a page with CSS is not basic HTML", () => {
  const styled = PLAIN_JOB_PAGE.replace(
    "<head>",
    "<head><link rel='stylesheet' href='/site.css'>",
  );
  const result = detectBasicHtml(styled);
  assert.equal(result.mode, STYLED_PAGE);
  assert.equal(result.basic, false);
  assert.equal(result.signals.hasStylesheetLink, true);
});

test("an inline style block also disqualifies a page", () => {
  const styled = PLAIN_JOB_PAGE.replace(
    "<head>",
    "<head><style>.btn{color:red}</style>",
  );
  const result = detectBasicHtml(styled);
  assert.equal(result.mode, STYLED_PAGE);
  assert.equal(result.signals.hasStyleBlock, true);
});

test("a client framework shell is not basic HTML", () => {
  const spa = '<!doctype html><html><head></head><body><div id="root"></div>'
    + "<script>window.__DATA__=1;</script></body></html>";
  const result = detectBasicHtml(spa);
  assert.equal(result.mode, STYLED_PAGE);
  assert.equal(result.signals.hasFrameworkRoot, true);
});

test("a script-dominated page is not basic HTML", () => {
  const payload = "x".repeat(4000);
  const heavy = `<html><body><p>${"short"}</p><script>${payload}</script></body></html>`;
  const result = detectBasicHtml(heavy);
  assert.equal(result.mode, STYLED_PAGE);
  assert.ok(result.signals.scriptShare > 0.5);
});

test("a near-empty document is not trusted as basic HTML", () => {
  const result = detectBasicHtml("<html><body><div id=root></div></body></html>");
  assert.equal(result.mode, STYLED_PAGE);
  assert.equal(result.basic, false);
});

test("empty and nullish input are handled", () => {
  for (const input of ["", "   ", null, undefined]) {
    const result = detectBasicHtml(input);
    assert.equal(result.mode, STYLED_PAGE);
    assert.equal(result.text, "");
  }
});

test("script and style content never leaks into the extracted text", () => {
  const noisy = PLAIN_JOB_PAGE.replace(
    "<body>",
    "<body><style>.x{}</style><script>var secret='do-not-leak';</script>",
  );
  const result = detectBasicHtml(noisy);
  assert.doesNotMatch(result.text, /do-not-leak/);
  assert.doesNotMatch(result.text, /\.x\{\}/);
});

test("comments and nav chrome are stripped from the text", () => {
  const withNoise = PLAIN_JOB_PAGE.replace(
    "<body>",
    "<body><!-- sidebar nav --><nav>Home About</nav>",
  );
  const result = detectBasicHtml(withNoise);
  assert.doesNotMatch(result.text, /sidebar nav/);
});
