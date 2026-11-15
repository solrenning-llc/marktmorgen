/**
 * Next sends a page every browser component its server code imports, used or not. The public home page
 * (and the plain pages beside it) must not reach a store's buyer components through a server import:
 * once reached, the cart, the digital-consent box and the bundle picker are downloaded and parsed on a
 * phone that never sees them. The home page used to reach them through lib/demo-seed.ts, for two
 * constants, whose checkout imports lead to components/store-product.tsx.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const nodeRequire = createRequire(join(root, "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

/** The "use client" files a server entry's import graph reaches, each one a boundary Next ships to the browser. */
async function clientBoundaries(entry: string): Promise<string[]> {
  const found = new Set<string>();
  await build({
    entryPoints: [join(root, entry)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    tsconfig: join(root, "tsconfig.json"),
    loader: { ".css": "empty" },
    logLevel: "silent",
    plugins: [{
      name: "client-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, async (args) => {
          if (args.pluginData?.inner) return undefined;
          const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { inner: true } });
          if (resolved.errors.length || resolved.external || !/\.tsx?$/.test(resolved.path)) return undefined;
          if (!/^\s*["']use client["']/.test(readFileSync(resolved.path, "utf8"))) return undefined;
          found.add(relative(root, resolved.path));
          return { path: resolved.path, external: true };
        });
      },
    }],
  });
  return [...found].sort();
}

/** A store's buyer components: they belong on a store's pages, never on the platform's own. */
const STORE_BUYER = ["components/store-cart.tsx", "components/digital-consent-box.tsx", "components/pick-bundle-form.tsx"];

for (const page of ["app/page.tsx", "app/pricing/page.tsx", "app/signin/page.tsx"]) {
  test(`${page} ships none of a store's buyer components`, async () => {
    const reached = await clientBoundaries(page);
    assert.ok(reached.length > 0, "the walk finds the page's own browser components");
    assert.deepEqual(reached.filter((file) => STORE_BUYER.includes(file)), []);
  });
}
