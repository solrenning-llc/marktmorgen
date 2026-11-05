import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "./test-config.mjs";

const root = process.cwd();
const red = process.argv.includes("--parent");
const proof = process.argv.includes("--proof");
const file = proof ? "review-u2683-export.proof.ts" : "help-export-promise.test.ts";
const alias = testAliases(file, root, join(root, "tests"));
if (proof) for (const name of ["catalog", "course", "free", "store-data", "form-store", "product-about", "sales-page-store", "stats", "store-blog", "thanks-note-store"]) alias[`@/lib/${name}`] = resolve("tests/review-u2683-export-world.ts");
const out = mkdtempSync(join(tmpdir(), "u2683-"));
try {
  await build({
    entryPoints: [resolve("tests", file)], bundle: true, platform: "node", format: "cjs", outfile: join(out, "run.cjs"), alias, logLevel: "error",
    plugins: red ? [{ name: "reviewed-parent-help", setup(builder) {
      builder.onLoad({ filter: /[/\\]lib[/\\]help-content\.ts$/ }, () => ({ contents: execFileSync("git", ["show", "42f7d8a7^:lib/help-content.ts"], { encoding: "utf8" }), loader: "ts" }));
    } }] : [],
  });
  const result = spawnSync(process.execPath, [join(out, "run.cjs")], { stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
