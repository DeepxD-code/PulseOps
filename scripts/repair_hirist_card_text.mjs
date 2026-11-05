#!/usr/bin/env node
/**
 * Repair Hirist rows whose company and title were split out of the card's
 * flattened anchor text.
 *
 * The old scraper read the whole anchor, which is every field run together with
 * no separator:
 *
 *   "AI Agent Platform7 - 12 yrsBangaloreJavaSpring Boot..."
 *
 * so it split on " - " and got a title with the experience band glued on
 * ("AI Agent Platform7"), and when a card carried no company at all it filed the
 * job title in the company column ("Software Engineer"). Twelve of the last
 * thirty-two Hirist rows had the first defect and nine the second. Both are
 * silent: the receipt that proves a submission names the company, so a row with
 * the wrong company can never be verified.
 *
 * The scraper is fixed (mapHiristCards in apps/weekly-scan/scan.mjs). This
 * rebuilds the rows already stored, by undoing the glue and running the same
 * function, so there is one definition of how a Hirist card is read.
 *
 *   node scripts/repair_hirist_card_text.mjs            # report only
 *   node scripts/repair_hirist_card_text.mjs --apply
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mapHiristCards } from "../apps/weekly-scan/scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(ROOT, "pulseops.db");
const APPLY = process.argv.includes("--apply");

// "5 - 8 yrs" / "7 yrs" - the experience band, which is where the old split
// stopped being able to tell role from metadata.
const EXPERIENCE_BAND = /\b\d{1,2}(?:\s*(?:-|\u2013|to)\s*\d{1,2})?\s*yrs?/i;
// "Platform7": a single number stuck to the last letter of the role. The space
// is required to be absent, so "Engineer 2" and "Developer II" are left alone.
const GLUED_EXPERIENCE = /(?<=[A-Za-z])\d{1,2}$/;

function cleanTitle(title) {
  let text = String(title || "").replace(/\s+/g, " ").trim();
  const band = text.match(EXPERIENCE_BAND);
  if (band && band.index !== undefined) text = text.slice(0, band.index).trim();
  return text.replace(GLUED_EXPERIENCE, "").trim();
}

function cleanCompany(company) {
  return String(company || "").replace(/\s+/g, " ").trim().replace(GLUED_EXPERIENCE, "").trim();
}

const db = new DatabaseSync(DB_PATH);
const rows = db
  .prepare("SELECT id, source, company, title, link FROM jobs WHERE source LIKE 'Hirist%' ORDER BY id")
  .all();

const changes = [];
const skipped = [];
for (const row of rows) {
  const company = cleanCompany(row.company);
  const title = cleanTitle(row.title);
  // Rebuild the heading the card showed, then let the scraper's own function
  // decide what is the employer and what is the role. A row whose title was
  // entirely the experience band (#1052: "8 yrsMultiple Locations...") has its
  // heading in the company column alone - that column held the role, glued to
  // the band's first digit.
  let heading;
  if (title && company && company !== "Unknown") {
    heading = title === company ? company : `${company} - ${title}`;
  } else {
    heading = title || company;
  }
  if (!heading || heading.length < 4) {
    skipped.push([row.id, row.company, row.title]);
    continue;
  }
  const parsed = mapHiristCards([{ link: row.link, heading }], row.source)[0];
  if (!parsed) {
    skipped.push([row.id, row.company, row.title]);
    continue;
  }
  if (parsed.company !== row.company || parsed.title !== row.title) {
    changes.push({ id: row.id, before: [row.company, row.title], after: [parsed.company, parsed.title] });
  }
}

console.log(`  Hirist rows: ${rows.length}`);
console.log(`  would change: ${changes.length}`);
console.log(`  unreadable (left alone): ${skipped.length}`);
for (const [id, company, title] of skipped) console.log(`    #${id}  ${company} | ${title}`);
for (const { id, before, after } of changes) {
  console.log(`    #${id}`);
  console.log(`      company: ${before[0]} -> ${after[0]}`);
  console.log(`      title  : ${before[1]} -> ${after[1]}`);
}

if (!APPLY) {
  console.log("\n  report only - pass --apply to write these rows");
  process.exit(0);
}

const update = db.prepare("UPDATE jobs SET company = ?, title = ? WHERE id = ?");
db.exec("BEGIN");
try {
  for (const { id, after } of changes) update.run(after[0], after[1], id);
  db.exec("COMMIT");
  console.log(`\n  updated ${changes.length} row(s)`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("  rollback:", e.message);
  process.exit(1);
}
db.close();
