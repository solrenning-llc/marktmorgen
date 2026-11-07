import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';

const root = resolve(import.meta.dirname, '..'), here = join(root, 'tests');
const target = '760c0f79a189f518324e81ecdcd43dd7006bd5ac';
const mode = process.argv[2] ?? 'head', file = process.argv[3] ?? 'j-2896-two-step.proof.ts';
if (!['head', 'old-two-step'].includes(mode) || !/^[a-z0-9.-]+\.(?:test|proof)\.ts$/.test(file)) throw Error('mode/file');
const own = ['tests/j-2896-two-step.proof.ts', 'scripts/j-review-2896-two-step.mjs', 'scripts/j-2896-focal.mjs', 'docs/reviews/j-2896-focal-2026-11-07.md', 'docs/reviews/j-2896-focal-2026-11-07.output.txt'];
const changed = execFileSync('git', ['diff', '--name-only', target, '--'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (changed.some(p => !own.includes(p))) throw Error('source differs from exact reviewed target');
const require = createRequire(import.meta.url), undici = require.resolve('undici');
if (createRequire(require.resolve('@vercel/blob')).resolve('undici') !== undici) throw Error('SDK dispatcher mismatch');
const out = mkdtempSync('/dev/shm/j2896-focal-'), bundle = join(out, 'proof.cjs'), launch = join(out, 'launch.cjs');
const observer = { name: 'j-memory-observer', setup(b) {
  b.onLoad({ filter: /lib\/redis-memory\.ts$/ }, args => {
    let s = readFileSync(args.path, 'utf8');
    const needle = 'run(command: (string | number)[]): unknown {';
    if (!s.includes(needle)) throw Error('run signature');
    s = s.replace(needle, needle + '\n if (++(globalThis as unknown as {__jRun:number}).__jRun > 20000) throw Error("REVIEW_RUN_LIMIT");');
    return { contents: s, loader: 'ts' };
  });
  if (mode === 'old-two-step') b.onLoad({ filter: /lib\/two-step\.ts$/ }, () => ({ contents: execFileSync('git', ['show', 'f0399d650199a825ab5c07dc0b8684f582469d0d:lib/two-step.ts'], { cwd: root, encoding: 'utf8' }), loader: 'ts' }));
} };
await build({ entryPoints: [join(here, file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', alias: testAliases(file.endsWith('.proof.ts') ? 'r24-two-step-exact.test.ts' : file, root, here), plugins: [observer] });
writeFileSync(launch, `const assert=require('node:assert/strict');let attempts=0;const no=()=>{attempts++;throw Error('REVIEW_NETWORK_BLOCKED')};require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;for(const p of ['node:http','node:https']){require(p).request=require(p).get=no}const u=require(${JSON.stringify(undici)}),agent=new u.MockAgent();agent.disableNetConnect();u.setGlobalDispatcher(agent);globalThis.__jRun=0;globalThis.__jFetch=0;let mockFetch=async()=>{throw Error('REVIEW_FETCH_BLOCKED')};Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return async(...args)=>{if(++globalThis.__jFetch>500)throw Error('REVIEW_MOCK_LIMIT');return mockFetch(...args)}},set(fn){mockFetch=fn}});process.on('exit',()=>{console.log('J_COUNTS',JSON.stringify({run:globalThis.__jRun,mockFetch:globalThis.__jFetch,attempts}));assert.equal(attempts,0)});(async()=>{assert.throws(()=>require('node:net').connect(443,'unregistered.invalid'),/REVIEW_NETWORK_BLOCKED/);await assert.rejects(()=>u.fetch('https://unregistered.invalid/'),e=>e?.cause?.code==='UND_MOCK_ERR_MOCK_NOT_MATCHED');await assert.rejects(()=>fetch('https://unregistered.invalid/'),/REVIEW_FETCH_BLOCKED/);attempts=0;globalThis.__jFetch=0;globalThis.__j2896NetworkGuard=true;console.log('SDK_SOCKET_FETCH_NEGATIVES_PASS_BEFORE_GRAPH');require(${JSON.stringify(bundle)});})().catch(e=>{console.error(e);process.exitCode=1});`);
const env = testEnvironment({ ...process.env, TMPDIR: '/dev/shm' });
for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_|PAYPAL_|BLOB_|R2_|S3_)/.test(key)) delete env[key];
env.NIMBUS_DATA_KEY = 'tests-only-not-a-real-deployment-secret';
console.log('J_FOCAL', mode, file, 'EXACT_TARGET', target);
const r = spawnSync(process.execPath, ['--max-old-space-size=512', launch], { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 262144 });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); console.log('J_CHILD_EXIT', r.status);
if (r.error) throw r.error;
process.exitCode = r.status ?? 2;
