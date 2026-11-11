/**
 * The site menu (components/site-nav.tsx) is a browser component on every public page, and through the
 * root not-found page (app/not-found.tsx) its code is part of every page's first download, stores included.
 * It only needs to know whether to show the preview line, which lib/opening.ts decides by running the whole
 * commercial review (margins, tax readings, contract funding, the assistant's floor). That review is server
 * work: a phone on mobile data must not download and execute it to learn a constant. The root layout, a
 * server component, reads the decision and hands the menu the finished line; nothing about the decision moves.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type { BuildOptions } from "esbuild";
import { PLANS_ON_SALE, PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

/** Server-side modules of the opening decision that no browser bundle of the menu may carry. */
const SERVER_ONLY = [
  "lib/opening.ts",
  "lib/commercial-margin.ts",
  "lib/customer-tax-review.ts",
  "lib/contract-funding-rules.ts",
  "lib/store-assistant-rules.ts",
  "lib/tax-gate.ts",
  "lib/deemed-supplier.ts",
  "lib/stripe-platform-eligibility.ts",
];

test("the site menu's browser bundle carries none of the opening review", async () => {
  // The same browser build tests/client-bundles.mjs makes of every client component.
  const result = await build({
    entryPoints: [join(process.cwd(), "components/site-nav.tsx")],
    absWorkingDir: process.cwd(),
    bundle: true,
    write: false,
    metafile: true,
    minify: true,
    platform: "browser",
    format: "esm",
    nodePaths: [join(process.cwd(), "node_modules")],
    external: ["react", "react/*", "next/*"],
    tsconfig: join(process.cwd(), "tsconfig.json"),
    logLevel: "silent",
  });
  const inputs = Object.values(result.metafile!.outputs).flatMap((output) => Object.keys(output.inputs));
  assert.deepEqual(SERVER_ONLY.filter((module) => inputs.includes(module)), []);
});

/** The real root layout and menu, in one bundle so they share one React context; PLANS_ON_SALE optionally made synthetic. */
async function layoutAndMenu(open?: boolean) {
  const options: BuildOptions = {
    absWorkingDir: process.cwd(),
    stdin: {
      contents: 'export { default as RootLayout } from "./app/layout.tsx"; export { SiteNav } from "./components/site-nav.tsx";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@": process.cwd() },
    external: ["next/font/google", "react", "react/*", "react-dom", "react-dom/*", "next/link", "next/navigation"],
    loader: { ".css": "empty" },
    logLevel: "error",
  };
  if (open !== undefined) options.plugins = [{
    name: "synthetic-opening-control",
    setup(builder) {
      builder.onLoad({ filter: /[/\\]lib[/\\]opening\.ts$/ }, ({ path }) => ({
        contents: readFileSync(path, "utf8").replace(
          /export const PLANS_ON_SALE: boolean = [^;]+;/,
          `export const PLANS_ON_SALE: boolean = ${open};`,
        ),
        loader: "ts",
      }));
    },
  }];
  const result = await build(options);
  const evaluated = { exports: {} as { RootLayout: (props: { children: unknown }) => unknown; SiteNav: () => unknown } };
  const requireWithFonts = (id: string) => id === "next/font/google"
    ? Object.fromEntries(["Geist", "Instrument_Serif", "Fraunces", "Playfair_Display", "Nunito", "Bricolage_Grotesque"]
      .map((name) => [name, (font: { variable: string }) => ({ variable: font.variable, className: "synthetic-font" })]))
    : nodeRequire(id);
  new Function("require", "module", "exports", result.outputFiles![0].text)(requireWithFonts, evaluated, evaluated.exports);
  return evaluated.exports;
}

async function pageHtml(open?: boolean): Promise<string> {
  const { createElement } = nodeRequire("react") as typeof import("react");
  const { renderToStaticMarkup } = nodeRequire("react-dom/server") as typeof import("react-dom/server");
  const { AppRouterContext } = nodeRequire("next/dist/shared/lib/app-router-context.shared-runtime");
  const { RootLayout, SiteNav } = await layoutAndMenu(open);
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never },
    createElement(RootLayout as never, null, createElement(SiteNav as never))));
}

const bar = (html: string) => html.match(/<div[^>]*data-preview-bar=""[^>]*>[\s\S]*?<\/div>/)?.[0] ?? null;

test("while plans are closed, the real layout gives every menu the preview line and its link", async () => {
  const html = await pageHtml(false);
  const line = bar(html);
  assert.ok(line, "the preview bar is drawn");
  assert.ok(line.includes(PREVIEW_LINE.replace(/'/g, "&#x27;")), "with the exact preview line");
  assert.match(line, new RegExp(`<a[^>]*href="${PREVIEW_LINK.href}"[^>]*>${PREVIEW_LINK.label}</a>`));
  // The way past the menu is still the first thing a keyboard reaches.
  assert.ok(html.indexOf("Skip to the page content") < html.indexOf("data-preview-bar"));
});

test("a synthetic open state draws no preview line, and today's state follows PLANS_ON_SALE", async () => {
  assert.equal(bar(await pageHtml(true)), null);
  assert.equal(bar(await pageHtml()) === null, PLANS_ON_SALE);
});
