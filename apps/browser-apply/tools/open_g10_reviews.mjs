#!/usr/bin/env node
/**
 * Open the job pages that G10 parked for human review, in a real browser.
 *
 * G10 ("gate 10") is the recruiter-email gate. When it cannot find a verified
 * recruiter/company contact it writes an `outreach` row with a `review_*` status
 * and a `G10: ...` reason and, when a Discord review webhook is configured,
 * delivers a card. That card is a link to a job posting nobody has applied to
 * yet.
 *
 * This tool collects those parked listings and opens them in the operator's
 * default browser so they can be judged by eye. It is deliberately read-only:
 *
 *   - it opens a browser. It does not drive one, so it can never fill a field,
 *     accept a term, or click Submit.
 *   - it never invents a contact. It only reads URLs already in the database.
 *   - it de-duplicates by job link, and prefers the newest row per link so a
 *     re-run does not open the same page twice.
 *
 * A CAPTCHAs or a login wall on any of these pages is left for the human; the
 * tool does not attempt to solve or bypass one.
 *
 * Usage:
 *   node tools/open_g10_reviews.mjs --limit 25
 *   node tools/open_g10_reviews.mjs --limit 25 --dry-run
 *   node tools/open_g10_reviews.mjs --include-posted
 *
 * Exit codes: 0 = opened or nothing to open, 1 = bad usage/DB error,
 * 2 = the browser could not be launched (rows are still listed on stdout).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

// The statuses G10 uses to park a listing for a human. `needs_review` is the
// pending state; the rest are in-flight/terminal states that a human still has
// to look at. `sent`/`cooldown`/... are deliberately absent: those mean a
// message already went out, so the page has been dealt with.
const REVIEW_STATUSES = [
  "needs_review",
  "review_pending",
  "pending_review",
  "review_sending",
  "review_posted",
  "review_closed",
];

function parseArgs(argv) {
  const args = { limit: 25, dryRun: false, db: "", includePosted: false, minScore: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" || arg === "-n") args.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--db") args.db = String(argv[++i] ?? "");
    else if (arg === "--min-score") args.minScore = Number.parseInt(argv[++i] ?? "") || 0;
    else if (arg === "--dry-run" || arg === "--dry") args.dryRun = true;
    else if (arg === "--include-posted") args.includePosted = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 25;
  if (args.limit > 200) args.limit = 200;
  return args;
}

function resolveDb(explicit) {
  const candidates = [
    explicit,
    process.env.PULSEOPS_DB_PATH,
    path.join(ROOT, "pulseops.db"),
    path.join(ROOT, "data", "pulseops.db"),
    path.join(ROOT, "output", "pulseops.db"),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || candidates.find(Boolean);
}

function loadRows(dbPath, args) {
  const statuses = args.includePosted
    ? REVIEW_STATUSES
    : REVIEW_STATUSES.filter((s) => s !== "review_posted");
  const placeholders = statuses.map(() => "?").join(",");
  const pythonCode = `
import json, sqlite3, sys
db_path, limit, min_score = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
statuses = ${JSON.stringify(statuses)}
conn = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\\\", "/"), uri=True)
conn.row_factory = sqlite3.Row
placeholders = ",".join("?" * len(statuses))
sql = f"""
SELECT o.id AS outreach_id, o.job_id, o.company, o.status AS review_status,
       o.notes AS review_reason, o.sent_at, o.channel,
       j.title, j.link, j.source, j.score
  FROM outreach o
  LEFT JOIN jobs j ON j.id = o.job_id
 WHERE LOWER(COALESCE(o.status,'')) IN ({placeholders})
   AND COALESCE(j.score, 0) >= ?
   AND COALESCE(j.link,'') LIKE 'https://%'
 ORDER BY COALESCE(j.score, 0) DESC, o.id DESC
"""
rows = [dict(r) for r in conn.execute(sql, (*statuses, min_score)).fetchall()]
# One page per job link: keep the newest outreach row for each listing so a
# re-run does not reopen the same posting under several review rows.
best = {}
for r in rows:
    key = (r.get("link") or "").strip().rstrip("/")
    if not key:
        continue
    prev = best.get(key)
    if prev is None or int(r.get("outreach_id") or 0) > int(prev.get("outreach_id") or 0):
        best[key] = r
out = sorted(best.values(), key=lambda r: (-(float(r.get("score") or 0)), -(int(r.get("outreach_id") or 0))))[:max(1, limit)]
print(json.dumps(out))
`;
  const out = execFileSync("python", ["-c", pythonCode, dbPath, String(args.limit), String(args.minScore)], {
    encoding: "utf-8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const line = out.trim().split(/\r?\n/).pop();
  const rows = line ? JSON.parse(line) : [];
  return Array.isArray(rows) ? rows : [];
}

function openInBrowser(urls) {
  if (!urls.length) return true;
  const [command, ...prefix] = process.platform === "win32"
    ? ["cmd", "/c", "start", ""]
    : process.platform === "darwin"
      ? ["open"]
      : ["xdg-open"];
  for (const url of urls) {
    try {
      // Windows `start` treats the first quoted argument as the window title,
      // hence the empty "" in the prefix above.
      execFileSync(command, [...prefix, url], { stdio: "ignore", timeout: 20000, windowsHide: true });
    } catch {
      return false;
    }
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8").split("*/")[0].replace(/^\/\*\*?/, ""));
    return 0;
  }

  const dbPath = resolveDb(args.db);
  if (!dbPath) {
    console.error("[g10-open] no pulseops.db found; pass --db <path>");
    return 1;
  }

  let rows;
  try {
    rows = loadRows(dbPath, args);
  } catch (e) {
    console.error(`[g10-open] could not read ${dbPath}: ${String(e?.message ?? e).slice(0, 200)}`);
    return 1;
  }

  if (!rows.length) {
    console.log(`[g10-open] no G10 review pages pending in ${path.basename(dbPath)}`);
    return 0;
  }

  console.log(`[g10-open] ${rows.length} G10 listing(s) parked for review (db=${path.basename(dbPath)})`);
  for (const row of rows) {
    const score = row.score == null ? "?" : Number(row.score).toFixed(0);
    const reason = String(row.review_reason || "").replace(/\s+/g, " ").slice(0, 96);
    console.log(`  #${String(row.job_id ?? "?").padEnd(5)} ${String(row.score ?? "?").padStart(3)} `
      + `${String(row.company || "").slice(0, 20).padEnd(22)} ${String(row.title || "").slice(0, 46)}`);
    console.log(`        ${row.link}`);
    console.log(`        reason: ${reason}`);
  }

  if (args.dryRun) {
    console.log("[g10-open] --dry-run: nothing opened");
    return 0;
  }

  const opened = openInBrowser(rows.map((r) => r.link));
  if (!opened) {
    console.error("[g10-open] the browser refused at least one URL; open the links above manually");
    return 2;
  }
  console.log(`[g10-open] opened ${rows.length} page(s) in your default browser`);
  return 0;
}

process.exit(main());