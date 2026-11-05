import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, "tests/test-config.mjs")));
const dir = mkdtempSync(join(tmpdir(), "j-commercial-dispute-proof-"));
try {
  const out = join(dir, "proof.cjs");
  await build({
    entryPoints: [join(root, "tests/j-commercial-dispute-projection.test.ts")],
    bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error",
    // Reuse exactly the repository's existing plain positive-control policies.
    alias: testAliases("plan-revenue-ceilings.test.ts", root, join(root, "tests")),
  });
  const result = spawnSync(process.execPath, [out], { cwd: root, env: testEnvironment(process.env), stdio: "inherit", timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
