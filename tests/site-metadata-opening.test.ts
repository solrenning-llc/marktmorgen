import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type { Metadata } from "next";
import type { BuildOptions } from "esbuild";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";
import { SITE_URL } from "@/lib/site-url";
import { SITE_OG_IMAGE } from "@/lib/site-og";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

/** Evaluate the real layout export; only Next's build-time fonts and CSS are inert. */
async function layoutMetadata(open?: boolean): Promise<Metadata> {
  const options: BuildOptions = {
    absWorkingDir: process.cwd(),
    entryPoints: ["app/layout.tsx"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@": process.cwd() },
    external: ["next/font/google"],
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
  const evaluated = { exports: {} as { metadata: Metadata } };
  const requireWithFonts = (id: string) => id === "next/font/google"
    ? Object.fromEntries(["Geist", "Instrument_Serif", "Fraunces", "Playfair_Display", "Nunito", "Bricolage_Grotesque"]
      .map((name) => [name, (font: { variable: string }) => ({ variable: font.variable, className: "synthetic-font" })]))
    : nodeRequire(id);
  new Function("require", "module", "exports", result.outputFiles![0].text)(requireWithFonts, evaluated, evaluated.exports);
  return evaluated.exports.metadata;
}

test("the actual default metadata describes the product's current availability", async () => {
  const metadata = await layoutMetadata();
  if (!PLANS_ON_SALE) {
    assert.equal(metadata.title, "Marktmorgen — prepare your creator store");
    assert.equal(metadata.description, PREVIEW_LINE);
    assert.doesNotMatch(String(metadata.title), /pays into|paid checkout|trial/i);
  }
});

test("closed metadata stays truthful independently of the current opening result", async () => {
  const metadata = await layoutMetadata(false);
  assert.equal(metadata.title, "Marktmorgen — prepare your creator store");
  assert.equal(metadata.description, PREVIEW_LINE);
});

test("an explicitly synthetic open state retains the existing published description", async () => {
  const metadata = await layoutMetadata(true);
  assert.equal(metadata.title, "Marktmorgen — the link-in-bio store that pays into your own Stripe");
  assert.equal(metadata.description, "A storefront for creators selling digital products, courses, memberships and booked sessions. Payments are processed through your own Stripe account, and " + feeWords().takes);
});

test("metadata keeps the canonical base and inherited social cards without runtime requests", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Unexpected metadata request"); }) as typeof fetch;
  try {
    const metadata = await layoutMetadata();
    assert.equal(String(metadata.metadataBase), `${SITE_URL}/`);
    assert.deepEqual(metadata.alternates, { canonical: "./" });
    assert.deepEqual(metadata.openGraph, { type: "website", siteName: "Marktmorgen", locale: "en_US", images: [SITE_OG_IMAGE] });
    assert.deepEqual(metadata.twitter, { card: "summary_large_image", images: [SITE_OG_IMAGE.url] });
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
