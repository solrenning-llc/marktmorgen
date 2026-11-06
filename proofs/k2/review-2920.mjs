import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(process.argv[2] ?? ownRoot), baseRoot = resolve(process.argv[3] ?? sourceRoot);
const expectedTest = process.argv[4] ?? '4b6ff29d0db691fe5b7cb3b716947ad6a88f10da';
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
assert.equal(blob(readFileSync(join(sourceRoot, 'lib/course-access-expiry-rules.ts'))), '0678b555bdabe6593eabb0031cf22295c7ea0c87');
assert.equal(blob(readFileSync(join(sourceRoot, 'tests/course-access-expiry-rules.test.ts'))), expectedTest);
assert.equal(blob(readFileSync(join(baseRoot, 'tsconfig.json'))), 'f126992ca95c6da5359e547a2e58e92fccd3d02c');
const require = createRequire(join(baseRoot, 'package.json'));
const { testAliases, testEnvironment } = await import(pathToFileURL(join(baseRoot, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'k2-review-2920-'));
const deadline = Date.now() + 120_000;
const timer = setTimeout(() => { console.error('Review exceeded 120 seconds'); process.exit(1); }, 120_000); timer.unref();
let printed = 0;
function run(label, args, cwd, status, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...testEnvironment(process.env), ...env }, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  printed += Buffer.byteLength(output, 'utf8');
  if (printed > 128 * 1024) throw Error('Review log exceeded its 128 KiB admission');
  console.log(`\n=== ${label} ===\n${output}`);
  assert.equal(result.status, status, `${label} returned an unexpected status`);
  return output;
}
try {
  const red = join(temp, 'red'), green = join(temp, 'green');
  for (const root of [red, green]) { mkdirSync(join(root, 'lib'), { recursive: true }); mkdirSync(join(root, 'tests'), { recursive: true }); copyFileSync(join(sourceRoot, 'tests/course-access-expiry-rules.test.ts'), join(root, 'tests/course-access-expiry-rules.test.ts')); }
  copyFileSync(join(sourceRoot, 'lib/course-access-expiry-rules.ts'), join(green, 'lib/course-access-expiry-rules.ts'));
  const file = 'course-access-expiry-rules.test.ts';
  const nativeRed = run('author unchanged RED, native absence replay', ['--test', '--test-reporter=tap', join(red, 'tests', file)], red, 1);
  assert.match(nativeRed, /Missing courseAccessExpiryState export/); assert.match(nativeRed, /# fail 11\b/);
  const nativeGreen = run('author unchanged GREEN, native real module', ['--test', '--test-reporter=tap', join(green, 'tests', file)], green, 0);
  assert.match(nativeGreen, /# tests 11\b/); assert.match(nativeGreen, /# fail 0\b/);
  const compiled = join(temp, 'author.cjs');
  await require('esbuild').build({ entryPoints: [join(sourceRoot, 'tests', file)], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, baseRoot, join(baseRoot, 'tests')), logLevel: 'error' });
  const compiledRed = run('author canonical compilation, absence replay', [compiled], red, 1);
  assert.match(compiledRed, /Missing courseAccessExpiryState export/);
  run('author canonical compilation, real module', [compiled], green, 0);
  const proof = run('independent contract and real-target TypeScript proof', ['--test', '--test-reporter=tap', join(ownRoot, 'tests/k-2920-expiry.proof.ts')], ownRoot, expectedTest === '4b6ff29d0db691fe5b7cb3b716947ad6a88f10da' ? 1 : 0, { K2920_SOURCE_ROOT: green, K2920_BASE_ROOT: baseRoot });
  if (expectedTest === '4b6ff29d0db691fe5b7cb3b716947ad6a88f10da') { assert.match(proof, /2737/); assert.match(proof, /# fail 1\b/); process.exitCode = 1; }
} finally { clearTimeout(timer); rmSync(temp, { recursive: true, force: true }); }
