/**
 * Builds every tests/security/*.redis-run.ts with the application's real
 * Redis client (lib/redis.ts) and runs each one: called by
 * scripts/test_security_redis.py, which serves Redis to them. A journey may
 * stand in for a module Next.js provides at request time (next/headers), or
 * one only its own build can load (next/og), and the file store, which a
 * journey must never reach (lib/blob.ts), is answered by a stand-in: the
 * stand-ins sit beside the journeys, in tests/security/, and say what they do.
 * One failing journey fails the whole check; each runs in a process of its
 * own, against a database emptied between them.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { requireLoopbackRedis } from "./loopback-redis.mjs";

// The wrapper (scripts/test_security_redis.py) serves Redis on loopback with this token; nothing else is reached.
const redis = requireLoopbackRedis(process.env, "security-check");

/** Empties the throwaway database, and stops unless Redis confirms it with exactly OK. */
async function flush() {
  const response = await fetch(`${redis.url}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${redis.token}`, "Content-Type": "application/json" }, body: JSON.stringify([["FLUSHDB"]]) });
  let replies;
  try {
    replies = await response.json();
  } catch {
    replies = null;
  }
  const reply = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  if (!response.ok || !reply || typeof reply !== "object" || Object.hasOwn(reply, "error") || reply.result !== "OK") {
    throw new Error(`FLUSHDB was not confirmed (HTTP ${response.status}); no journey runs on a database that may not be empty.`);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "tests", "security");
const out = mkdtempSync(join(tmpdir(), "nimbus-security-"));
const only = process.argv[2] ?? "";
let failed = 0;
try {
  const journeys = readdirSync(here).filter((f) => f.endsWith(".redis-run.ts") && f.includes(only)).sort();
  if (!journeys.length) throw new Error("no security journeys found");
  for (const file of journeys) {
    const bundle = join(out, `${file}.cjs`);
    await build({
      entryPoints: [join(here, file)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "error",
      alias: {
        "@": root,
        "@/lib/redis": join(root, "lib", "redis.ts"),
        "@/lib/blob": join(here, "blob.ts"),
        ...(["access-email-reserve.redis-run.ts", "agreement-signature.redis-run.ts", "erasure-request-asked.redis-run.ts", "payment-request-state.redis-run.ts"].includes(file) ? { "@/lib/resend-fallback-transport": join(root, "tests/e2e/reviewed-resend-transport.ts") } : {}),
        "next/headers": join(here, "next-headers.ts"),
        "next/og": join(here, "next-og.ts"),
      },
    });
    // Each journey starts from an empty database.
    await flush();
    console.log(`\n=== ${file} ===`);
    const run = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: process.env, cwd: root });
    if (run.status !== 0) failed += 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failed) {
  console.log(`\n${failed} security journey(s) failed.`);
  process.exit(1);
}
console.log("\nEvery security journey passes.");
