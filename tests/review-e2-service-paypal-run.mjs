import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "./test-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// Optional product root reproduces the SAME proof against the prior source.
const product = process.argv[2] ? resolve(process.argv[2]) : root;
const world = join(here, "service-counter-admission-world.ts");
const pay = join(here, "review-e2-service-paypal-world.ts");
const out = mkdtempSync(join(tmpdir(), "e2-service-paypal-"));
try {
  const bundle = join(out, "proof.cjs");
  await build({ entryPoints: [join(here, "review-e2-service-paypal.test.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle,
    alias: { "@": product, "@/lib/redis": world, "@/lib/store-allowance": world, "@/lib/traffic": world,
      "@/lib/store": pay, "@/lib/store-request": pay, "@/lib/paypal-payouts": pay, "@/lib/affiliates": pay },
  });
  const run = spawnSync(process.execPath, [bundle], { cwd: product, env: testEnvironment(process.env), stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
