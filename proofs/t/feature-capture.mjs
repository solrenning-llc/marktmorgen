/** Real Next interface pixels, loopback services and fictional canonical demo content only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServices } from "../../tests/e2e/services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const temporary = mkdtempSync(join(root, ".git-feature-capture-"));
const origin = "http://127.0.0.1:3216", fake = "http://127.0.0.1:4516";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const captureDirectory = process.env.T_CAPTURE_DIRECTORY ? resolve(process.env.T_CAPTURE_DIRECTORY) : temporary;
mkdirSync(captureDirectory, { recursive: true });
// No inherited account credentials. Font/service substitutes are explicitly local.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
  DEMO_STUDIO_ADMIN: "operator@example.test", STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: fake, UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in", RESEND_API_BASE: fake,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in", STRIPE_CONNECT_API_BASE: fake,
  ANTHROPIC_API_KEY: "sk-ant-local_only_" + "x".repeat(30), ANTHROPIC_API_BASE: fake,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(root, "tests/e2e/google-fonts-mock.cjs"), E2E_FONT_ORIGIN: fake,
};
const guard = join(temporary, "local-fetch.mjs");
writeFileSync(guard, `const original=globalThis.fetch;globalThis.fetch=(input,...args)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Nonlocal capture fetch refused: '+u.origin);return original(input,...args);};`);
env.NODE_OPTIONS = "--import=" + guard;
const services = await startServices(4516);
let app, browser, appOutput = "";
const run = (args) => new Promise((accept, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  child.once("error", reject);
  child.once("exit", code => code === 0 ? accept(output) : reject(Error(output.slice(-4000))));
});
try {
  const seed = join(temporary, "seed.cjs");
  await build({ entryPoints: [join(root, "tests/e2e/store-copy-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seed, logLevel: "error", alias: { "@": root } });
  const fixture = JSON.parse((await run([seed])).trim().split("\n").at(-1)).homeDemo;
  assert.ok(fixture?.session && fixture?.sid && fixture?.product);
  console.log("CAPTURE_STAGE local fictional fixture seeded");
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "-p", "3216"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", chunk => { appOutput = (appOutput + chunk).slice(-6000); process.stderr.write(chunk); });
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (app.exitCode !== null) throw Error(appOutput);
    try { ready = (await fetch(origin + "/robots.txt", { signal: AbortSignal.timeout(2000) })).ok; } catch { /* Wait for local listening only. */ }
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 500));
  }
  assert.ok(ready, "local Next server is ready: " + appOutput);
  browser = await require("playwright-core").chromium.launch({ headless: true });
  const captures = [];
  for (const spec of [
    { slug: "store-page", context: "Demo store", sourcePath: "/@harborkitchenpreview", alt: "The actual Marktmorgen demo store with the fictional Harbor Kitchen products." },
    { slug: "sales-pages", context: "Synthetic studio", sourcePath: "/studio/pages?store=" + fixture.sid + "&product=" + fixture.product, alt: "The actual Marktmorgen sales page editor for the fictional Weekly Meal Planner." },
  ]) {
    // Capture server-rendered real pixels without starting automatic client analytics.
    // The hydrated store attempted POST /api/store/hit (blocked by the guard).
    // Keep the zero-mutation assertion; this is explicitly not a hydration proof.
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", javaScriptEnabled: false });
    let refusedExternal = 0, refusedWrites = 0;
    const refusedWriteRequests = [];
    try {
      if (spec.context === "Synthetic studio") await context.addCookies([{ name: "nl_session", value: fixture.session, url: origin }]);
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { refusedExternal++; return route.abort(); }
        if (!["GET", "HEAD"].includes(request.method())) { refusedWrites++; refusedWriteRequests.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(origin + spec.sourcePath, { waitUntil: "networkidle", timeout: 120000 });
      assert.equal(response.status(), 200);
      assert.ok(!new URL(page.url()).pathname.startsWith("/signin"), "actual authenticated fixture, not sign-in");
      await page.locator("main h1").waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      const visible = await page.locator("body").innerText();
      assert.match(visible, /Harbor Kitchen|Weekly Meal Planner/);
      assert.doesNotMatch(visible, /home-demo@example\.test|operator@example\.test/);
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 820 } });
      const pixels = await require("sharp")(png).webp({ quality: 78 }).toBuffer();
      assert.ok(pixels.length <= 100_000, "publish ceiling checked before static payload creation");
      const metadata = await require("sharp")(pixels).metadata();
      assert.deepEqual([metadata.width, metadata.height], [1280, 820]);
      const capturedAt = new Date().toISOString();
      const sha256 = createHash("sha256").update(pixels).digest("hex");
      writeFileSync(join(captureDirectory, spec.slug + ".webp"), pixels);
      captures.push({ ...spec, sourceCommit, capturedAt, width: 1280, height: 820, sha256, src: "data:image/webp;base64," + pixels.toString("base64") });
      console.log(JSON.stringify({ slug: spec.slug, sourceCommit, capturedAt, bytes: pixels.length, sha256, refusedExternal, refusedWrites, refusedWriteRequests, browser: browser.version(), scope: "actual Next development SSR; JavaScript disabled to prevent analytics; local synthetic services and substitute font; no hydration/provider/account/payment" }));
      assert.equal(refusedWrites, 0, "capture makes no browser mutation");
    } finally { await context.close(); }
  }
  assert.equal(services.checkouts().length, 0);
  assert.equal(services.emails().length, 0);
  assert.equal(services.writing().length, 0);
  assert.equal(services.subscriptionUpdates().length, 0);
  writeFileSync(join(captureDirectory, "feature-captures.ts"), "/** Actual application pixels; isolated fictional fixtures, dated per capture. */\nexport const FEATURE_CAPTURES = " + JSON.stringify(captures, null, 2) + " as const;\n");
  console.log("CAPTURES_COMPLETE " + captureDirectory);
} catch (error) {
  console.error(appOutput);
  throw error;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { const ended = new Promise(accept => app.once("exit", accept)); app.kill("SIGTERM"); await ended; }
  await services.close();
  rmSync(temporary, { recursive: true, force: true });
}
