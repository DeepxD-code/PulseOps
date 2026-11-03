// Which board sessions are actually alive in the automation profile?
//
// The apply runner drives .edge-profile-naukri. A board that answers with its
// login wall silently turns every application into a signup form, which is what
// happened with Wellfound: the click was logged, the modal filled, and nothing
// was submitted for weeks. Checking the header state of each source board is the
// only cheap way to know the pipeline is live rather than merely busy.
//
// Read-only: loads each page and reports logged-in / logged-out.
import path from "node:path";

const profile = process.env.PULSEOPS_EDGE_PROFILE || ".edge-profile-naukri";

const BOARDS = [
  ["wellfound", "https://wellfound.com/"],
  ["naukri", "https://www.naukri.com/mnjuser/profile"],
  ["instahyre", "https://www.instahyre.com/candidate/opportunities/"],
  ["hirist", "https://www.hirist.tech/"],
  ["linkedin", "https://www.linkedin.com/feed/"],
];

const { chromium } = await import("playwright");
const headed = process.env.PULSEOPS_HEADED === "1";
const ctx = await chromium.launchPersistentContext(path.resolve(profile), {
  channel: "msedge",
  headless: !headed,
  viewport: { width: 1366, height: 900 },
});

for (const [name, url] of BOARDS) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3500);
    const state = await page.evaluate(() => {
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const has = (re) => re.test(body);
      return {
        url: location.href,
        title: document.title.slice(0, 60),
        loginWall: has(/\blog ?in\b|\bsign ?in\b|\bsign ?up\b/i),
        account: has(/log ?out|sign ?out|my profile|my account|my applications|messages|dashboard|recommendations/i),
        head: body.slice(0, 150),
      };
    });
    const verdict = state.account && !/\/login|\/signin/i.test(state.url)
      ? "LOGGED IN"
      : state.loginWall
        ? "LOGGED OUT"
        : "UNCLEAR";
    console.log(`${verdict.padEnd(10)} ${name.padEnd(10)} ${state.url.slice(0, 70)}`);
    if (verdict !== "LOGGED IN") console.log(`           head: ${state.head}`);
  } catch (err) {
    console.log(`ERROR      ${name.padEnd(10)} ${String(err.message).slice(0, 80)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

await ctx.close();
