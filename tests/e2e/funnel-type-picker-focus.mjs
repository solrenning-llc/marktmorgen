// 766 [STN13], unit 2: the real funnel-from-a-kind picker in a browser, driven
// by keyboard only. Each step change puts the focus on the step's own line,
// "Step N of 3: ...", so the focus is never left on a button that has gone.
// Synthetic products; every network request is refused. Not part of CI.
// Run: node tests/e2e/funnel-type-picker-focus.mjs
// E2E_BROWSER=chromium|firefox|webkit; CHROMIUM can name an installed executable.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(root + "/package.json");
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported browser");
const navigation = {
  name: "next-navigation-stub",
  setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export function useRouter(){return {refresh(){},push(){},replace(){},back(){},prefetch(){}};} export function usePathname(){return '/studio/funnels';} export function useSearchParams(){return new URLSearchParams();}",
      loader: "js",
    }));
  },
};
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {FunnelTypePicker} from '@/components/funnel-type-picker';
    const products = [
      { id: 'p1', title: 'Free guide', free: true, call: false, bundle: false, draft: false },
      { id: 'p2', title: 'Paid course', free: false, call: false, bundle: false, draft: false },
    ];
    createRoot(document.getElementById('root')).render(
      <FunnelTypePicker products={products} pagesLeft={50} canMakePages={true} funnelsLeft={5} sid="s1" />
    );
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, plugins: [navigation], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
});
const browser = await require("playwright-core")[engine].launch({
  headless: true,
  ...(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
});
let checks = 0, failures = 0;
function is(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
const focused = (page) => page.evaluate(() => document.activeElement?.textContent ?? null);
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.route("https://funnel.test/", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Funnel picker focus check</title><body><main id="root"></main></body></html>' }));
  await page.goto("https://funnel.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.getByRole("button", { name: "Choose a kind", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Step 1"));
  is("Choose a kind: the focus moves to the first step", await focused(page), "Step 1 of 3: Pick a kind");

  await page.keyboard.press("Tab");
  is("Tab goes on to the first kind's button", await focused(page), "Use this");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Step 2"));
  is("Use this: the focus moves to step 2", await focused(page), "Step 2 of 3: Products");

  await page.getByRole("button", { name: "Review funnel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Step 3"));
  is("Review funnel: the focus moves to step 3", await focused(page), "Step 3 of 3: Review");

  await page.getByRole("button", { name: "Back to products", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Step 2"));
  is("Back to products: the focus moves back to step 2", await focused(page), "Step 2 of 3: Products");

  await page.getByRole("button", { name: "Cancel setup", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Step 1"));
  is("Cancel setup: the focus moves back to step 1", await focused(page), "Step 1 of 3: Pick a kind");

  is("one step line on the page at a time", await page.locator("p[tabindex='-1']", { hasText: /^Step \d of 3/ }).count(), 1);
  is("no page errors", errors, []);
} finally {
  await browser.close();
}
console.log(`${checks} checks, ${failures} failing`);
process.exit(failures ? 1 : 0);
