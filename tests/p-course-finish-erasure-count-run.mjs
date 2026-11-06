import { build } from "esbuild";
import { testAliases, testEnvironment } from "./test-config.mjs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(resolve(tmpdir(), "codex-p-course-finish-erasure-"));
try {
  const bundle = resolve(out, "proof.cjs");
  await build({
    entryPoints: [resolve(here, "p-course-finish-erasure-count.proof.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("p-course-finish-erasure-count.proof.ts", root, here),
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
