// Why is each Evaluated row not eligible, and in what order will the batch run?
//
// Re-implements the gate's conditions with the real exported helpers, so the
// reason per row is observed rather than guessed.
//
// It reads the database LIVE. It used to read output/evaluated-rows.json, which
// is a snapshot written by whichever run happened to produce it last - it was
// reporting 79 rows while the table held 104, so the answer was quietly about
// the past.
//
// It also used to bucket rows as "score N < 75". That gate no longer exists:
// apply.mjs applies scope as the hard gate and uses score only to rank the
// in-scope pool (in-scope median 52 vs out-of-scope 65, so a score floor rejected
// the roles worth applying to). Reporting a floor here again would recreate the
// same misunderstanding in the diagnostics.
//
// Usage:
//   node tools/why-not-eligible.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  isAllowedInitialJobUrl,
  isStrictTargetRole,
  isBlacklistedJob,
  isSimulationJob,
  isEligibleJob,
  rankByAcceptance,
  isIndiaBoardRow,
  inferATS,
} from "../apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function dbCandidates() {
  const dbPath = [process.env.PULSEOPS_DB_PATH, path.join(ROOT, "pulseops.db")]
    .filter(Boolean)
    .find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!dbPath) {
    console.error("[why-not-eligible] pulseops.db not found; set PULSEOPS_DB_PATH");
    process.exit(1);
  }
  const pythonCode = `
import json, sqlite3, sys
conn = sqlite3.connect("file:%s?mode=ro" % sys.argv[1].replace("\\\\","/"), uri=True)
conn.row_factory = sqlite3.Row
rows = [dict(r) for r in conn.execute(
    'SELECT id, company, title, link, score, status, source, run_id, text_summary '
    "FROM jobs WHERE LOWER(COALESCE(status,''))='evaluated' ORDER BY id").fetchall()]
print(json.dumps(rows))
`;
  const out = execFileSync("python", ["-c", pythonCode, dbPath], {
    encoding: "utf-8", timeout: 30000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const line = out.trim().split(/\r?\n/).pop();
  return line ? JSON.parse(line) : [];
}

const rows = dbCandidates();
const reasons = new Map();
const bump = (r) => reasons.set(r, (reasons.get(r) || 0) + 1);
const detail = new Map();
const note = (id, r) => { if (!detail.has(r)) detail.set(r, []); detail.get(r).push(id); };
const eligible = [];

for (const row of rows) {
  const link = row.link || "";
  const ats = inferATS(link);
  let reason = null;
  if (!link) reason = "no link";
  else if (!isAllowedInitialJobUrl(link)) reason = `blocked URL (${new URL(link).hostname})`;
  // Pass the description too. A generic title like "Software Engineer" carries
  // no keyword, and isStrictTargetRole deliberately falls through to the JD body
  // for exactly those - so checking the title alone reports 56 in-scope roles
  // as rejected, which is what made this tool contradict the engine.
  else if (!isStrictTargetRole(row.title, row.text_summary || "")) reason = "out-of-scope role";
  else if (ats === "indeed") reason = "Indeed (out of scope by policy)";
  else if (isSimulationJob(row)) reason = "simulation/mock";
  else if (isBlacklistedJob(row)) reason = "blacklisted";
  else if (isEligibleJob(row)) reason = "ELIGIBLE";
  // isEligibleJob also reads the send-pause state, which lives behind the
  // engine's own Python bridge and is not in this row. Name the bucket for
  // what it is instead of implying a gate that has not been evaluated.
  else reason = "ELIGIBLE (send-pause state not checked here)";
  if (reason.startsWith("ELIGIBLE")) eligible.push(row);
  bump(reason);
  note(row.id, reason);
}

console.log(`Evaluated rows: ${rows.length}\n`);
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  const ids = detail.get(reason).slice(0, 8).join(", ");
  console.log(`${String(n).padStart(3)}  ${reason.padEnd(38)} ${ids}`);
}

// The batch slots are spent in this order. Acceptance history is not loaded
// here, so the record tiebreak is left out; market and score are the two that
// decide which role leads the batch.
if (eligible.length) {
  const ordered = rankByAcceptance(eligible, new Map());
  console.log(`\nBatch order (top ${Math.min(12, ordered.length)} of ${ordered.length}):`);
  for (const row of ordered.slice(0, 12)) {
    const market = isIndiaBoardRow(row) ? "IN" : "US";
    console.log(`  ${market} ${String(row.score).padStart(3)}  ${String(row.source || "").slice(0, 26).padEnd(26)} ${String(row.title || "").slice(0, 56)}`);
  }
  const india = eligible.filter(isIndiaBoardRow).length;
  console.log(`\n${india} India-board rows, ${eligible.length - india} US/ATS rows.`);
}
