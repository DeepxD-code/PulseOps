// Read {queue_id, title, description} rows on stdin, answer with the apply
// gate's own verdict on each.
//
// This exists so maintenance tools cannot drift from the gate. The Python
// package has an `is_strict_target_role`, but it is deliberately NARROW: it only
// tells the scan whether it can skip the Stage 2 model on a title that names a
// stack ("Java Developer"). Using it as the apply gate rejected "Software
// Engineer", "Software Engineering Intern (2027)" and "Software Engineer - New
// Grad" - the roles the queue exists for.
//
// Usage: echo '[{"id":1,"title":"Backend Engineer"}]' | node tools/gate-check.mjs
import { isStrictTargetRole } from "../apply.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "[]");

const out = input.map((row) => ({
  ...row,
  inScope: isStrictTargetRole(row.title, row.description || ""),
}));
process.stdout.write(JSON.stringify(out));
