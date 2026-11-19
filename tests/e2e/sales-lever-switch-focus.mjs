// The "Grow your sales" card's switch in a real browser (752 [CD3]; Codex X6's MEDIUM on #3563, AX274 2.4.3): when the
// button holding the focus goes away, the focus goes on to what replaced it, never to the page's body. A confirmed Undo
// hands it to the switch; a reply that did not confirm, to "Reload the page". And a refresh that draws another saved
// state than the card's own (another tab) is what the card shows (Codex X6's LOW on #3563). The real component
// (components/sales-lever-switch.tsx) with a stand-in for /api/store/recovery kept in the page
// (tests/e2e/sales-lever-switch-harness.tsx): no server, no build, nothing sent.
// Run by tests/sales-lever-switch-focus-browser.test.ts inside npm test (Chromium); by hand:
// node tests/e2e/sales-lever-switch-focus.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const driver = require("playwright-core")[engine];

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/sales-lever-switch-harness.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles[0].text;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sales lever switch check</title></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/switch.js"></script></body></html>`;

// Same installed-browser selection as tests/checkout-focus-browser.test.ts for Chromium; never download a browser.
async function launch() {
  if (engine !== "chromium") return driver.launch();
  const options = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROMIUM) return driver.launch({ ...options, executablePath: process.env.CHROMIUM });
  try { return await driver.launch(options); } catch (first) {
    try { return await driver.launch({ ...options, channel: "chrome" }); } catch { throw first; }
  }
}
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("http://switch.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/switch.js") return route.fulfill({ contentType: "text/javascript", body: script });
    return path === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
  });
  /** A fresh page holding the card for a store whose reminders are `on`. */
  const fresh = async (on) => {
    await page.goto("http://switch.test/");
    await page.evaluate((on) => window.harness.render(on), on);
    await page.getByRole("switch").waitFor();
  };
  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    return el.getAttribute("role") === "switch" ? "switch" : (el.textContent ?? "").trim();
  });
  const status = () => page.locator("[role=status]").textContent();
  const undo = page.getByRole("button", { name: /^Undo/ });

  // A confirmed Undo removes the Undo button that held the focus: the focus goes to the switch.
  await fresh(false);
  await page.getByRole("switch").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "Checkout recovery is on.");
  is("a saved switch offers Undo, and the switch says on", [await undo.count(), await page.getByRole("switch").getAttribute("aria-checked")], [1, "true"]);
  await undo.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "Checkout recovery is off.");
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.startsWith("Undo")));
  is("a confirmed Undo: its button is gone and the focus is on the switch, not the page's body (2.4.3)", [await undo.count(), await active(), await page.getByRole("switch").getAttribute("aria-checked")], [0, "switch", "false"]);
  is("both presses went to the route: on, then the exact reverse", await page.evaluate(() => window.harness.writes.map((w) => w.enabled)), [true, false]);

  // A reply that did not confirm removes the switch that held the focus: the focus goes to "Reload the page".
  await fresh(false);
  await page.evaluate(() => window.harness.next.push({ ok: true }));
  await page.getByRole("switch").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Reload the page" }).waitFor();
  is("an unconfirmed reply: the switch is gone, the card asks for a reload, and the focus is on Reload (2.4.3)", [await page.getByRole("switch").count(), await active(), await status()], [0, "Reload the page", "We could not confirm the change. Reload the page to see the saved setting before you try again."]);

  // A focus the person moved elsewhere is never taken back.
  await fresh(false);
  await page.evaluate(() => {
    const away = document.createElement("button");
    away.textContent = "Elsewhere";
    document.body.append(away);
  });
  await page.getByRole("switch").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "Checkout recovery is on.");
  await undo.focus();
  // The answer waits long enough that the focus is surely moved before it comes, on any machine.
  await page.evaluate(() => { window.harness.next.push({ ok: true }); window.harness.delay = 1500; });
  const sent = page.evaluate(() => new Promise((done) => { const before = window.harness.writes.length; const t = setInterval(() => { if (window.harness.writes.length > before) { clearInterval(t); done(); } }, 5); }));
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Elsewhere" }).focus();
  await sent;
  await page.getByRole("button", { name: "Reload the page" }).waitFor();
  is("the person moved the focus while it was saved: it stays where they put it", await active(), "Elsewhere");

  // Another tab turned reminders on while this card showed off with nothing pressed: the refresh's state is shown.
  await fresh(false);
  await page.evaluate(() => window.harness.render(true));
  is("a refresh with nothing pressed draws the saved state", await page.getByRole("switch").getAttribute("aria-checked"), "true");
  // After a saved press, a refresh with another saved state (another tab) wins over the card's own, and Undo goes,
  // since it would put back a setting that is no longer the one saved.
  await fresh(false);
  await page.getByRole("switch").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "Checkout recovery is on.");
  await page.evaluate(() => window.harness.render(true));
  is("a refresh that confirms the card's own save keeps the card's state and its Undo", [await page.getByRole("switch").getAttribute("aria-checked"), await undo.count()], ["true", 1]);
  await page.evaluate(() => window.harness.render(false));
  is("a refresh with another tab's saved state: the card shows it, says it, and offers no Undo of the old one", [await page.getByRole("switch").getAttribute("aria-checked"), await page.locator("p").first().textContent(), await undo.count()], ["false", "Reminders are off", 0]);

  is("no page error", errors, []);
  await context.close();
} finally {
  await browser.close();
}
console.log(`${cases - failed}/${cases} passed`);
if (failed) process.exit(1);
