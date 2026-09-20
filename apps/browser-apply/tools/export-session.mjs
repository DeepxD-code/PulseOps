// Dumps current .edge-profile cookies to portal/storageState.json (headed once, then headless works).
import { chromium } from "playwright";
import fs from "node:fs";

const ctx = await chromium.launchPersistentContext("E:/Potential-gold/PluseOPS/.edge-profile", {
  channel: "msedge",
  headless: false,
  viewport: { width: 1366, height: 900 },
});
await new Promise((r) => setTimeout(r, 3000));
const cookies = await ctx.cookies();
console.log(`found ${cookies.length} cookies`);
console.log("li_at:", cookies.some((c) => c.name === "li_at"));
if (cookies.length === 0) {
  console.log("REFUSING to overwrite session with empty cookie jar");
} else {
  await ctx.storageState({ path: "E:/Potential-gold/PluseOPS/portal/storageState.json" });
  console.log("saved");
}
await ctx.close();
