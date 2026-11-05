import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const requireHere = createRequire(join(process.cwd(), "package.json"));

for (const open of [false, true]) test(`actual metadata chooses only the ${open ? "open" : "preview"} wording`, async () => {
  const { build } = requireHere("esbuild") as typeof import("esbuild");
  const out = await build({
    absWorkingDir: process.cwd(), entryPoints: ["lib/site-og.ts"], bundle: true,
    platform: "node", format: "cjs", write: false, logLevel: "error",
    alias: { "@": process.cwd() },
    plugins: [{ name: "independent-image-boundaries", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(opening|fee-words)$/ }, (args) => ({ path: args.path, namespace: "j-boundary" }));
      builder.onLoad({ filter: /.*/, namespace: "j-boundary" }, ({ path }) => ({
        loader: "ts",
        contents: path.endsWith("opening")
          ? `export const PLANS_ON_SALE=${open}; export const PREVIEW_LINE="SYNTHETIC EXISTING PREVIEW";`
          : 'export function feeWords(){ globalThis.__jFeeCalls++; return {ogAlt:"SYNTHETIC EXISTING FEE"}; }',
      }));
    } }],
  });
  const scope = { __jFeeCalls: 0 };
  const evaluated = { exports: {} as { SITE_OG_IMAGE: { url: string; width: number; height: number; alt: string } } };
  new Function("require", "module", "exports", "globalThis", out.outputFiles![0].text)(requireHere, evaluated, evaluated.exports, scope);
  assert.deepEqual(evaluated.exports.SITE_OG_IMAGE, {
    url: "/og.png?v=5", width: 1200, height: 630,
    alt: open
      ? "Marktmorgen: your store, your Stripe, your money. A paid Stripe checkout and a delivered file, SYNTHETIC EXISTING FEE."
      : "Marktmorgen preview illustration: an example Stripe checkout and a delivered file. SYNTHETIC EXISTING PREVIEW",
  });
  assert.equal(scope.__jFeeCalls, open ? 1 : 0);
});
