// Why is each Evaluated row not eligible? Re-implements the gate's conditions
// with the real exported helpers so the reason per row is observed, not guessed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  isAllowedInitialJobUrl,
  isStrictTargetRole,
  isBlacklistedJob,
  isSimulationJob,
  isEligibleJob,
  inferATS,
} from "../apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Rows come from the same Python bridge the engine uses; there is no node
// SQLite driver in this project.
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "output", "evaluated-rows.json"), "utf8"));

const reasons = new Map();
const bump = (r) => reasons.set(r, (reasons.get(r) || 0) + 1);
const detail = new Map();
const note = (id, r) => { if (!detail.has(r)) detail.set(r, []); detail.get(r).push(id); };

for (const row of rows) {
  const link = row.link || "";
  const ats = inferATS(link);
  let reason = null;
  if (!link) reason = "no link";
  else if (!isAllowedInitialJobUrl(link)) reason = `blocked URL (${new URL(link).hostname})`;
  else if (!isStrictTargetRole(row.title)) reason = "out-of-scope role";
  else if (row.score < 75) reason = `score ${row.score} < 75`;
  else if (ats === "indeed") reason = "Indeed (out of scope by policy)";
  else if (isSimulationJob(row)) reason = "simulation/mock";
  else if (isBlacklistedJob(row)) reason = "blacklisted";
  else if (isEligibleJob(row)) reason = "ELIGIBLE";
  else reason = "other gate";
  bump(reason);
  note(row.id, reason);
}

console.log(`Evaluated rows: ${rows.length}\n`);
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  const ids = detail.get(reason).slice(0, 8).join(", ");
  console.log(`${String(n).padStart(3)}  ${reason.padEnd(34)} ${ids}`);
}
