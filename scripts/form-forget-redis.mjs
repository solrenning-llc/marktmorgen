/**
 * Builds tests/form-forget-redis-run.ts and runs it, passing on what it prints: the erasure's script as the
 * application sends it and the cases with what lib/form-respondent.ts makes of them. Called by
 * scripts/test_form_forget_redis.py, which runs the script in Redis. Nothing here reaches Redis or any other host.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-form-forget-"));
try {
  const bundle = join(out, "form-forget-redis-run.cjs");
  await build({
    entryPoints: [join(root, "tests", "form-forget-redis-run.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    // The script's text and the rule only: the stand-in client, so building it never reads a Redis address.
    alias: { "@": root, "@/lib/redis": join(root, "tests", "redis-stub.ts") },
  });
  const run = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: { PATH: process.env.PATH ?? "" } });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
