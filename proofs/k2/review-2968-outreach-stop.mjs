import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(process.argv[2] ?? ownRoot);
const hash = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const page = 'app/outreach/stop/[token]/page.tsx';
for (const [path, expected] of [[page, '8b93d6eb2f0daba141c31a07292f9be3392e121d'], ['lib/outreach.ts', '53e1e8b985cd703ab95610e8cda31ca00fceb785'], ['tests/honest-outreach-stop.test.ts', '0ef8718c68eaa2661d93a31793d809aed9fca7bf'], ['tsconfig.json', 'f126992ca95c6da5359e547a2e58e92fccd3d02c']]) {
  assert.equal(hash(readFileSync(join(sourceRoot, path))), expected, path);
}
const require = createRequire(join(sourceRoot, 'package.json'));
const { build } = require('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'k2-review-2968-'));
const deadline = Date.now() + 120_000;
let printed = 0;
function run(label, file, expected) {
  const result = spawnSync(process.execPath, [file], { cwd: sourceRoot, env: testEnvironment(process.env), encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  printed += Buffer.byteLength(output);
  if (printed > 128 * 1024) throw Error('Combined log exceeds admitted 128 KiB');
  console.log(`\n=== ${label} ===\n${output}`);
  assert.equal(result.status, expected, label);
  return output;
}
try {
  const basePage = execFileSync('git', ['show', '1cea90eeab946e6c6a04b2596fa0ec93d882600b:' + page], { cwd: sourceRoot, timeout: 120_000 });
  assert.equal(hash(basePage), 'cfb99e88c37d0ca04653f54de20ad987f97c6c78');
  const oldPage = join(temp, 'author-red-page.tsx'); writeFileSync(oldPage, basePage);
  for (const variant of ['red', 'green']) {
    const file = 'honest-outreach-stop.test.ts', outfile = join(temp, `author-${variant}.cjs`);
    const alias = testAliases(file, sourceRoot, join(sourceRoot, 'tests'));
    if (variant === 'red') alias['@/app/outreach/stop/[token]/page'] = oldPage;
    await build({ entryPoints: [join(sourceRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias, nodePaths: [join(sourceRoot, 'node_modules')], tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'error' });
    const output = run(`same author four checks: ${variant}`, outfile, variant === 'red' ? 1 : 0);
    assert.match(output, variant === 'red' ? /4 checks, 2 failing/ : /4 checks, all passing/);
  }
  const file = 'k-review-2968-outreach-stop.proof.ts', outfile = join(temp, 'proof.cjs');
  await build({ entryPoints: [join(ownRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, sourceRoot, join(sourceRoot, 'tests')), nodePaths: [join(sourceRoot, 'node_modules')], tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'error' });
  const output = run('independent real-page controls and read-outage stop actions', outfile, 1);
  assert.match(output, /checks, 2 failing/);
} finally { rmSync(temp, { recursive: true, force: true }); }
