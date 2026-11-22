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
import {runTestFiles,runBundle,say,testConcurrency,SERIAL_TEST_FILES,TEST_FILE_TIMEOUT_MS,parseShard,shardFiles} from "./test-runner.mjs";

// TEST_CONCURRENCY=N runs N test files at once, each still in its own process; unset, one at a time as before.
const concurrency = testConcurrency(process.env.TEST_CONCURRENCY);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "nimbus-tests-"));
let failed = 0;
/** @type {string[]} */
const failedFiles = [];
// TEST_SHARD="index/total" runs one CI job's share (tests/test-runner.mjs shardFiles); unset runs every file.
const shard = parseShard(process.env.TEST_SHARD);

try {
  const all = readdirSync(here).filter((f) => f.endsWith(".test.ts")).sort();
  if (!all.length) {
    console.log("No tests found.");
    process.exit(0);
  }
  // The share is taken first (TEST_SHARD), then its files run N at a time (TEST_CONCURRENCY), so every file still runs
  // in exactly one share, once.
  const files = shardFiles(all, shard);
  if (shard) console.log(`TEST_SHARD ${shard.index}/${shard.total}: ${files.length} of ${all.length} test files, by sorted position.`);
  if (concurrency > 1) console.log(`Running ${concurrency} test files at once, each printed whole in file order; then ${files.filter(file => SERIAL_TEST_FILES.includes(file)).length} that run alone (SERIAL_TEST_FILES in tests/test-runner.mjs).`);
  failed = await runTestFiles({files, concurrency, serial: SERIAL_TEST_FILES, compileTimeoutMs: TEST_FILE_TIMEOUT_MS, compile: async file => {
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
    say(`\n=== ${file} ===`);
    const status = await runBundle(bundle, testEnvironment(process.env), process.execPath, {timeoutMs: TEST_FILE_TIMEOUT_MS, label: file, diagnose: () => `next compile ${next()}`});
    if (status !== 0) failedFiles.push(file);
    return status;
  }});
} finally {
  rmSync(out, { recursive: true, force: true });
}

// Once per run: in a full run, or in share 1 of a sharded one.
if (!shard || shard.index === 1) {
  const clientBundles = await checkClientBundles(root);
  console.log(`\nBrowser bundles: ${clientBundles.total - clientBundles.failed}/${clientBundles.total} passed.`);
  for (const failure of clientBundles.failures) console.error(failure);
  failed += clientBundles.failed;
}

// Ends by its exit code, like tests/check.ts done(): Node 24 can deadlock inside process.exit() (nodejs/node#64274).
// The unref'd timer only fires if something (an esbuild service, a stray handle) still holds the process.
if (failed) {
  console.log(`\n${failed} test file(s) failed.`);
  // Named, so a failure is found without searching the log (files run side by side print far from where they ran).
  if (failedFiles.length) console.log(`Failed: ${failedFiles.sort().join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nEverything passing.");
  process.exitCode = 0;
}
setTimeout(() => process.exit(process.exitCode), 5_000).unref();
