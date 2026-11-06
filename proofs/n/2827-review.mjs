/** Execute immutable review assertions against a selected checkout. */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(process.argv[2] || evidenceRoot);
const sourceTests = join(sourceRoot, "tests");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceTests, "test-config.mjs")));
const out = mkdtempSync(join(tmpdir(), "n-2827-review-"));
try {
  const bundle = join(out, "review.cjs");
  await build({ entryPoints: [join(evidenceRoot, "tests/n-2827-withdrawal-rules.proof.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases("n-2827-withdrawal-rules.proof.ts", sourceRoot, sourceTests) });
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
