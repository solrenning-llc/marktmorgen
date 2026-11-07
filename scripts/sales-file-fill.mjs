/**
 * One-time support job: fills the sales file's short copies (lib/sales-file-fill.ts)
 * against the Redis in the environment (UPSTASH_REDIS_REST_URL and its token):
 * each PayPal sale's line and each product's names, for what was paid or saved
 * before they were written with it. Builds scripts/sales-file-fill-run.ts with
 * the application's real Redis client and runs it with the arguments.
 *
 *   node scripts/sales-file-fill.mjs                          only counts, changes nothing
 *   node scripts/sales-file-fill.mjs --write --yes-production  writes what is missing
 *   node scripts/sales-file-fill.mjs --max-steps=50            stops after 50 pages of stores
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-sales-file-fill-"));
try {
  const bundle = join(out, "sales-file-fill-run.cjs");
  await build({
    entryPoints: [join(root, "scripts", "sales-file-fill-run.ts")],
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
