import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "./test-config.mjs";

const root = process.cwd();
const file = "tests/u-custom-page-metadata-language.proof.ts";
const out = mkdtempSync(join(tmpdir(), "u-custom-page-metadata-"));

try {
  const bundle = join(out, "proof.cjs");
  await build({
    entryPoints: [resolve(root, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases(file.split("/").at(-1), root, resolve(root, "tests")),
  });
  const run = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
