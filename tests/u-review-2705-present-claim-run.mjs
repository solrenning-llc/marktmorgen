import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "./test-config.mjs";

const file = "u-review-2705-present-claim.proof.ts";
const root = process.cwd();
const alias = testAliases(file, root, resolve("tests"));
for (const name of ["email", "purchase-email", "agreement-store"]) {
  alias[`@/lib/${name}`] = resolve("tests/u-agreement-copy-world.ts");
}
const out = mkdtempSync(join(tmpdir(), "u-review-2705-"));
try {
  await build({
    entryPoints: [resolve("tests", file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(out, "run.cjs"),
    alias,
    logLevel: "error",
  });
  const result = spawnSync(process.execPath, [join(out, "run.cjs")], {
    stdio: "inherit",
    env: testEnvironment(process.env),
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
