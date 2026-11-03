/**
 * Obscura — stealth headless fetch engine (https://github.com/h4ckf0r0day/obscura).
 *
 * Why it is here
 * --------------
 * Several India job boards sit behind TLS-fingerprint gates (Akamai, Cloudflare)
 * and behind client-side rendering. Playwright ships Chromium, whose BoringSSL
 * handshake is fingerprinted and refused by some of those edges, while Obscura
 * presents a consistent browser fingerprint without launching Chromium at all.
 *
 * Measured on 2026-11-02 against the boards this scanner uses:
 *
 *   instahyre.com   Obscura renders 20 listings per page, headless, ~13s
 *                   (the same page under headless Chromium is an Angular shell
 *                   until hydration completes and occasionally times out)
 *   workatastartup  Obscura renders all 29 job cards
 *   hirist.tech     Obscura gets the app shell, the app's own XHR fails
 *   naukri.com      Obscura renders an error page even with a seeded cookie jar —
 *                   Naukri needs the real Edge session (see .edge-profile-naukri)
 *   indeed.com      Cloudflare challenge in both engines
 *
 * So Obscura is used where it measurably wins (rendered public listings) and it
 * is never used to sign in or to submit an application: form work stays on
 * Playwright with the persistent Edge profile.
 *
 * `--eval` is the important primitive. It runs an expression inside the
 * rendered page and prints the return value, so a portal's own selectors can be
 * evaluated in its own DOM and handed back as JSON — no HTML is parsed in Node.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_WINDOWS_BIN = "C:\\Users\\trex2\\AppData\\Local\\Programs\\obscura\\obscura.exe";

/**
 * Locate the Obscura executable.
 *
 * PULSEOPS_OBSCURA_BIN wins so a different build (or a Linux/macOS install) can
 * be pointed at without editing code; otherwise the Windows install path used
 * on this machine, otherwise `obscura` from PATH.
 */
export function obscuraBinary() {
  const override = process.env.PULSEOPS_OBSCURA_BIN;
  if (override && fs.existsSync(override)) return override;
  if (process.platform === "win32" && fs.existsSync(DEFAULT_WINDOWS_BIN)) return DEFAULT_WINDOWS_BIN;
  return "obscura";
}

let availabilityCache = null;

/** True when the binary answers `--version`. Cached per process. */
export async function obscuraAvailable() {
  if (availabilityCache !== null) return availabilityCache;
  try {
    await execFileAsync(obscuraBinary(), ["--version"], { timeout: 20000 });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

function storageDirFor(engine) {
  const dir = path.join(ROOT, ".obscura", String(engine || "default"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run `obscura fetch <url> --eval <expression>` and parse the JSON it prints.
 *
 * The expression must return a JSON string; anything else is reported as a
 * failure rather than guessed at, because a silent empty result here reads
 * downstream as "this board has no jobs".
 */
export async function obscuraEval(url, expression, options = {}) {
  const {
    engine = "default",
    wait = 6,
    timeout = 50,
    userAgent,
    stealth = true,
  } = options;

  const args = [];
  if (stealth) args.push("--stealth");
  args.push("fetch", url, "--eval", expression, "--wait", String(wait), "--timeout", String(timeout));
  args.push("--storage-dir", storageDirFor(engine));
  if (userAgent) args.push("--user-agent", userAgent);

  const { stdout } = await execFileAsync(obscuraBinary(), args, {
    timeout: (timeout + 30) * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const payload = lines[lines.length - 1] || "";
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`obscura: non-JSON eval result: ${payload.slice(0, 160)}`);
  }
}

/** Fetch a page and return it as markdown — used for job descriptions. */
export async function obscuraMarkdown(url, options = {}) {
  const { engine = "default", wait = 4, timeout = 45 } = options;
  const args = ["--stealth", "fetch", url, "--dump", "markdown", "--wait", String(wait), "--timeout", String(timeout), "--storage-dir", storageDirFor(engine)];
  const { stdout } = await execFileAsync(obscuraBinary(), args, {
    timeout: (timeout + 30) * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout || "").trim();
}
