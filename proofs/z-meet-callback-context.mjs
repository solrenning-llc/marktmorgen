import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(process.cwd());
const out = mkdtempSync(join(tmpdir(), "z-meet-context-"));
try {
  const bundle = join(out, "proof.cjs");
  await build({ entryPoints: [join(root, "tests/z-meet-callback-context.proof.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases("meet-return-counter-admission.test.ts", root, join(root, "tests")) });
  const result = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), timeout: 120000, maxBuffer: 131072, encoding: "utf8" });
  process.stdout.write(result.stdout + result.stderr);
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
