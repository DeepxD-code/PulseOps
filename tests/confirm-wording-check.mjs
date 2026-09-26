// Verifies the post-submit confirmation wording the portals actually use.
const pattern = /application submitted|applied successfully|thank you for applying|thanks for applying|(?:we(?:'ve| have)) received your application|application[-_/ ]sent|you applied/i;

const cases = [
  ["Thanks for applying!", true],
  ["We have received your application for Backend Engineer (Agentic AI).", true],
  ["We've received your application for Backend Engineer.", true],
  ["Thank you for applying", true],
  ["Application submitted", true],
  ["/pages/myshine/job-apply-flow/application-sent?redirectTo=x", true],
  ["Apply now", false],
  ["Backend Engineer at Autter. Apply for this role", false],
  ["No open roles right now", false],
  ["Application tracking is now open", false],
];

let failed = 0;
for (const [text, want] of cases) {
  const got = pattern.test(text);
  if (got !== want) failed += 1;
  console.log(`${got === want ? "ok  " : "FAIL"}  ${JSON.stringify(text)} -> ${got}`);
}
console.log(failed ? `${failed} failing` : "all confirmation wordings pass");
process.exit(failed ? 1 : 0);
