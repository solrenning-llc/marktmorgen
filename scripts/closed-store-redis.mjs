/**
 * Builds tests/closed-store-redis-run.ts with the application's real Redis
 * client (lib/redis.ts) and runs it: called by
 * scripts/test_closed_store_redis.py, which serves Redis to it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-closed-store-"));
try {
  const bundle = join(out, "closed-store-redis-run.cjs");
  await build({
    entryPoints: [join(root, "tests", "closed-store-redis-run.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    // Account review/usage and budget ACKs are explicitly synthetic; the
    // application keeps its real Redis client and the real transport guard.
    // The exact budget Lua is proved by its separate required Redis suite.
    alias: { "@": root, "@/lib/redis": join(root, "lib", "redis.ts"),
      "@/lib/resend-fallback-transport": join(root, "tests/e2e/reviewed-resend-transport.ts") },
  });
  const run = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: process.env });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
