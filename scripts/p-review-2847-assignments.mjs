import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "p-2847-assignments-"));
try {
  const bundle = join(out, "proof.cjs");
  await build({
    entryPoints: [join(root, "tests/p-2847-assignments.proof.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("assignment-reads-exact.test.ts", root, join(root, "tests")),
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
