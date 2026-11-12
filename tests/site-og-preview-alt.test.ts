/** The shared social image is an illustration, not evidence of an available paid checkout. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { SITE_OG_IMAGE } from "@/lib/site-og";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";
import { feeWords } from "@/lib/fee-words";

const previewAlt = "Marktmorgen preview illustration: an example Stripe checkout and a delivered file. " + PREVIEW_LINE;
const openAlt = "Marktmorgen: your store, your Stripe, your money. A paid Stripe checkout and a delivered file, " + feeWords().ogAlt + ".";
const nodeRequire = createRequire(join(process.cwd(), "package.json"));

/** Only the opening result is synthetic; the real image metadata module is evaluated. */
async function imageFor(open: boolean): Promise<typeof SITE_OG_IMAGE> {
  const { build } = nodeRequire("esbuild") as typeof import("esbuild");
  const built = await build({
    absWorkingDir: process.cwd(), entryPoints: ["lib/site-og.ts"], bundle: true,
    platform: "node", format: "cjs", write: false, alias: { "@": process.cwd() }, logLevel: "error",
    plugins: [{ name: "synthetic-social-image-opening", setup(builder) {
      builder.onLoad({ filter: /[/\\]lib[/\\]opening\.ts$/ }, ({ path }) => ({
        contents: readFileSync(path, "utf8").replace(/export const PLANS_ON_SALE: boolean = [^;]+;/, `export const PLANS_ON_SALE: boolean = ${open};`), loader: "ts",
      }));
    } }],
  });
  const evaluated = { exports: {} as { SITE_OG_IMAGE: typeof SITE_OG_IMAGE } };
  new Function("require", "module", "exports", built.outputFiles![0].text)(nodeRequire, evaluated, evaluated.exports);
  return evaluated.exports.SITE_OG_IMAGE;
}

test("the actual shared image alt follows current commercial availability", () => {
  assert.equal(SITE_OG_IMAGE.alt, PLANS_ON_SALE ? openAlt : previewAlt);
});

for (const open of [false, true]) test("the real image metadata with synthetic opening " + open, async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("Unexpected social image request"); };
  try {
    assert.deepEqual(await imageFor(open), { url: "/og.png?v=5", width: 1200, height: 630, alt: open ? openAlt : previewAlt });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test("the existing image URL and dimensions still describe the actual PNG", () => {
  assert.deepEqual([SITE_OG_IMAGE.url, SITE_OG_IMAGE.width, SITE_OG_IMAGE.height], ["/og.png?v=5", 1200, 630]);
  const png = readFileSync("public/og.png");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [SITE_OG_IMAGE.width, SITE_OG_IMAGE.height]);
});
