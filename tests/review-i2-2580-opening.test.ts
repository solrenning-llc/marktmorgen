import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ComponentType } from "react";
import type { BuildOptions } from "esbuild";
import { PREVIEW_LINE } from "@/lib/opening";
import { feeWords } from "@/lib/fee-words";
import { SITE_URL } from "@/lib/site-url";
const require = createRequire(join(process.cwd(), "package.json"));
const { build } = require("esbuild") as typeof import("esbuild");
async function graph(open: boolean) {
 const plugins: NonNullable<BuildOptions["plugins"]> = [{ name: "independent-opening-control", setup(builder) {
  builder.onLoad({ filter: /[/\\]lib[/\\]opening\.ts$/ }, ({ path }) => ({ contents: readFileSync(path, "utf8").replace(/export const PLANS_ON_SALE: boolean = [^;]+;/, `export const PLANS_ON_SALE: boolean = ${open};`), loader: "ts" }));
  if (process.env.REVIEW_I2_STRUCTURE_BEFORE) builder.onLoad({ filter: /[/\\]components[/\\]structured-data\.tsx$/ }, () => ({ contents: readFileSync(process.env.REVIEW_I2_STRUCTURE_BEFORE!, "utf8"), loader: "tsx" }));
 } }];
 const result = await build({ absWorkingDir: process.cwd(), entryPoints: ["components/structured-data.tsx"], bundle: true, platform: "node", format: "cjs", write: false, alias: { "@": process.cwd() }, external: ["react", "react/jsx-runtime"], plugins, logLevel: "error" });
 const evaluated = { exports: {} as { SiteData: ComponentType } };
 new Function("require", "module", "exports", result.outputFiles![0].text)(require, evaluated, evaluated.exports);
 const html = renderToStaticMarkup(createElement(evaluated.exports.SiteData));
 const match = /^<script type="application\/ld\+json">([\s\S]*)<\/script>$/.exec(html);
 assert.ok(match);
 return JSON.parse(match[1]);
}
for (const open of [false, true]) test("actual Organization graph with synthetic opening " + open, async () => {
 const previous = globalThis.fetch; let calls = 0;
 globalThis.fetch = async () => { calls++; throw Error("Unexpected structured-data request"); };
 try {
  const data = await graph(open);
  assert.equal(data["@context"], "https://schema.org");
  assert.deepEqual(data["@graph"], [
   { "@type": "Organization", "@id": SITE_URL + "/#organization", name: "Marktmorgen", url: SITE_URL, logo: SITE_URL + "/icons/icon-512.png", description: open ? "A link-in-bio store for creators who sell files, courses, memberships and calls. Buyers pay into the creator's own Stripe account and " + feeWords().takesOfCreator : PREVIEW_LINE },
   { "@type": "WebSite", "@id": SITE_URL + "/#website", url: SITE_URL, name: "Marktmorgen", publisher: { "@id": SITE_URL + "/#organization" }, inLanguage: "en" },
  ]);
  assert.equal(calls, 0);
 } finally { globalThis.fetch = previous; }
});
