/**
 * Sign the automation profile in to each board, once, with a human present.
 *
 * Why this exists: the sourcing side works, so the boards all have jobs to apply
 * to - but the apply runner drives one persistent Edge profile, and on 2026-11-03
 * that profile was logged in to Naukri and logged OUT of Wellfound, Instahyre,
 * Hirist and LinkedIn. A logged-out board does not error; it shows a signup form,
 * the click is recorded, and nothing is submitted. That is how ~99 rows sat in
 * NeedsVerification with no mail to show for them.
 *
 *   node tools/signin.mjs              # every board, in order
 *   node tools/signin.mjs wellfound    # just one
 *
 * It never types a credential and never resets a password. It opens the board's
 * login page in the real profile and waits while you sign in however you normally
 * do - password, Google, or an emailed code. Detection is read off the page, so
 * the session is only declared ready when the board itself says so.
 */
import path from "node:path";

const BOARDS = {
  wellfound: {
    login: "https://wellfound.com/login",
    done: /my profile|my jobs|applications|messages|log ?out|sign ?out/i,
  },
  naukri: {
    login: "https://www.naukri.com/nlogin/login",
    done: /my naukri|logout|complete profile|recommended jobs/i,
  },
  instahyre: {
    login: "https://www.instahyre.com/login/",
    done: /opportunities|log ?out|my profile|applications/i,
  },
  hirist: {
    login: "https://www.hirist.tech/",
    done: /log ?out|my profile|my applications|recommended/i,
  },
  linkedin: {
    login: "https://www.linkedin.com/login",
    done: /my network|start a post|messaging|sign ?out/i,
  },
};

const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
const queue = wanted.length ? wanted : Object.keys(BOARDS);
for (const name of queue) {
  if (!BOARDS[name]) {
    console.error(`  unknown board "${name}". known: ${Object.keys(BOARDS).join(", ")}`);
    process.exit(1);
  }
}

const profile = path.resolve(process.env.PULSEOPS_EDGE_PROFILE || ".edge-profile-naukri");
const timeoutMin = Number(process.env.SIGNIN_TIMEOUT_MIN || 6);
const { chromium } = await import("playwright");

console.log(`  profile: ${profile}`);
console.log(`  boards : ${queue.join(", ")}`);
console.log(`  waiting up to ${timeoutMin} min per board\n`);

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

const results = [];

for (const name of queue) {
  const board = BOARDS[name];
  await page.goto(board.login, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  console.log(`  [${name}] window open - sign in now (${board.login})`);

  const deadline = Date.now() + timeoutMin * 60_000;
  let state = { ok: false, url: "", why: "timed out" };

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    state = await page.evaluate((src) => {
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const onWall = /\/(?:login|signin|sign_in|uas\/login|nlogin\/login)/i.test(location.href);
      return {
        ok: !onWall && new RegExp(src, "i").test(body),
        url: location.href,
        why: onWall ? "still on the login page" : body.slice(0, 90),
      };
    }, board.done.source).catch(() => state);
    if (state.ok) break;
  }

  console.log(state.ok
    ? `  [${name}] LOGGED IN - ${state.url.slice(0, 80)}\n`
    : `  [${name}] not signed in (${state.why})\n`);
  results.push([name, state.ok]);
}

await ctx.close();
console.log("  summary");
for (const [name, ok] of results) console.log(`    ${ok ? "OK  " : "MISS"}  ${name}`);
const live = results.filter(([, ok]) => ok).length;
console.log(`\n  ${live}/${results.length} board(s) ready for the apply runner.`);
process.exit(live === results.length ? 0 : 2);
