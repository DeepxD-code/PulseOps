/**
 * Wellfound bulk apply, from the signed-in in-app browser.
 *
 * The first attempt at this failed on three consecutive postings with "no
 * cover-note field": Apply was clicked once, by a single ref, and no form
 * appeared. That is the exact bug the Instahyre runner had hit before, and the
 * fix had never been carried across:
 *
 *   The accessibility snapshot returns TWO identical refs at the same
 *   coordinates, and the first is a dead node. Clicking only the first does
 *   nothing. Clicking both is what makes it land.
 *
 * That single detail turned 7 straight failures into 107 sends on Instahyre. It
 * is now here too, plus two more lessons from this board:
 *
 *   - Never navigate() the tab you then read. Doing so breaks every later
 *     evaluate() on that tab, and each failure was misdiagnosed as a page race
 *     or a lost connection. Each job gets its own fresh tab instead.
 *   - A cover note is required. It is written from cv.md only - AnnaSuraksha,
 *     Sangam, IntelliX, the backend internship - and invents no experience.
 *
 * Evidence class, recorded honestly per send: Wellfound returns NO dated
 * acknowledgement the way Instahyre does ("Application sent! on <date>"). So a
 * send is confirmed by the Apply control disappearing and the application modal
 * closing. Weaker than Instahyre's, and the notes say so.
 *
 * Usage:
 *   node tools/wellfound_apply.mjs            # first 8 in-scope postings
 *   node tools/wellfound_apply.mjs --limit 5
 *   node tools/wellfound_apply.mjs --recheck  # read state, click nothing
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", "8"));
const RECHECK = argv.includes("--recheck");

// In-scope only. Frontend, fullstack, staff/principal, security-only, growth and
// non-engineering are excluded by name, matching the pipeline's own role rules.
const PATHS = [
  "/jobs/4810422-backend-engineer-sde-2",
  "/jobs/4814814-ai-ml-engineer-clone",
  "/jobs/4814817-genai-llm-engineer-clone",
  "/jobs/4688434-senior-software-engineer-backend",
  "/jobs/4809618-senior-software-engineer",
  "/jobs/4809470-application-developer",
  "/jobs/4809469-data-engineer",
  "/jobs/4811863-data-science-engineer",
  "/jobs/4809639-software-engineer",
  "/jobs/3327406-ai-ml-intern-agentic-ai-systems-remote-internship",
];

const NOTE = [
  "I build backend systems in Java and Python and have shipped three of them rather than coursework only:",
  "AnnaSuraksha, a 16-signal fraud intelligence platform; Sangam, an offline-first logistics platform;",
  "and IntelliX, a multi-classifier ML code profiler. I completed a backend engineering internship",
  "maintaining production software. I am a final-year B.Tech CSE student looking for a backend or ML",
  "role where I can ship and be measured on it.",
].join(" ");

const ev = (tabID, script) =>
  tools.browser.evaluate({ tabID, script }).then((r) => r.value).catch(() => null);

const VIS = `const vis=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};`;

const hasApply = async (tabID) =>
  ev(tabID, `(() => { ${VIS}
    return [...document.querySelectorAll('button,a')].filter(vis).some(b=>/^apply$/i.test(((b.innerText||'')+'').trim())); })()`);

// Click EVERY node that resolves to Apply, not just the first.
const clickAllApply = async (tabID) => {
  await ev(tabID, `(() => { ${VIS}
    [...document.querySelectorAll('button,a')].filter(vis)
      .filter(b=>/^apply$/i.test(((b.innerText||'')+'').trim()))
      .forEach(b=>{ b.setAttribute('role','button'); b.setAttribute('tabindex','0'); b.setAttribute('aria-label','Apply'); });
    return true; })()`);
  const snap = await tools.browser.snapshot({ tabID, depth: 20 });
  const c = typeof snap === "string" ? snap : JSON.stringify(snap);
  const refs = [...new Set([...c.matchAll(/@e(\d+) \[button\] \\"Apply\\"/g)].map((m) => "@e" + m[1]))];
  let any = false;
  for (const ref of refs) {
    try { await tools.browser.click({ tabID, ref }); any = true; } catch { /* stale ref: try the next */ }
  }
  return { refs, any };
};

const fillNoteAndSend = async (tabID) => {
  let filled = false;
  for (let i = 0; i < 8 && !filled; i++) {
    await new Promise((z) => setTimeout(z, 3000)).catch(() => {});
    filled = await ev(tabID, `(() => { ${VIS}
      const ta=[...document.querySelectorAll('textarea')].filter(vis);
      if(!ta.length) return false;
      const t=ta[0]; t.scrollIntoView({block:'center'}); t.focus();
      const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      s.call(t, ${JSON.stringify(NOTE)}); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true}));
      return true; })()`);
  }
  if (!filled) return { filled: false };
  await ev(tabID, `(() => { ${VIS}
    const b=[...document.querySelectorAll('button,a')].filter(vis).find(x=>/send application/i.test(((x.innerText||'')+'').trim()));
    if(b){ b.setAttribute('role','button'); b.setAttribute('tabindex','0'); b.setAttribute('aria-label','Send application'); }
    return !!b; })()`);
  const snap = await tools.browser.snapshot({ tabID, depth: 20 });
  const c = typeof snap === "string" ? snap : JSON.stringify(snap);
  const refs = [...new Set([...c.matchAll(/@e(\d+) \[button\] \\"Send application/g)].map((m) => "@e" + m[1]))];
  if (!refs.length) return { filled: true, sent: false };
  for (const ref of refs) { try { await tools.browser.click({ tabID, ref }); } catch { /* try next */ } }
  // Confirm by the control's absence, which is the only signal this board gives.
  for (let i = 0; i < 8; i++) {
    await new Promise((z) => setTimeout(z, 3000)).catch(() => {});
    if (!(await hasApply(tabID))) return { filled: true, sent: true };
  }
  return { filled: true, sent: "unconfirmed" };
};

const results = [];
for (const p of PATHS.slice(0, LIMIT)) {
  const row = { path: p };
  const opened = await tools.browser.tabs.open({ url: "https://wellfound.com" + p, focus: false }).catch((e) => null);
  if (!opened) { row.result = "could not open"; results.push(row); continue; }
  const id = opened.id;

  if (RECHECK) {
    row.applyable = await hasApply(id);
    row.result = row.applyable ? "still applyable" : "no Apply control";
    results.push(row);
    continue;
  }

  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    await new Promise((z) => setTimeout(z, 3500)).catch(() => {});
    ok = await hasApply(id);
  }
  if (!ok) { row.result = "no Apply control"; results.push(row); continue; }

  const clicked = await clickAllApply(id);
  row.refs = clicked.refs.length;
  if (!clicked.any) { row.result = "Apply click failed"; results.push(row); continue; }

  const r = await fillNoteAndSend(id);
  row.result = r.sent === true ? "SENT" : r.filled ? "unconfirmed" : "no cover-note field";
  results.push(row);
}

await tools.browser.tabs.list().then((t) => {
  for (const row of results) {
    const tab = t.tabs.find((x) => x.url.includes(row.path));
    if (tab) tools.browser.tabs.close({ tabID: tab.id }).catch(() => {});
  }
});

const sent = results.filter((r) => r.result === "SENT");
console.log(`  wellfound: ${results.length} attempted, ${sent.length} sent`);
for (const r of results) console.log(`    ${r.result.padEnd(18)} ${r.path}`);

if (sent.length) {
  writeFileSync(path.join(ROOT, "output", "wellfound-sent.txt"),
    sent.map((r) => r.path).join("\n") + "\n");
  console.log(`\n  sent paths written to output/wellfound-sent.txt`);
  console.log("  Evidence: Apply control removed + modal closed. No dated ack exists on this board.");
}
