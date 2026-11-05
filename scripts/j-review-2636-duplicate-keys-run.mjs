import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "tests");
const file = "review-j-2636-duplicate-keys.proof.ts";
const out = mkdtempSync(join(tmpdir(), "j-review-2636-"));
try {
  const bundle = join(out, `${file}.cjs`);
  await build({
    entryPoints: [join(here, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases(file, root, here),
  });
  const run = spawnSync(process.execPath, [bundle], {
    stdio: "inherit",
    env: testEnvironment(process.env),
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
