// Print whatever the stored artefacts still hold about the Autter row, so the
// original posting terms can be read rather than reconstructed from memory.
import fs from "node:fs";

const files = ["output/triage-90.json", "output/local-filter-pass.json", "output/evaluated-rows.json"];
const SKIP = new Set(["id", "score", "letter_grade", "status", "processed_at", "run_id",
  "eval_engine", "eval_tokens", "eval_duration_ms", "_send_paused", "_send_pause_available"]);

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
  const rows = Array.isArray(data) ? data : (data.jobs ?? Object.values(data));
  if (!Array.isArray(rows)) continue;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (!JSON.stringify(row).toLowerCase().includes("utter")) continue;
    console.log(`=== ${file} ===`);
    for (const [key, value] of Object.entries(row)) {
      if (SKIP.has(key)) continue;
      const text = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (!text || text === "{}" || text === "[]") continue;
      console.log(`\n--- ${key} ---`);
      console.log(text.slice(0, 2200));
    }
    process.exit(0);
  }
}
console.log("no Autter record in the stored artefacts");
