import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));
const { build } = await import(join(root, "node_modules/esbuild/lib/main.js"));
const { testAliases, testEnvironment } = await import(join(root, "tests/test-config.mjs"));
const folder = mkdtempSync(join(tmpdir(), "z-2895-product-gone-"));
try {
  const output = join(folder, "proof.cjs");
  await build({
    entryPoints: [join(root, "tests/z-2895-product-gone.proof.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: output,
    logLevel: "error",
    alias: testAliases("z-2895-product-gone.proof.ts", root, join(root, "tests")),
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: testEnvironment(process.env), stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
