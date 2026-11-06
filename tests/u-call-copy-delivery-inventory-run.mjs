import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "./test-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const file = "u-call-copy-delivery-inventory.proof.ts";
const out = mkdtempSync(resolve(tmpdir(), "codex-u-call-copy-inventory-"));

try {
  const bundle = resolve(out, "proof.cjs");
  await build({
    entryPoints: [resolve(here, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases(file, root, here),
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
