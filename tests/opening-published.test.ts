import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLANS_ON_SALE_PUBLISHED } from "@/lib/opening-published";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

test("the published constant is the decision itself, today and whenever it changes", () => {
  assert.equal(PLANS_ON_SALE_PUBLISHED, PLANS_ON_SALE);
});

test("the studio's messages carry none of the opening review to the browser", async () => {
  const result = await build({
    entryPoints: [join(process.cwd(), "lib/studio-messages.ts")],
    absWorkingDir: process.cwd(), bundle: true, write: false, metafile: true, minify: true,
    platform: "browser", format: "esm", nodePaths: [join(process.cwd(), "node_modules")],
    external: ["react", "react/*", "next/*"], tsconfig: join(process.cwd(), "tsconfig.json"), logLevel: "silent",
  });
  const inputs = Object.values(result.metafile!.outputs).flatMap((output) => Object.keys(output.inputs));
  assert.deepEqual(["lib/opening.ts", "lib/commercial-margin.ts", "lib/customer-tax-review.ts", "lib/tax-gate.ts"].filter((m) => inputs.includes(m)), []);
});
