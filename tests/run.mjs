/**
 * Runs every *.test.ts in this folder.
 *
 * esbuild does the TypeScript, which is why it is a devDependency: these run
 * with `npm test` and nothing else installed. "@/lib/redis" is swapped for an
 * in-memory one, so a test exercises the real code against a store that
 * behaves like the one it was written for, without reaching anything real.
 */
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checkClientBundles } from "./client-bundles.mjs";
import {testAliases,testEnvironment} from "./test-config.mjs";
import {runTestFiles,runBundle,TEST_FILE_TIMEOUT_MS} from "./test-runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-tests-"));
let failed = 0;

try {
  const files = readdirSync(here).filter((f) => f.endsWith(".test.ts")).sort();
  if (!files.length) {
    console.log("No tests found.");
    process.exit(0);
  }
  failed = await runTestFiles({files, compileTimeoutMs: TEST_FILE_TIMEOUT_MS, compile: async file => {
    const bundle = join(out, `${file}.cjs`);
    await build({
      entryPoints: [join(here, file)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "error",
      alias: testAliases(file,root,here),
    });
    return bundle;
  }, run: async (file, bundle, next) => {
    console.log(`\n=== ${file} ===`);
    return runBundle(bundle, testEnvironment(process.env), process.execPath, {timeoutMs: TEST_FILE_TIMEOUT_MS, label: file, diagnose: () => `next compile ${next()}`});
  }});
} finally {
  rmSync(out, { recursive: true, force: true });
}

const clientBundles = await checkClientBundles(root);
console.log(`\nBrowser bundles: ${clientBundles.total - clientBundles.failed}/${clientBundles.total} passed.`);
for (const failure of clientBundles.failures) console.error(failure);
failed += clientBundles.failed;

// Ends by its exit code, like tests/check.ts done(): Node 24 can deadlock inside process.exit() (nodejs/node#64274).
// The unref'd timer only fires if something (an esbuild service, a stray handle) still holds the process.
if (failed) {
  console.log(`\n${failed} test file(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nEverything passing.");
  process.exitCode = 0;
}
setTimeout(() => process.exit(process.exitCode), 5_000).unref();
