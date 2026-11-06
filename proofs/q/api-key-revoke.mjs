import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) || evidenceRoot);
const require = createRequire(join(sourceRoot, "package.json"));
const { build } = require("esbuild");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, "tests/test-config.mjs")).href);
const files = process.argv.includes("--linked")
  ? ["api.test.ts", "api-key-second-step.test.ts"]
  : process.argv.includes("--resolve")
    ? ["q-api-key-resolve.proof.ts"]
    : ["q-api-key-revoke.proof.ts"];
for (const file of files) {
  const proof = file.endsWith(".proof.ts");
  const result = await build({
    entryPoints: [join(proof ? evidenceRoot : sourceRoot, "tests", file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: testAliases(proof ? "api.test.ts" : file, sourceRoot, join(sourceRoot, "tests")),
    logLevel: "error",
  });
  const ran = spawnSync(process.execPath, ["--input-type=commonjs", "-"], {
    input: result.outputFiles[0].text,
    cwd: sourceRoot,
    env: testEnvironment(process.env),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  console.log(`=== ${file} ===`);
  process.stdout.write(ran.stdout || "");
  process.stderr.write(ran.stderr || "");
  if (ran.error) throw ran.error;
  if (ran.status !== 0) process.exitCode = 1;
}
