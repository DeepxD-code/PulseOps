/**
 * Read a LinkedIn posting's own record of the application. Read-only.
 *
 *   node apps/browser-apply/tools/verify-linkedin.mjs <job-url> [...]
 *
 * Why this exists: the apply runner reporting "verified" is the engine grading
 * its own work. LinkedIn publishes the fact on the posting page - "Application
 * status: Application submitted" - which is evidence from the board instead.
 *
 * The stored links are in.linkedin.com/jobs/view/<slug>-<id> with tracking
 * parameters; that host answers /authwall even for a signed-in profile, so the
 * URL is normalised to www.linkedin.com/jobs/view/<id> first (same rewrite the
 * apply runner does).
 */
import path from "node:path";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: verify-linkedin.mjs <job-url> [...]");
  process.exit(2);
}

const profile = path.resolve(process.env.PULSEOPS_EDGE_PROFILE || ".edge-profile-naukri");
const { chromium } = await import("playwright");

function normalise(raw) {
  try {
    const parsed = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return raw;
    const id = (parsed.pathname.match(/(\d{6,})/) || [])[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
    // Slug-only links still resolve on www; the in.* host answers /authwall.
    return /\/jobs\/view\b/.test(parsed.pathname)
      ? `https://www.linkedin.com${parsed.pathname}`
      : raw;
  } catch {
    return raw;
  }
}

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

for (const raw of urls) {
  const url = normalise(raw);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const submitted = /Application status\s+Application submitted/i.test(text)
      || /Application submitted/i.test(text);
    const applied = /(?:^|\s)Applied(?:\s|$)/i.test(text.slice(0, 2000));
    const wall = /authwall|\/login|sign in to continue/i.test(location.href + " " + text.slice(0, 300));
    return { submitted, applied, wall, url: location.href.slice(0, 100) };
  }).catch(() => ({ submitted: false, applied: false, wall: true, url: "" }));

  const verdict = state.wall
    ? "WALL (not signed in)"
    : state.submitted || state.applied ? "SUBMITTED" : "NOT SUBMITTED";
  console.log(verdict);
  console.log(`  ${url}`);
  console.log(`  submitted=${state.submitted} applied=${state.applied}`);
}

await ctx.close();
