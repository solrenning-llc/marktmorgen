import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, "tests/test-config.mjs")));
const temporary = mkdtempSync(join(tmpdir(), "t-platform-delivery-"));
try {
  const output = join(temporary, "proof.cjs");
  await build({
    entryPoints: [join(root, "proofs/t/platform-delivery-copy.proof.ts")],
    bundle: true, platform: "node", format: "cjs", outfile: output,
    alias: testAliases("platform-delivery-copy.proof.ts", root, join(root, "tests")),
    banner: { js: 'globalThis.fetch = async () => { throw new Error("Unexpected external request in delivery-copy proof"); };' },
    logLevel: "error",
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: testEnvironment(process.env), stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
