/**
 * One-click apply across the Instahyre queue, using the pipeline's own profile.
 *
 * Why this exists and why it is not apply.mjs. Instahyre does not present an
 * application form at all once the candidate is signed in with a complete
 * profile - "Apply now" submits immediately and the button becomes
 * "Application sent! on <date>". apply.mjs is built to fill fields and find a
 * Submit, so against Instahyre it correctly finds no form, and 21 attempts ended
 * as NeedsVerification with the log saying only "clicked final Apply now". The
 * eleven submissions that did land were made by hand in the review browser, one
 * at a time, and stopped the moment that session expired.
 *
 * The blocker was never the automation. It was that the only session was in a
 * browser with no durable profile. insta_password_reset.mjs gave .edge-profile a
 * password-based session by reading the reset mail out of this project's own
 * IMAP access, so no human step remains:
 *
 *   - no Cloudflare challenge solving (headed, and it clears on its own)
 *   - no CAPTCHA handling
 *   - no credential typing by anyone
 *
 * Every send is confirmed by Instahyre's dated acknowledgement and nothing else
 * counts. A click with no acknowledgement is reported as unconfirmed and NOT
 * written to the database - the distinction that 21 earlier attempts lost.
 *
 * Usage:
 *   node apps/browser-apply/tools/insta_bulk_apply.mjs --limit 20
 *   node apps/browser-apply/tools/insta_bulk_apply.mjs --ids 821,840,857
 *   node apps/browser-apply/tools/insta_bulk_apply.mjs --recheck
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const PROFILE = path.join(ROOT, ".edge-profile");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(arg("--limit", "20"));
const ONLY_IDS = arg("--ids", "");
const RECHECK = argv.includes("--recheck");

if (!existsSync(PROFILE)) {
  console.error(`  no persistent profile at ${PROFILE}`);
  process.exit(1);
}

// ---- the queue, straight from the database ---------------------------------
// The DB path and the id filter are passed as argv, not interpolated into the
// Python source. Interpolating a Windows path into an r"..." literal inside a JS
// template mangled the backslashes, the spawned script died, and the JSON parse
// fell back to an empty queue - which printed "queue: 0 posting(s)" against 94
// actionable rows and looked like there was simply nothing to do.
const py = `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1])
q = c.cursor()
q.execute("""SELECT id, company, title, link FROM jobs
             WHERE link LIKE '%instahyre%'
               AND LOWER(COALESCE(status,'')) NOT IN
                 ('verified','applied','expired','skipped','rejected','dead-link')
             ORDER BY score DESC, id""")
rows = q.fetchall()
only = set(int(x) for x in sys.argv[2].split(",") if x.strip())
out = [dict(id=r[0], company=r[1], title=r[2], link=r[3]) for r in rows
       if (not only or r[0] in only)]
lim = int(sys.argv[3])
print(json.dumps(out if lim <= 0 else out[:lim]))
`;
const listed = spawnSync(
  "python",
  ["-X", "utf8", "-c", py, path.join(ROOT, "pulseops.db"), ONLY_IDS, String(RECHECK ? 0 : LIMIT)],
  { encoding: "utf8" },
);
if (listed.status !== 0) {
  console.error(`  queue query failed (exit ${listed.status}): ${String(listed.stderr || "").slice(0, 300)}`);
  process.exit(1);
}
let queue = [];
try {
  queue = JSON.parse(String(listed.stdout || "[]").trim().split("\n").pop() || "[]");
} catch (e) {
  console.error(`  could not parse the queue: ${String(e).slice(0, 120)}`);
  console.error(String(listed.stdout || "").slice(0, 300));
  process.exit(1);
}
console.log(`  queue: ${queue.length} posting(s)${RECHECK ? " (recheck mode - no clicks)" : ""}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});

const readState = async (page) =>
  page
    .evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const x = (document.body?.innerText || "").replace(/\s+/g, " ");
      const apply = [...document.querySelectorAll("button, a")]
        .filter(vis)
        .find((b) => /^apply now$/i.test(((b.innerText || "") + "").trim()));
      // An anchor with no href is absent from the accessibility tree, so it has
      // no ref to click. Give it a role and a tabindex; the handler is untouched.
      if (apply && apply.tagName === "A") {
        apply.setAttribute("role", "button");
        apply.setAttribute("tabindex", "0");
      }
      const m = x.match(/Application sent! on [A-Za-z]+ [0-9]+, [0-9]+/i);
      return {
        sent: m ? m[0] : null,
        applyable: Boolean(apply),
        len: x.length,
        signedIn: /sign out/i.test(x),
        challenged: /just a moment|performing security verification/i.test(x),
        closed: /no longer (accepting|available)|job (?:is )?closed|this job is (?:no longer|closed)/i.test(
          x.slice(0, 2500),
        ),
        url: location.href,
      };
    })
    .catch(() => null);

const results = [];
for (const job of queue) {
  const row = { id: job.id, company: job.company, title: job.title };
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(job.link, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Render is slow and Cloudflare may interject; poll rather than guess a wait.
    let st = null;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(4000);
      st = await readState(page);
      if (st && (st.sent || st.applyable || st.closed || !st.signedIn)) break;
    }
    if (!st) { row.result = "page never rendered"; results.push(row); continue; }
    if (st.challenged) { row.result = "cloudflare challenge - skipped"; results.push(row); continue; }
    if (!st.signedIn) { row.result = "session lost - stopped"; results.push(row); break; }
    if (st.sent) { row.result = "ALREADY SENT"; row.evidence = st.sent; results.push(row); continue; }
    if (st.closed) { row.result = "listing closed"; results.push(row); continue; }
    if (!st.applyable) { row.result = "no Apply control"; results.push(row); continue; }
    if (RECHECK) { row.result = "unsent (still applyable)"; results.push(row); continue; }

    // Click EVERY ref that resolves to the control. The snapshot returns two
    // identical refs at the same coordinates, and clicking only the first did
    // nothing on 7 consecutive postings - it is a dead node. Both is what works.
    let ack = null;
    for (let pass = 0; pass < 3 && !ack; pass++) {
      // Click EVERY node that resolves to the control. The accessibility snapshot
      // exposes two identical refs at the same coordinates and the first is a
      // dead node; clicking only it produced "clicked, no ack" on seven
      // consecutive postings. Both is what works.
      const handle = await page.evaluateHandle(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const a = [...document.querySelectorAll('[role="button"]')].filter(vis)
          .find((b) => /^apply now$/i.test(((b.innerText || "") + "").trim()));
        return a || null;
      });
      const el = handle.asElement();
      if (!el) { await page.waitForTimeout(2000); continue; }
      await el.click({ timeout: 10000 }).catch(() => {});

      // The other node behind the same control. It has to come back as an
      // ElementHandle, not as the result of page.evaluate - that returns a plain
      // serialised value, and calling .click() on one throws
      // "twin.click is not a function", which is what killed the whole first
      // bulk run on 73 postings.
      const twinHandle = await page.evaluateHandle(() => {
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const all = [...document.querySelectorAll("button, a")]
          .filter(vis)
          .filter((b) => /^apply now$/i.test(((b.innerText || "") + "").trim()));
        return all.length > 1 ? all[all.length - 1] : null;
      });
      const twin = twinHandle.asElement();
      if (twin) await twin.click({ timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 8 && !ack; i++) {
        await page.waitForTimeout(3000);
        const s2 = await readState(page);
        ack = s2 && s2.sent ? s2.sent : null;
      }
    }
    row.result = ack ? "SENT" : "clicked, unconfirmed";
    row.evidence = ack;
  } catch (e) {
    row.result = "error: " + String(e).slice(0, 70);
  }
  results.push(row);
  const tag = row.result === "SENT" ? "SENT   " : "       ";
  console.log(`  ${tag}#${String(row.id).padEnd(5)} ${String(row.company).slice(0, 18).padEnd(20)} ${row.result}`);
}

await ctx.close();

// ---- persist, and only what is confirmed ------------------------------------
const confirmed = results.filter((r) => r.result === "SENT" && r.evidence);
const already = results.filter((r) => r.result === "ALREADY SENT" && r.evidence);
const toRecord = [...confirmed, ...already];
if (toRecord.length) {
  const args = toRecord
    .map((r) => `${r.id}:${r.evidence.replace(/'/g, "")}`)
    .join("|");
  const rec = spawnSync(
    "python",
    ["-X", "utf8", path.join(ROOT, "apps", "browser-apply", "tools", "record_instahyre_submit.py"), "--bulk", args],
    { encoding: "utf8" },
  );
  // The exit code is checked. It was not, and the recorder exited 2 on every one
  // of 83 postings - "--job-id is required" - so the run printed
  // "recorded 83 confirmed submission(s)" and wrote NOTHING. A wrapper that
  // reports its own count instead of the child's result will happily claim work
  // that never landed, and the database is the only place that disagrees.
  if (rec.status !== 0) {
    console.error(`\n  RECORDER FAILED (exit ${rec.status}) - ${toRecord.length} confirmed submission(s) NOT written:`);
    console.error(`  ${String(rec.stderr || "").slice(0, 400)}`);
    console.error("  Re-run with --recheck to collect and record them; no clicks needed.");
    await ctx.close();
    process.exit(1);
  }
  console.log(`\n  recorded ${toRecord.length} confirmed submission(s)`);
  if (String(rec.stdout || "").trim())
    console.log(String(rec.stdout).trim().split("\n").slice(0, 6).map((l) => "    " + l).join("\n"));
} else {
  console.log("\n  nothing new to record");
}

const tally = {};
for (const r of results) tally[r.result] = (tally[r.result] || 0) + 1;
console.log(`\n  ${queue.length} attempted:`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)}  ${k}`);
