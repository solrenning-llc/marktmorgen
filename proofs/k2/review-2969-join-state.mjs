import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), sourceRoot = resolve(process.argv[2] ?? ownRoot);
const blob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const page = 'app/signin/join/page.tsx';
for (const [path, expected] of [[page, '27785a175e385e798f1b60411fca9be2ccaf0a59'], ['tests/honest-signin-join.test.ts', 'a5d4ebd50d3db63c856be027200779fd29e79247'], ['lib/team.ts', '96bed8ed13c9d26525ffe1aadfed0ce0c6f71f09'], ['lib/store.ts', '5f84d8564cfca3bb89c12a85de7b70fdca4fcbc1'], ['tsconfig.json', 'f126992ca95c6da5359e547a2e58e92fccd3d02c']]) assert.equal(blob(readFileSync(join(sourceRoot, path))), expected, path);
const require = createRequire(join(sourceRoot, 'package.json')), { build } = require('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'k2-review-2969-')), deadline = Date.now() + 120_000;
let printed = 0;
function run(label, file, expected) {
  const result = spawnSync(process.execPath, [file], { cwd: sourceRoot, env: testEnvironment(process.env), encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? ''); printed += Buffer.byteLength(output);
  if (printed > 128 * 1024) throw Error('Combined log exceeds admitted 128 KiB');
  console.log(`\n=== ${label} ===\n${output}`); assert.equal(result.status, expected, label); return output;
}
try {
  const oldBytes = execFileSync('git', ['show', '0e435a52c3d4bef4a8f9b102af097121e792206c:' + page], { cwd: sourceRoot, timeout: 120_000 });
  assert.equal(blob(oldBytes), '4b58d7faf5bf60a2311d3a2df0e42850b35fff1e');
  const oldPage = join(temp, 'author-red-page.tsx'); writeFileSync(oldPage, oldBytes);
  for (const variant of ['red', 'green']) {
    const file = 'honest-signin-join.test.ts', outfile = join(temp, `author-${variant}.cjs`), alias = testAliases(file, sourceRoot, join(sourceRoot, 'tests'));
    if (variant === 'red') alias['@/app/signin/join/page'] = oldPage;
    await build({ entryPoints: [join(sourceRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias, nodePaths: [join(sourceRoot, 'node_modules')], tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'error' });
    const output = run(`same author four checks: ${variant}`, outfile, variant === 'red' ? 1 : 0);
    assert.match(output, variant === 'red' ? /4 checks, 2 failing/ : /4 checks, all passing/);
  }
  const file = 'k-review-2969-join-state.proof.ts', outfile = join(temp, 'proof.cjs');
  await build({ entryPoints: [join(ownRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, sourceRoot, join(sourceRoot, 'tests')), nodePaths: [join(sourceRoot, 'node_modules')], tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'error' });
  const output = run('independent real page/team/store read controls', outfile, 1); assert.match(output, /checks, 4 failing/);
} finally { rmSync(temp, { recursive: true, force: true }); }
