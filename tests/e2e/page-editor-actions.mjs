// The page editor's block list in a real browser (AX274, AAA review of #2904):
// an arrow that cannot move keeps the focus and says it is off (2.4.3, 4.1.2);
// a move keeps the focus on the arrow that moved with its block and says
// where it went (2.4.3, 4.1.3); the same sentence said twice is said again;
// and in forced colors no icon button animates its colors (inbox C4-35).
// The real component with a synthetic page and every request held in the
// page (tests/e2e/page-editor-harness.tsx), the site's own style sheet built
// by Tailwind from the editor's classes: no server, no build, nothing sent.
// node tests/e2e/page-editor-actions.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const driver = require("playwright-core")[engine];
const { compile } = require("@tailwindcss/node");
const { Scanner } = require("@tailwindcss/oxide");

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/page-editor-harness.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  alias: { "@": root, "next/link": join(root, "tests/next-link-world.tsx") },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "next-navigation",
    setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-navigation", namespace: "stand-in" }));
      b.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: "export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }); export const usePathname = () => '/studio/pages'; export const useSearchParams = () => new URLSearchParams();", loader: "js" }));
    },
  }],
});
const script = bundle.outputFiles[0].text;
// The site's own style sheet with the Tailwind classes the editor uses, as the studio draws them.
const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: join(root, "app"), onDependency() {} });
const css = compiler.build(new Scanner({ sources: [{ base: root, pattern: "components/page-editor.tsx", negated: false }] }).scan());
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page editor check</title><link rel="stylesheet" href="/globals.css"></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/editor.js"></script></body></html>`;

const browser = await driver.launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://editor.test") return route.abort();
    if (url.pathname === "/editor.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
    return url.pathname === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://editor.test/");
  const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  const status = () => page.evaluate(() => [...document.querySelectorAll('p[role="status"].sr-only')].map((node) => node.textContent).find((text) => text) ?? "");

  // A hero, then two Text blocks and a FAQ: the hero stays first, so the block under it cannot move up.
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  const up2 = page.getByRole("button", { name: "Move block 2 up" });
  await up2.waitFor();
  is("the arrow that cannot move says it is off, and stays in the tab order", await up2.evaluate((node) => [node.getAttribute("aria-disabled"), node.disabled, node.tabIndex]), ["true", false, 0]);
  await up2.focus();
  await page.keyboard.press("Enter");
  await settled();
  is("pressing an arrow that cannot move keeps the focus on it", await focused(), "Move block 2 up");

  // Moved down from 2 to 3, then from 3 to 4, the last place: the focus rides with the arrow, and each place is said.
  await page.getByRole("button", { name: "Move block 2 down" }).focus();
  await page.keyboard.press("Enter");
  await settled();
  is("after a move, the focus is on the same arrow, now the block's at its new place", await focused(), "Move block 3 down");
  is("the move is said", (await status()).trim(), "Moved Text to position 3 of 4.");
  await page.keyboard.press("Enter");
  await settled();
  is("moved to the last place, the arrow is off and still holds the focus", [await focused(), await page.evaluate(() => document.activeElement?.getAttribute("aria-disabled"))], ["Move block 4 down", "true"]);
  is("the last move is said", (await status()).trim(), "Moved Text to position 4 of 4.");

  // Removed twice from the same place, the same sentence is still a change to the live region, so it is said again;
  // the focus goes to the block now in that place, never to the page's body.
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  const said = [];
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Remove block 2, Text" }).focus();
    await page.keyboard.press("Enter");
    await settled();
    said.push(await status());
    is(`after removal ${i + 1}, the focus is on the block now in its place`, await page.evaluate(() => document.activeElement?.getAttribute("aria-controls")?.startsWith("panel-") ?? false), true);
  }
  is("the same removal said twice is said again: the same words, a different text in the live region", [said[0].trim() === said[1].trim(), said[0] === said[1], said[0].trim()], [true, false, "Removed Text from position 2. Undo, at the top of the editor, brings it back."]);
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  await page.getByRole("button", { name: "Move block 2 up" }).waitFor();

  // In forced colors, no icon button animates its colors: one that turns usable shows the system colors at once.
  const timing = () => page.evaluate(() => [...document.querySelectorAll(".icon-btn")].map((node) => getComputedStyle(node).transitionDuration).filter((d) => d !== "0s").length);
  is("outside forced colors the icon buttons keep their color transition", (await timing()) > 0, true);
  await page.emulateMedia({ forcedColors: "active" });
  is("forced colors are on for the next check", await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
  is("in forced colors no icon button animates its colors", await timing(), 0);
  await page.emulateMedia({ forcedColors: "none" });

  is("no error on the page", errors, []);
} finally {
  await browser.close();
}
console.log(`PAGE_EDITOR_ACTIONS: ${engine}, ${cases - failed} of ${cases} checks passed`);
if (failed) process.exit(1);
