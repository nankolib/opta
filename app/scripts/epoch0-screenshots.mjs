// =============================================================================
// epoch0-screenshots.mjs — campaign UI shot set for design review (brief §12)
// =============================================================================
//
// Produces BOTH modes x (desktop, mobile) for every campaign surface, every
// board tab, the empty and unavailable states, and the flag-OFF proof.
// Reproducible for every future design review.
//
// SETUP
//   mkdir -p ~/pw && cd ~/pw && npm install playwright-core
//   npx playwright install chromium && sudo npx playwright install-deps chromium
//
// RUN (flag ON, pointed at the VPS loopback API through an SSH tunnel)
//   ssh -N -L 8791:127.0.0.1:8791 <VPS_USER>@<VPS_IP> &
//   cd app && VITE_EPOCH0_UI=1 \
//     VITE_POINTS_API_BASE=http://127.0.0.1:8791/api/points npx vite --port 5199
//   PW_CORE=~/pw/node_modules/playwright-core/index.mjs \
//     node app/scripts/epoch0-screenshots.mjs --base http://127.0.0.1:5199
//
// The UNAVAILABLE and FLAG-OFF sets need their own dev servers (different env),
// so pass --set live|down|off and run the matching server. --set all assumes the
// live one and skips the other two.
//
// Mode is stamped as data-mode on <html>, exactly how useSurfaceMode drives the
// token set — no localStorage assumption (brief §10).
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// playwright-core is resolved dynamically: npm cannot write into this repo on
// the Windows mount (EACCES on /mnt/d), so the browser driver is installed
// outside the tree. Override with PW_CORE when it lives elsewhere.
const PW_CORE = process.env.PW_CORE ?? "playwright-core";
const { chromium } = await import(PW_CORE);

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../.screenshots/epoch0");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg("--base", "http://127.0.0.1:5199");
const SET = arg("--set", "live"); // live | down | off

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const MODES = ["dark", "light"];
const BOARDS = ["Profit", "Volume", "Writer", "Referrals", "Social"];

let shotCount = 0;
async function shoot(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  shotCount += 1;
  console.log("  ->", path.basename(file));
}

/** Stamp the surface mode the way useSurfaceMode does. */
async function setMode(page, mode) {
  await page.evaluate((m) => document.documentElement.setAttribute("data-mode", m), mode);
  await page.waitForTimeout(250);
}

async function main() {
  if (SET === "live") fs.rmSync(outDir, { recursive: true, force: true });
  const browser = await chromium.launch();
  const prefix = SET === "live" ? "" : `${SET}-`;

  try {
    for (const vp of VIEWPORTS) {
      for (const mode of MODES) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        const tag = `${mode}-${vp.name}`;

        // ---- /leaderboard, one shot per board tab -------------------------
        await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" }).catch(() => {});
        await setMode(page, mode);

        if (SET === "off") {
          // Flag OFF: the route is never registered, so there is nothing to tab.
          await shoot(page, path.join(outDir, `${prefix}leaderboard-${tag}.png`));
        } else {
          for (const board of BOARDS) {
            const tab = page.locator("button", { hasText: new RegExp(`^${board}$`) }).first();
            if (await tab.count()) {
              await tab.click();
              // Wait for the fetch to SETTLE. 500ms caught the skeleton state and
              // hid the empty states the review needs to see.
              await page.waitForLoadState("networkidle").catch(() => {});
              await page.waitForTimeout(1200);
            }
            await shoot(page, path.join(outDir, `${prefix}leaderboard-${board.toLowerCase()}-${tag}.png`));
          }
        }

        // ---- /portfolio (quest panel lives here) --------------------------
        await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" }).catch(() => {});
        await setMode(page, mode);
        await page.waitForTimeout(400);
        await shoot(page, path.join(outDir, `${prefix}portfolio-${tag}.png`));

        await ctx.close();
      }
    }

    // ---- FLAG-OFF PROBE (DOM, not a bundle grep) --------------------------
    // Vite inlines the flag, so the string "/leaderboard" survives in the
    // bundle while being unreachable. Only the rendered DOM settles it.
    if (SET === "off") {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" }).catch(() => {});
      const heading = await page.locator("h1", { hasText: "Leaderboard" }).count();
      await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" }).catch(() => {});
      const chip = await page.locator('a[href="/leaderboard"]').count();
      const panel = await page.locator("text=Campaign").count();
      console.log(`\nFLAG-OFF PROBE  leaderboardHeading=${heading}  navChip=${chip}  questPanel=${panel}`);
      console.log(heading === 0 && chip === 0 && panel === 0 ? "PASS — campaign surfaces absent" : "FAIL — something rendered");
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${shotCount} shots -> ${outDir}`);
}

main().catch((e) => {
  console.error("screenshot run failed:", e.message);
  process.exit(1);
});
