import { build } from 'esbuild';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';

const root = resolve(import.meta.dirname, '..');
const target = '3e15c17d20e076c08f68080a241fc7222120f2f0';
const old = '3dc42b26dfd191b6d727c2ab6f916c668d8ca8fa';
const mode = process.argv[2] ?? 'head';
const file = process.argv[3] ?? 'sz2-physical-legal.test.ts';
if (!['head', 'old-module'].includes(mode)) throw Error('mode');
if (!['sz2-physical-legal.test.ts', 'j-2934-physical-legal.proof.ts', 'j-2934-focal.proof.ts', 'platform-us-english.test.ts'].includes(file)) throw Error('file scope');
const own = ['tests/j-2934-physical-legal.proof.ts', 'tests/j-2934-focal.proof.ts', 'scripts/j-review-2934-run.mjs', 'scripts/j-2934-focal.mjs', 'docs/reviews/j-2934-focal-2026-11-07.md', 'docs/reviews/j-2934-focal-2026-11-07.output.txt'];
const changed = execFileSync('git', ['diff', '--name-only', target, '--'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (changed.some(p => !own.includes(p))) throw Error('source differs from exact corrective target');
const out = mkdtempSync('/dev/shm/j2934-focal-'), bundle = join(out, 'proof.cjs');
const blocked = `const assert=require('node:assert/strict');const no=()=>{throw Error('REVIEW_NETWORK_BLOCKED')};require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;for(const p of ['node:http','node:https']){require(p).request=require(p).get=no}globalThis.fetch=no;assert.throws(()=>fetch('https://example.invalid'),/REVIEW_NETWORK_BLOCKED/);assert.throws(()=>require('node:net').connect(443,'example.invalid'),/REVIEW_NETWORK_BLOCKED/);console.log('NETWORK_NEGATIVE_CONTROLS_PASS_BEFORE_GRAPH');globalThis.__jRun=0;process.on('exit',()=>console.log('MEMORY_REDIS_RUN',globalThis.__jRun));`;
const plugin = { name: 'j-focal-boundary', setup(b) {
  if (mode === 'old-module') b.onLoad({ filter: /lib\/physical-legal\.ts$/ }, () => ({ contents: execFileSync('git', ['show', old + ':lib/physical-legal.ts'], { cwd: root, encoding: 'utf8' }), loader: 'ts' }));
  b.onLoad({ filter: /lib\/redis-memory\.ts$/ }, args => {
    let s = readFileSync(args.path, 'utf8');
    const needle = 'run(command: (string | number)[]): unknown {';
    if (!s.includes(needle)) throw Error('run signature');
    s = s.replace(needle, needle + '\n if (++(globalThis as unknown as {__jRun:number}).__jRun > 20000) throw Error("REVIEW_RUN_LIMIT");');
    return { contents: s, loader: 'ts' };
  });
} };
await build({ entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, alias: testAliases(file, root, join(root, 'tests')), plugins: [plugin], banner: { js: blocked }, logLevel: 'error' });
console.log('J_FOCAL', mode, file, 'EXACT_TARGET', target);
const r = spawnSync(process.execPath, ['--max-old-space-size=512', bundle], { cwd: root, env: testEnvironment({ ...process.env, TMPDIR: '/dev/shm' }), encoding: 'utf8', timeout: 120000, maxBuffer: 262144 });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
console.log('J_CHILD_EXIT', r.status);
if (r.error) throw r.error;
process.exitCode = r.status ?? 2;
