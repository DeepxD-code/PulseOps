// Did the Wellfound submission actually land?
//
// The apply engine clicks the final "Apply Now" and then reports
// needs-verification, because the on-page acknowledgement it looks for
// ("application submitted" in body text) is not what Wellfound renders - it
// swaps the Apply control for an applied marker and mails a receipt instead.
// So the on-page state, read after the fact, is the real evidence.
//
// Read-only: it opens each job page in the same persistent profile the apply
// phase uses and reports the apply control's state. It never clicks.
//
// Usage:
//   node apps/browser-apply/tools/verify-wellfound.mjs https://wellfound.com/jobs/123-x
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const urls = process.argv.slice(2).filter((a) => a.startsWith("http"));
if (!urls.length) {
  console.error("usage: node tools/verify-wellfound.mjs <job-url> [...]");
  process.exit(2);
}

const profile = process.env.PULSEOPS_EDGE_PROFILE || path.join(ROOT, ".edge-profile-naukri");
const { chromium } = await import("playwright");
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: true,
  viewport: { width: 1366, height: 900 },
});

for (const url of urls) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    const state = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const control = [...document.querySelectorAll("button, a")]
        .map((el) => ({ el, text: norm(el.innerText || el.value || "") }))
        .filter(({ text }) => /^(apply( now| to job)?|applied|message sent|application sent|messaged)$/i.test(text));
      return {
        controls: control.map(({ text }) => text).slice(0, 6),
        appliedMarker: /you(?:'ve| have) applied|application sent|message sent|applied on/i.test(document.body?.innerText || ""),
        title: document.title,
      };
    });
    const verdict = state.appliedMarker || state.controls.some((c) => /applied|sent|messaged/i.test(c))
      ? "SUBMITTED"
      : state.controls.some((c) => /apply/i.test(c))
        ? "NOT SUBMITTED (Apply still offered)"
        : "UNCLEAR";
    console.log(`${verdict}\n  ${url}\n  controls=${JSON.stringify(state.controls)} marker=${state.appliedMarker}`);
  } catch (e) {
    console.log(`ERROR ${url}: ${String(e).slice(0, 160)}`);
  } finally {
    await page.close().catch(() => {});
  }
}
await ctx.close();
