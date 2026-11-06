/**
 * The checkout's performance budget, checked without a build (queue item 277
 * [H3-2]; method and measurements in docs/checkout-speed-2026-11-06.md).
 *
 *   node scripts/checkout-budget.mjs          a table, and exit 1 if a budget is broken
 *   node scripts/checkout-budget.mjs --json   the same, as JSON (tests/checkout-budget.test.ts)
 *
 * For each page a buyer passes through before the hand-off to Stripe, the
 * server-side import graph of its page and layouts is read with esbuild, and
 * every "use client" module in it is collected: that is the code Next.js
 * ships to the browser for the route, besides React and Next.js themselves.
 * Those modules are bundled for the browser, minified and gzipped. Checked:
 *
 *   - the gzipped size stays under the route's ceiling in BUDGETS;
 *   - modules the route never draws stay out of it (KEPT_OUT): a server
 *     component that imports a module full of client components ships all of
 *     them, rendered or not;
 *   - nothing in the graph loads a script from another site (next/script, or
 *     a <script src="http…">), which would block or delay the page on a
 *     server Marktmorgen does not run.
 *
 * It is a static proxy for the bytes a phone downloads, chosen because it is
 * deterministic and cheap enough for every CI run (no build, no browser, no
 * timing on a shared runner). The bytes actually shipped are measured on a
 * production build by scripts/checkout-speed.mjs.
 *
 * A ceiling is the measured size rounded up to the next KiB plus 1 KiB. Raise
 * one only on purpose, in the same pull request as the code that needs it,
 * saying why; never to make an unrelated change pass.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The buy box's browser code (components/store-product.tsx): drawn on the product page only. */
const BUY_BOX = ["components/digital-consent-box.tsx", "components/email-field.tsx", "components/pick-bundle-form.tsx", "components/store-cart.tsx"];

/** Each page before the hand-off to Stripe, its gzipped ceiling (measured 6 November 2026, rounded up to a KiB, plus 1 KiB) and what it must not carry. */
export const ROUTES = [
  {
    name: "product page",
    route: "/@handle/p/[product]",
    entries: ["app/layout.tsx", "app/[handle]/layout.tsx", "app/[handle]/p/[product]/page.tsx"],
    budgetBytes: 63488,
    keptOut: [],
  },
  {
    name: "payment request page",
    route: "/@handle/pay/[request]",
    entries: ["app/layout.tsx", "app/[handle]/layout.tsx", "app/[handle]/pay/[request]/page.tsx"],
    budgetBytes: 25600,
    keptOut: BUY_BOX,
  },
  {
    name: "embedded card",
    route: "/embed/[handle]/[product]",
    entries: ["app/layout.tsx", "app/embed/[handle]/[product]/page.tsx"],
    budgetBytes: 8192,
    keptOut: BUY_BOX,
  },
];

const CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["'];?/;
const OFF_SITE_SCRIPT = /<script[^>]*\bsrc=\{?["'`]https?:\/\//i;
const ASSETS = { ".css": "empty", ".svg": "empty", ".png": "empty", ".jpg": "empty", ".woff2": "empty" };

/** The "use client" modules in the server import graph of `entries`, and the files that graph reads. */
export async function clientModulesOf(root, entries) {
  const result = await build({
    entryPoints: entries.map((entry) => join(root, entry)),
    absWorkingDir: root,
    bundle: true,
    write: false,
    outdir: join(root, ".checkout-budget-unused"),
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    loader: ASSETS,
    jsx: "automatic",
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "silent",
  });
  const inputs = result.metafile.inputs;
  const files = Object.keys(inputs).filter((file) => /\.(tsx?|jsx?|mjs)$/.test(file) && !file.includes("node_modules/"));
  const clients = files.filter((file) => CLIENT.test(readFileSync(join(root, file), "utf8"))).sort();
  const offSite = files.filter((file) => OFF_SITE_SCRIPT.test(readFileSync(join(root, file), "utf8")) || inputs[file].imports.some((item) => item.path === "next/script"));
  return { clients, offSite, files };
}

/** Minified, gzipped bytes of `modules` bundled for the browser, React and Next.js left out. */
export async function clientBytes(root, modules) {
  if (!modules.length) return 0;
  const result = await build({
    stdin: { contents: modules.map((file, n) => `export * as m${n} from ${JSON.stringify(`./${file}`)};`).join("\n"), resolveDir: root, loader: "ts" },
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    minify: true,
    external: ["react", "react/*", "react-dom", "react-dom/*", "next", "next/*"],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: ASSETS,
    jsx: "automatic",
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "silent",
  });
  return gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
}

/** Every route measured and judged against its budget. */
export async function checkBudgets(root, routes = ROUTES) {
  const results = [];
  for (const route of routes) {
    const { clients, offSite } = await clientModulesOf(root, route.entries);
    const bytes = await clientBytes(root, clients);
    const carried = route.keptOut.filter((file) => clients.includes(file));
    const problems = [];
    if (bytes > route.budgetBytes) problems.push(`${bytes} gzipped bytes of client code, over its budget of ${route.budgetBytes}`);
    for (const file of carried) problems.push(`carries ${file}, which it never draws`);
    for (const file of offSite) problems.push(`${file} loads a script from another site`);
    results.push({ name: route.name, route: route.route, bytes, budgetBytes: route.budgetBytes, clients, offSite, carried, problems });
  }
  return results;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const results = await checkBudgets(root);
  if (process.argv.includes("--json")) console.log(JSON.stringify(results));
  else
    for (const r of results) {
      console.log(`${r.problems.length ? "FAIL" : "ok  "}  ${r.name} (${r.route}): ${(r.bytes / 1024).toFixed(1)} KiB of ${(r.budgetBytes / 1024).toFixed(1)} KiB, ${r.clients.length} client modules`);
      for (const problem of r.problems) console.log(`        ${problem}`);
    }
  if (results.some((r) => r.problems.length)) process.exitCode = 1;
}
