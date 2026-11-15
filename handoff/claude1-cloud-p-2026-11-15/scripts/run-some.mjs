// Runs only the named tests/*.test.ts files, with the repository's own runner config.
// Usage: node run-some.mjs <repoRoot> file1.test.ts file2.test.ts ...
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2]);
const here = join(root, "tests");
const { build } = await import(pathToFileURL(join(root, "node_modules/esbuild/lib/main.js")).href);
const { testAliases, testEnvironment } = await import(pathToFileURL(join(here, "test-config.mjs")).href);
const { runTestFiles, runBundle, TEST_FILE_TIMEOUT_MS } = await import(pathToFileURL(join(here, "test-runner.mjs")).href);
const files = process.argv.slice(3).map(f => f.replace(/^tests\//, "")).filter(f => existsSync(join(here, f)));
const out = mkdtempSync(join(tmpdir(), "some-tests-"));
let failed = 0;
try {
  failed = await runTestFiles({ files, compileTimeoutMs: TEST_FILE_TIMEOUT_MS, compile: async file => {
    const bundle = join(out, `${file}.cjs`);
    await build({ entryPoints: [join(here, file)], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases(file, root, here) });
    return bundle;
  }, run: async (file, bundle, next) => {
    console.log(`\n=== ${file} ===`);
    return runBundle(bundle, testEnvironment(process.env), process.execPath, { timeoutMs: TEST_FILE_TIMEOUT_MS, label: file, diagnose: () => `next compile ${next()}` });
  } });
} finally { rmSync(out, { recursive: true, force: true }); }
console.log(`\nRAN ${files.length} FAILED ${failed}`);
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 5_000).unref();
