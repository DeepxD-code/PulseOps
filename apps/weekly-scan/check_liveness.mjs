#!/usr/bin/env node
/**
 * portal/check_liveness.mjs — Validates every URL in portals.yml still
 * resolves before the weekly scan trusts it (PulseOps Phase 11).
 *
 * Lightweight by design: a plain HTTP HEAD/GET via fetch(), not a full
 * Playwright page load — this is meant to run in a few seconds as a
 * maintenance check, either standalone or as a pre-flight gate inside
 * main_weekly.py (a portal that's dead gets skipped from the scan and
 * reported, rather than silently producing zero results that look like
 * "no jobs posted this week").
 *
 * Usage:
 *   node portal/check_liveness.mjs            human-readable report
 *   node portal/check_liveness.mjs --json      machine-readable (for main_weekly.py)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = path.join(__dirname, "portals.yml");
const JSON_MODE = process.argv.includes("--json");
const TIMEOUT_MS = 10000;

// A single failed probe used to mark a portal dead for the whole run, and
// main_weekly.py then skips it via --skip-portal. That made one network blip
// permanently cost a board: Anthropic returned 200 in under a second when
// probed directly, yet was skipped as unreachable in a real run.
//
// The asymmetry is brutal. Falsely skipping a live board costs every job on it
// (Anthropic alone was 6 of 8 verified submissions). Falsely keeping a dead one
// costs one wasted navigation. So only a DEFINITIVE answer may skip a portal.
const PROBE_ATTEMPTS = Number(process.env.PULSEOPS_LIVENESS_ATTEMPTS || 3);
const PROBE_BACKOFF_MS = Number(process.env.PULSEOPS_LIVENESS_BACKOFF_MS || 1500);

// 404/410 are a real, stable answer: the board moved or the slug is wrong.
// Timeouts, connection resets, 429s, 5xx and 403s are the server's mood, not
// evidence of absence, and are retried before being believed.
const DEFINITELY_GONE = new Set([404, 410]);

function loadPortals() {
  const raw = fs.readFileSync(PORTALS_PATH, "utf-8");
  const config = yaml.load(raw);
  return [...(config.search_portals || []), ...(config.ats_portals || [])];
}

async function probeOnce(portal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(portal.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    return {
      ok: resp.ok || (resp.status >= 200 && resp.status < 400),
      status: resp.status,
      ms: Date.now() - started,
      error: null,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: e.name === "AbortError" ? "timeout" : e.message,
    };
  }
}

async function checkOne(portal) {
  let last = { ok: false, status: null, ms: 0, error: "not attempted" };
  let attempts = 0;

  for (let i = 1; i <= PROBE_ATTEMPTS; i += 1) {
    attempts = i;
    last = await probeOnce(portal);
    if (last.ok) return { name: portal.name, url: portal.url, enabled: !!portal.enabled, requires_auth: !!portal.requires_auth, ok: true, status: last.status, ms: last.ms, error: null, attempts };
    // A definitive "gone" needs no further attempts.
    if (last.status !== null && DEFINITELY_GONE.has(last.status)) break;
    if (i < PROBE_ATTEMPTS) {
      const wait = PROBE_BACKOFF_MS * i;
      console.error(`  [retry] ${portal.name}: attempt ${i} failed (${last.status ?? last.error}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return {
    name: portal.name,
    url: portal.url,
    enabled: !!portal.enabled,
    requires_auth: !!portal.requires_auth,
    ok: false,
    status: last.status,
    ms: last.ms,
    error: last.error,
    attempts,
    // Distinguishes "this board moved" from "the network was unhappy", so a
    // portally dead list can be triaged instead of re-derived every run.
    dead_confidently: last.status !== null && DEFINITELY_GONE.has(last.status),
  };
}

async function main() {
  const portals = loadPortals();
  const results = [];
  for (const portal of portals) {
    const r = await checkOne(portal);
    results.push(r);
    if (!JSON_MODE) {
      const flag = r.ok ? "OK " : "DOWN";
      const note = r.requires_auth ? " (auth-required — liveness check ignores login wall)" : "";
      console.log(
        `[${flag}] ${r.name.padEnd(28)} ${String(r.status ?? "—").padEnd(5)} ${r.ms}ms${note}` +
        (r.error ? `  — ${r.error}` : "")
      );
    }
  }

  const dead = results.filter((r) => !r.ok && r.enabled && !r.requires_auth);

  if (JSON_MODE) {
    console.log(JSON.stringify({ results, dead_count: dead.length }, null, 2));
  } else {
    console.log("");
    if (dead.length) {
      console.log(`[!] ${dead.length} portal(s) appear DOWN and are enabled — fix the URL in portals.yml or disable them:`);
      dead.forEach((d) => console.log(`    - ${d.name}: ${d.url}`));
    } else {
      console.log("[OK] All enabled, non-auth portals are reachable.");
    }
  }

  // A completed check is a successful tool run even when some portals are
  // unreachable.  The caller consumes the JSON report to decide which portals
  // to skip; dead portals are data, not a liveness-tool failure.
  process.exitCode = 0;
}

main().catch((e) => {
  console.error("[Fatal] liveness check crashed:", e);
  process.exitCode = 1;
});
