// The store address field, "marktmorgen.com/@ yourname", laid out in a real browser with the site's own style sheet
// (issue #4312; Claude 3 cloud O's LEVE on #4498, 6872872616: tests/address-prefix-wrap.test.ts reads class strings,
// not a rendered layout). Both forms that draw it (components/handle-form.tsx, components/rename-form.tsx) at 195 px
// (a 390 px phone at 200%), 320 px and 390 px: no horizontal scroll, the field at least 6 rem wide, and the prefix kept
// whole on its line or broken only after "marktmorgen.com/". No server, nothing sent.
// node tests/e2e/address-field-wrap.mjs  (CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");
const { compile } = require("@tailwindcss/node");
const { Scanner } = require("@tailwindcss/oxide");

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const navigation = {
  name: "next-navigation-stub",
  setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export function useRouter(){return {refresh(){},push(){},replace(){},back(){},prefetch(){}};} export function usePathname(){return '/studio';} export function useSearchParams(){return new URLSearchParams();}",
      loader: "js",
    }));
  },
};
const entry = [
  'import React from "react";',
  'import { createRoot } from "react-dom/client";',
  'import { HandleForm } from "@/components/handle-form";',
  'import { RenameForm } from "@/components/rename-form";',
  'const which = new URLSearchParams(location.search).get("form");',
  'createRoot(document.getElementById("root")).render(React.createElement("div", { className: "p-4" }, which === "rename" ? React.createElement(RenameForm, { current: "yourname" }) : React.createElement(HandleForm, {})));',
].join("\n");
const bundle = await build({
  stdin: { contents: entry, loader: "tsx", resolveDir: root },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "error",
  alias: { "@": root }, plugins: [navigation],
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles[0].text;
const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: join(root, "app"), onDependency() {} });
const css = compiler.build(new Scanner({ sources: [
  { base: root, pattern: "components/handle-form.tsx", negated: false },
  { base: root, pattern: "components/rename-form.tsx", negated: false },
] }).scan());
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Store address</title><link rel="stylesheet" href="/globals.css"></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/form.js"></script></body></html>`;

// The same browser selection as tests/e2e/agreements.mjs: CHROMIUM when given, else Playwright's own, else the runner's
// own Chrome. Never a download.
async function launch() {
  if (process.env.CHROMIUM) return chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw first;
    }
  }
}
const browser = await launch();
const errors = [];
try {
  for (const form of ["handle", "rename"]) {
    for (const width of [195, 320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: "block" });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route((url) => url.protocol === "http:" || url.protocol === "https:", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://localhost:41907") return route.abort();
        if (url.pathname === "/form.js") return route.fulfill({ contentType: "text/javascript", body: script });
        if (url.pathname === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
        return url.pathname === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
      });
      await page.goto(`http://localhost:41907/?form=${form}`);
      if (form === "rename") await page.getByRole("button", { name: "Change my address" }).click();
      await page.waitForSelector("[data-address-field] input");
      const got = await page.evaluate(() => {
        const box = document.querySelector("[data-address-field]");
        const prefix = box.querySelector("span");
        const field = box.querySelector("input");
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const range = document.createRange();
        range.selectNodeContents(prefix);
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        const first = document.createRange();
        first.setStart(prefix.firstChild, 0);
        first.setEnd(prefix.firstChild, prefix.firstChild.textContent.length);
        const firstLines = new Set([...first.getClientRects()].map((r) => Math.round(r.top))).size;
        return {
          scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          boxInside: box.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5,
          fieldRem: field.getBoundingClientRect().width / rem,
          prefixLines: lines,
          firstPartLines: firstLines,
        };
      });
      const at = `${form} form at ${width} px`;
      is(`${at}: no horizontal scroll`, got.scroll, false);
      is(`${at}: the address box stays inside the page`, got.boxInside, true);
      is(`${at}: the field is at least 6 rem wide`, got.fieldRem >= 6, true);
      is(`${at}: "marktmorgen.com/" is never broken inside`, got.firstPartLines, 1);
      is(`${at}: the prefix takes at most two lines, broken after the slash`, got.prefixLines <= 2, true);
      await context.close();
    }
  }
  is("no browser error", errors, []);
} finally {
  await browser.close();
}
console.log(`ADDRESS_FIELD_WRAP_SUMMARY:${JSON.stringify({ engine: "chromium", cases, failed })}`);
if (failed) process.exitCode = 1;
