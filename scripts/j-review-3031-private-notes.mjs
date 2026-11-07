import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';

const root = resolve('.');
const out = mkdtempSync(join(tmpdir(), 'j3031-'));
const guard = join(out, 'network.cjs');
writeFileSync(guard, `const assert=require('node:assert/strict');let attempts=0;const no=()=>{attempts++;throw Error('J3031 network blocked')};globalThis.fetch=no;require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;require('node:http').request=no;require('node:https').request=no;assert.throws(()=>globalThis.fetch('https://invalid.example'),/J3031 network blocked/);attempts=0;process.on('exit',()=>assert.equal(attempts,0,'no product network attempted'));`);
for (const file of process.argv.slice(2).length ? process.argv.slice(2) : ['sq1-lesson-notes.test.ts', 'j-review-3031-private-notes.proof.ts']) {
  const bundle = join(out, file + '.cjs');
  await build({ entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', alias: testAliases(file === 'j-review-3031-private-notes.proof.ts' ? 'sq1-lesson-notes.test.ts' : file, root, join(root, 'tests')) });
  const result = spawnSync(process.execPath, ['--require', guard, bundle], { cwd: root, env: testEnvironment(process.env), timeout: 120_000, encoding: 'utf8', maxBuffer: 256*1024 });
  console.log(`=== ${file}: status=${result.status} signal=${result.signal} ===`);
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exitCode = 1;
}
