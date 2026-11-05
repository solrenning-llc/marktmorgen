import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { testAliases } from "../../tests/test-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const world = join(here, "imported-purchases-read-world.ts");
const aliases = new Set([
  "@/lib/auth",
  "@/lib/buyer-library",
  "@/lib/order-data",
  "@/lib/redis",
  "@/lib/store-data",
  "@/lib/store-data-rules",
]);
const out = mkdtempSync(join(tmpdir(), "l-imported-purchases-proof-"));
const bundle = join(out, "proof.cjs");
const accessBundle = join(out, "access-proof.cjs");

try {
  await build({
    entryPoints: [join(here, "imported-purchases-read-evidence.proof.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    plugins: [{
      name: "proof-world",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\// }, (args) => aliases.has(args.path) ? { path: world } : null);
      },
    }],
  });
  const result = spawnSync(process.execPath, [bundle], { stdio: "inherit" });
  await build({
    entryPoints: [join(here, "imported-purchases-access-evidence.proof.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: accessBundle,
    logLevel: "error",
    alias: testAliases("imported-purchases-access-evidence.proof.ts", root, join(root, "tests")),
  });
  const access = spawnSync(process.execPath, [accessBundle], { stdio: "inherit" });
  process.exitCode = (result.status ?? 1) || (access.status ?? 1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
