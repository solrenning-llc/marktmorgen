import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const source = readFileSync(join(root, "components/email-studio.tsx"), "utf8");

// This dependency-free mode is the durable RED. It records the three missing
// focus transitions before the occupied product file can be changed. The
// default mode below exercises the same contracts with real keyboard events,
// the real rendered page, and axe-core after the owning PR has cleared.
if (process.argv.includes("--source-red")) {
  const checks = [
    ["opening a saved email moves focus to its subject", /switchTo[\s\S]{0,1800}mail-subject[\s\S]{0,300}\.focus\(/],
    ["opening a sequence moves focus to its name", /flow-name[\s\S]{0,1800}\.focus\(/],
    ["closing a sequence returns focus to its opener", /flow-(?:new|edit)-[\s\S]{0,2200}\.focus\(/],
  ];
  let failed = 0;
  for (const [name, contract] of checks) {
    const ok = contract.test(source);
    console.log(`${ok ? "ok" : "not ok"} - ${name}`);
    if (!ok) failed += 1;
  }
  console.log(`EMAIL_STUDIO_ACCESSIBILITY_SOURCE_RED:${JSON.stringify({ checks: checks.length, failed })}`);
  process.exitCode = failed ? 1 : 0;
} else {
  const { build } = await import("esbuild");
  const require = createRequire(join(root, "package.json"));
  const driver = require("playwright-core").chromium;
  const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const { startServices } = await import("./services.mjs");
  const here = join(root, "tests/e2e");
  const port = 3197;
  const origin = `http://localhost:${port}`;
  const fake = "http://127.0.0.1:4497";
  const env = {
    ...process.env,
    DEMO_STUDIO_ADMIN: "operator@example.test",
    STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
    UPSTASH_REDIS_REST_URL: fake,
    UPSTASH_REDIS_REST_TOKEN: "local",
    RESEND_API_KEY: "re_local_only_a_stand_in",
    RESEND_API_BASE: fake,
    ANTHROPIC_API_KEY: `sk-ant-local_only_${"x".repeat(30)}`,
    ANTHROPIC_API_BASE: fake,
    STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
    STRIPE_CONNECT_API_BASE: fake,
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
    E2E_FONT_ORIGIN: fake,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  const services = await startServices(4497);
  const folder = mkdtempSync(join(tmpdir(), "mm-email-accessibility-"));
  const seedFile = join(folder, "seed.cjs");
  let fixture;
  try {
    await build({ entryPoints: [join(here, "store-copy-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
    const seeded = await new Promise((resolveSeed, rejectSeed) => {
      const child = spawn(process.execPath, [seedFile], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let data = "";
      child.stdout.on("data", chunk => { data += chunk; });
      child.stderr.on("data", chunk => { data += chunk; });
      child.on("error", rejectSeed);
      child.on("close", code => code === 0 ? resolveSeed(data) : rejectSeed(Error("Synthetic seed failed")));
    });
    fixture = JSON.parse(seeded.trim().split("\n").at(-1)).homeDemo;
    assert.ok(fixture?.session && fixture?.sid, "complete synthetic email fixture");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  const app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [app.stdout, app.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-6000); });
  let browser;
  try {
    let up = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (app.exitCode !== null) throw Error(output);
      try { up = (await fetch(origin)).ok; } catch {}
      if (up) break;
      await new Promise(wait => setTimeout(wait, 500));
    }
    if (!up) throw Error(`Local app unavailable ${output}`);

    browser = await driver.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
    await context.addCookies([{ name: "nl_session", value: fixture.session, url: origin }]);
    const page = await context.newPage();
    const foreign = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== origin && url.origin !== fake) foreign.push(url.origin);
    });
    const response = await page.goto(`${origin}/studio/email?store=${fixture.sid}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(response.status(), 200);

    const audit = async (target, label) => {
      await page.addScriptTag({ content: axe });
      const violations = await target.evaluate(async node => {
        const report = await window.axe.run(node, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] } });
        return report.violations.map(rule => ({ id: rule.id, targets: rule.nodes.map(item => item.target) }));
      });
      assert.deepEqual(violations, [], `${label} axe WCAG 2.2 AA`);
    };
    const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.id || document.activeElement?.textContent?.trim() || "");
    const visiblyFocused = locator => locator.evaluate(node => node === document.activeElement && node.matches(":focus-visible") && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);

    await audit(page.locator("main"), "email studio initial state");

    const subject = page.getByLabel("Subject", { exact: true }).first();
    const body = page.getByLabel("Email", { exact: true }).first();
    await subject.fill("Keyboard draft");
    await body.fill("A synthetic email used only by this local accessibility proof.");
    await page.getByRole("button", { name: "Save as a draft", exact: true }).click();
    const openDraft = page.getByRole("button", { name: "Open", exact: true }).first();
    await openDraft.waitFor();
    await openDraft.focus();
    await page.keyboard.press("Enter");
    assert.equal(await activeLabel(), "mail-subject", "opening a saved email focuses its subject");
    assert.equal(await visiblyFocused(subject), true, "saved email focus is visible");

    const newSequence = page.getByRole("button", { name: "New sequence", exact: true });
    await newSequence.focus();
    await page.keyboard.press("Enter");
    const sequence = page.locator("form", { has: page.getByRole("button", { name: "Save the sequence", exact: true }) });
    const name = sequence.getByLabel("Name, for you", { exact: true });
    assert.equal(await name.evaluate(node => node === document.activeElement), true, "opening a sequence focuses its first field");
    assert.equal(await visiblyFocused(name), true, "sequence focus is visible");
    await audit(sequence, "open sequence editor");

    await name.fill("Keyboard-only sequence");
    await page.keyboard.press("Tab");
    assert.equal(await sequence.getByLabel("Starts when", { exact: true }).evaluate(node => node === document.activeElement), true, "Tab follows the editor order");

    const close = sequence.getByRole("button", { name: "Close", exact: true });
    await close.focus();
    await page.keyboard.press("Enter");
    assert.equal(await newSequence.evaluate(node => node === document.activeElement), true, "closing returns focus to the opener");
    assert.deepEqual([...new Set(foreign)], [], "no foreign provider request");
    console.log("EMAIL_STUDIO_ACCESSIBILITY_GREEN:" + JSON.stringify({ axeStates: 2, keyboardTransitions: 4, viewport: 390, providerRequests: 0 }));
    await context.close();
  } finally {
    if (browser) await browser.close();
    app.kill("SIGTERM");
    await services.close();
  }
}
