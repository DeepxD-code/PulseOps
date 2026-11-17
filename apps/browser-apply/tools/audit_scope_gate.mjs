// What did the scope gate drop, and was it right?
//
// A run reported "[DB] 255 row(s) passed SQL -> 31 eligible; dropped by
// out-of-scope role: 224". A gate that drops 88% of the queue is either
// refusing a pile of sales roles or refusing the operator's own trade, and the
// difference is visible in the titles. This mirrors isEligibleJob's two-step
// call exactly: stored description first, then the provisional title-only pass
// for sources that never stored a body.
import { isEligibleJob, isStrictTargetRole } from "../apply.mjs";
import { execFileSync } from "node:child_process";

const python = "C:\\Users\\trex2\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
const query = `
import json, sqlite3
c = sqlite3.connect(r"E:\\Potential-gold\\PulseOps\\pulseops.db")
cols = {r[1] for r in c.execute("PRAGMA table_info(jobs)")}
want = ["id", "company", "title", "source", "score", "link", "status"]
want += [x for x in ("description", "job_description", "description_text") if x in cols]
rows = c.execute("select %s from jobs where status='Evaluated'" % ",".join(want)).fetchall()
print(json.dumps({"cols": want, "rows": rows}))
`;
const raw = execFileSync(python, ["-c", query], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
const { cols, rows } = JSON.parse(raw);

const kept = [];
const dropped = [];
for (const values of rows) {
  const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
  const job = { ...row, status: "Evaluated" };
  (isEligibleJob(job, { explicit: true }) ? kept : dropped).push(row);
}

console.log(`evaluated ${rows.length}: eligible ${kept.length}, dropped ${dropped.length}`);

console.log("\n30 dropped, score desc:");
for (const r of dropped.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 30)) {
  const why = isStrictTargetRole(r.title, "")
    ? "generic-title, no stored body"
    : "title is out of scope";
  console.log(`  ${String(r.score).padStart(3)}  #${String(r.id).padEnd(5)} ${String(r.source).slice(0, 9).padEnd(10)} ${String(r.title).slice(0, 58).padEnd(60)} ${why}`);
}

console.log("\neligible:");
for (const r of kept.sort((a, b) => (b.score || 0) - (a.score || 0))) {
  console.log(`  ${String(r.score).padStart(3)}  #${String(r.id).padEnd(5)} ${String(r.source).slice(0, 9).padEnd(10)} ${String(r.title).slice(0, 66)}`);
}
