import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = join(root, "tests");
const file = "z-2924-meta-spend-partial.proof.ts";
const out = mkdtempSync(join(tmpdir(), "z-2924-meta-spend-partial-"));

try {
  const bundle = join(out, "proof.cjs");
  await build({
    entryPoints: [join(tests, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases(file, root, tests),
  });
  const result = spawnSync(process.execPath, [bundle], {
    cwd: root,
    env: testEnvironment(process.env),
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
