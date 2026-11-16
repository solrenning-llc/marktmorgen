/**
 * The product page's buy bar on a phone (components/sticky-buy.tsx) never
 * covers what has keyboard focus: WCAG 2.2 2.4.11 (AA) and 2.4.12 (AAA),
 * 274 [AX1]. Real Tab presses in Chromium, on the synthetic stores of
 * tests/e2e/store-front-seed.ts, the real app (`next start`) against the
 * stand-ins of tests/e2e/services.mjs. Not part of `npm test` or CI.
 *
 *   node tests/e2e/sticky-buy-focus.mjs              builds the app, then checks
 *   node tests/e2e/sticky-buy-focus.mjs --no-build   uses the build already in .next
 *
 * For every product of the full store, at 320, 390 and 600 px wide and 700 px
 * tall, it presses Tab from the top of the page to its end. At each stop it
 * reads the focused element's box and the bar's box: while the bar is shown
 * (not slid away), a focused element outside the bar must end above the bar's
 * top edge. A focused element inside the bar while it is away must not exist.
 *
 * First run (11 November 2026, main at 2f967c03): 27 of 282 stops covered,
 * among them "Everything from Quiet Oven" hidden whole under the bar at every
 * width. With a scroll padding only while the bar was shown, 13 stayed covered:
 * a card focused while the bar was away scrolled the buy box off screen and the
 * bar came back over it. With the padding held whenever the bar is on the page
 * (app/globals.css), 0 of 282.
 * Exits 1 when any stop is covered, 0 when none is. One engine, no screen
 * reader, no real phone, no people: passing it is not conformance.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "./services.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "package.json"));
const nextCli = join(root, "node_modules/next/dist/bin/next");
const SERVICES = Number(process.env.E2E_SERVICES_PORT || 5293);
const APP = Number(process.env.E2E_APP_PORT || 3993);
const LOCAL = `http://localhost:${APP}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  STRIPE_SECRET_KEY: "sk_test_local_only_a_stand_in_0000",
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_" + "x".repeat(30),
  ANTHROPIC_API_BASE: FAKE,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
  STRIPE_CONNECT_API_BASE: FAKE,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};

let chromium;
for (const name of ["playwright", "playwright-core", process.env.PLAYWRIGHT_CORE].filter(Boolean)) {
  try {
    chromium = require(name).chromium;
    break;
  } catch {}
}
if (!chromium) {
  console.error("This needs Playwright or playwright-core on the machine. Nothing was run.");
  process.exit(2);
}

const run = (cmd, args) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("close", (status) => done({ status, said }));
  });

/** The focused element and the bar, as boxes in the viewport. */
function readStop() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const bar = document.querySelector(".st-sticky-buy");
  const b = el.getBoundingClientRect();
  const r = bar?.getBoundingClientRect();
  const shown = Boolean(bar && getComputedStyle(bar).display !== "none" && !bar.hasAttribute("data-away") && r.top < innerHeight);
  const inBar = Boolean(bar?.contains(el));
  return {
    text: (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 50),
    top: Math.round(b.top),
    bottom: Math.round(b.bottom),
    barTop: shown ? Math.round(r.top) : null,
    covered: shown && !inBar && b.bottom > r.top + 1 && b.top < innerHeight,
    hiddenInBar: inBar && Boolean(bar.hasAttribute("data-away")),
  };
}

const services = await startServices(SERVICES);
let app = null, browser = null, appLog = "", covered = 0, stops = 0;
try {
  const folder = mkdtempSync(join(tmpdir(), "mm-sticky-seed-"));
  const seedFile = join(folder, "seed.cjs");
  await build({ entryPoints: [join(here, "store-front-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  const seeded = await run(process.execPath, [seedFile]);
  rmSync(folder, { recursive: true, force: true });
  if (seeded.status !== 0) throw new Error(`the stores could not be made:\n${seeded.said}`);
  const { ids } = JSON.parse(seeded.said.trim().split("\n").at(-1));
  if (!process.argv.includes("--no-build")) {
    const built = await run(process.execPath, [nextCli, "build"]);
    if (built.status !== 0) throw new Error(`the app did not build:\n${built.said.slice(-3000)}`);
  }
  app = spawn(process.execPath, [nextCli, "start", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => (appLog = (appLog + chunk).slice(-8000)));
  const started = Date.now();
  while (!(await fetch(`${LOCAL}/@a11yfront`).then((r) => r.status === 200).catch(() => false))) {
    if (Date.now() - started > 120_000) throw new Error(`the app did not start:\n${appLog.slice(-2000)}`);
    await new Promise((wait) => setTimeout(wait, 1000));
  }
  browser = process.env.CHROMIUM ? await chromium.launch({ executablePath: process.env.CHROMIUM }) : await chromium.launch();
  console.log(`Chromium ${browser.version()}`);
  for (const [name, id] of Object.entries(ids)) {
    for (const width of [320, 390, 600]) {
      const context = await browser.newContext({ viewport: { width, height: 700 }, serviceWorkers: "block" });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== LOCAL && url.origin !== FAKE) return route.abort();
        if (!["GET", "HEAD"].includes(route.request().method())) return route.fulfill({ status: 204, body: "" });
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(`${LOCAL}/@a11yfront/p/${id}`, { waitUntil: "networkidle", timeout: 60000 });
      if (response.status() !== 200) throw new Error(`${name}: HTTP ${response.status()}`);
      const bar = await page.locator(".st-sticky-buy").count();
      let here = 0, bad = 0;
      for (let n = 0; n < 120; n++) {
        await page.keyboard.press("Tab");
        // The bar slides away on an IntersectionObserver callback; let it settle as a reader's pause would.
        await page.waitForTimeout(150);
        const stop = await page.evaluate(readStop);
        if (!stop) break;
        here++;
        if (stop.covered || stop.hiddenInBar) {
          bad++;
          console.log(`  COVERED ${name} ${width}px: ${JSON.stringify(stop)}`);
        }
      }
      stops += here;
      covered += bad;
      console.log(`CASE ${name} ${width}px bar=${bar} stops=${here} ${bad ? "covered=" + bad : "ok"}`);
      await context.close();
    }
  }
  console.log(`\n${stops} focus stops, ${covered} covered by the buy bar.`);
} catch (error) {
  console.error(error);
  covered = Math.max(covered, 1);
} finally {
  await browser?.close();
  app?.kill("SIGTERM");
  await services.close();
}
process.exit(covered ? 1 : 0);
