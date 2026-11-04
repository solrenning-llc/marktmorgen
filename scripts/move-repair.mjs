/**
 * Support: shows and repairs a move that could be neither finished nor
 * undone (lib/move-repair.ts), against the Redis in the environment
 * (UPSTASH_REDIS_REST_URL and its token). Builds scripts/move-repair-run.ts
 * with the application's real Redis client and runs it with the arguments.
 *
 *   node scripts/move-repair.mjs someone@example.com
 *   node scripts/move-repair.mjs someone@example.com --repair --yes-production
 *   node scripts/move-repair.mjs someone@example.com --clear=someone@example.com --yes-production
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-move-repair-"));
try {
  const bundle = join(out, "move-repair-run.cjs");
  await build({
    entryPoints: [join(root, "scripts", "move-repair-run.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: { "@": root, "@/lib/redis": join(root, "lib", "redis.ts") },
  });
  const run = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
