import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";

const root = resolve(process.cwd());
const here = join(root, "tests");
const file = "sweep-a1-buyer-profile-paypal.proof.ts";
const out = mkdtempSync(join(tmpdir(), "s-a1-proof-"));

try {
  const bundle = join(out, "proof.cjs");
  await build({
    entryPoints: [join(here, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases(file, root, here),
  });
  const result = spawnSync(process.execPath, [bundle], {
    cwd: root,
    encoding: "utf8",
    env: testEnvironment(process.env),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
