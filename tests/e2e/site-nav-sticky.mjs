// The site menu stays on screen when the page scrolls (#3997 review): the help for buyers and the site's own
// not-found page, as the server draws them (the real components, rendered with the unit tests' own wiring), opened in
// a browser with the CSS that makes the menu stick, scrolled 1,500 px; the menu's top must be 0. A page that wraps
// <SiteNav /> in its own <header> fails: the sticky menu only sticks inside that short wrapper.
// node tests/e2e/site-nav-sticky.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../test-config.mjs";

const root = resolve(".");
const here = join(root, "tests");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
const driver = require("playwright-core")[engine];
const out = mkdtempSync(join(tmpdir(), "site-nav-sticky-"));
let failed = 0;
try {
  const entry = join(out, "render.tsx");
  writeFileSync(entry, `import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BuyerHelpPage from "@/app/help/buyers/page";
import NotFound from "@/app/not-found";
process.stdout.write(JSON.stringify({ "/help/buyers": renderToStaticMarkup(createElement(BuyerHelpPage)), "/not-found": renderToStaticMarkup(createElement(NotFound)) }));
`);
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: join(out, "render.cjs"), logLevel: "error", nodePaths: [join(root, "node_modules")], alias: testAliases("site-nav-sticky.test.ts", root, here) });
  const rendered = spawnSync(process.execPath, [join(out, "render.cjs")], { encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 64 * 1024 * 1024 });
  if (rendered.status !== 0) throw Error("render failed: " + rendered.stderr.slice(0, 2000));
  const pages = JSON.parse(rendered.stdout);
  // Only what decides where the menu sits: the utilities on the page column and the menu, and a page long enough to scroll.
  const css = ".sticky{position:sticky}.top-0{top:0}.z-50{z-index:50}.flex{display:flex}.flex-col{flex-direction:column}.min-h-screen{min-height:100vh}.flex-1{flex:1 1 0%}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}main{min-height:4000px}body{margin:0}";
  const browser = await driver.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    for (const [path, body] of Object.entries(pages)) {
      for (const width of [320, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Menu check</title><style>${css}</style></head><body>${body}</body></html>`);
        await page.evaluate(() => window.scrollTo(0, 1500));
        const top = await page.evaluate(() => Math.round(document.querySelector('nav[aria-label="Main"]')?.getBoundingClientRect().top ?? NaN));
        const ok = top === 0;
        if (!ok) failed++;
        console.log(`${ok ? "ok  " : "FAIL"}  ${path} at ${width} px, scrolled 1,500 px: the menu's top is ${top}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log(failed ? `${failed} failing (${engine}).` : `all passing (${engine}).`);
process.exitCode = failed ? 1 : 0;
