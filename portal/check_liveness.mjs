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

function loadPortals() {
  const raw = fs.readFileSync(PORTALS_PATH, "utf-8");
  const config = yaml.load(raw);
  return [...(config.search_portals || []), ...(config.ats_portals || [])];
}

async function checkOne(portal) {
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
      name: portal.name,
      url: portal.url,
      enabled: !!portal.enabled,
      requires_auth: !!portal.requires_auth,
      ok: resp.ok || (resp.status >= 200 && resp.status < 400),
      status: resp.status,
      ms: Date.now() - started,
      error: null,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      name: portal.name,
      url: portal.url,
      enabled: !!portal.enabled,
      requires_auth: !!portal.requires_auth,
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: e.name === "AbortError" ? "timeout" : e.message,
    };
  }
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

  process.exit(dead.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[Fatal] liveness check crashed:", e);
  process.exit(1);
});
