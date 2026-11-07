import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
const root = resolve(import.meta.dirname, '..');
const target = '8dd37f9493844cc6c9aaaba849f3c029febd09bd';
const old = '84ebcee21225e2b736fecbfb6c77668b4bb725fb';
const mode = process.argv[2] ?? 'head';
const file = process.argv[3] ?? 'j-3034-mcp-funded.proof.ts';
const files = ['j-3034-mcp-funded.proof.ts', 'j-3034-mcp-http-focal.proof.ts', 'broadcasts-read-cost-mcp.test.ts', 'api-events-measured.test.ts', 'plan-cost-registry.test.ts', 'broadcasts-read-cost-email-page.test.ts', 'broadcasts-read-cost-path-growth.test.ts'];
if (!['head', 'old-cost-graph'].includes(mode) || !files.includes(file)) throw Error('scope');
const own = ['tests/j-3034-mcp-admission.proof.ts', 'scripts/j-3034-mcp-admission.mjs', 'tests/j-3034-mcp-funded.proof.ts', 'scripts/j-3034-mcp-funded.mjs', 'scripts/j-3034-mcp-types.mjs', 'tests/j-3034-mcp-http-focal.proof.ts', 'docs/reviews/j-3034-mcp-funded-2026-11-07.md', 'docs/reviews/j-3034-mcp-funded-2026-11-07.output.txt'];
const changed = execFileSync('git', ['diff', '--name-only', target, '--'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (changed.some(p => !own.includes(p))) throw Error('not exact corrective graph');
const blocked = `const a=require('node:assert/strict');const no=()=>{throw Error('REVIEW_NETWORK_BLOCKED')};require('node:net').Socket.prototype.connect=no;require('node:tls').connect=no;for(const p of ['node:http','node:https'])require(p).request=require(p).get=no;globalThis.fetch=no;a.throws(()=>fetch('https://example.invalid'),/REVIEW_NETWORK_BLOCKED/);a.throws(()=>require('node:net').connect(443,'example.invalid'),/REVIEW_NETWORK_BLOCKED/);globalThis.__jRun=0;console.log('NETWORK_NEGATIVE_CONTROLS_PASS_BEFORE_GRAPH');process.on('exit',()=>console.log('MEMORY_REDIS_RUN',globalThis.__jRun));`;
const oldPaths = ['lib/broadcasts.ts', 'lib/mcp-tools.ts', 'lib/api-read-rules.ts'];
const plugin = { name: 'j-funded-boundary', setup(b) {
  b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
    const relative = args.path.startsWith(root + '/') ? args.path.slice(root.length + 1) : '';
    let contents;
    if (mode === 'old-cost-graph' && oldPaths.includes(relative)) contents = execFileSync('git', ['show', old + ':' + relative], { cwd: root, encoding: 'utf8' });
    else if (relative === 'lib/redis-memory.ts') contents = readFileSync(args.path, 'utf8');
    else return;
    if (relative === 'lib/redis-memory.ts') {
      const needle = 'run(command: (string | number)[]): unknown {';
      if (!contents.includes(needle)) throw Error('memory run anchor');
      contents = contents.replace(needle, needle + '\n if (++(globalThis as unknown as {__jRun:number}).__jRun > 10000) throw Error("REVIEW_RUN_LIMIT_BEFORE_DISPATCH");');
    }
    return { contents, loader: relative.endsWith('tsx') ? 'tsx' : 'ts' };
  });
} };
const aliasFile = file === 'j-3034-mcp-funded.proof.ts' ? 'broadcasts-read-cost-mcp.test.ts' : file;
const out = mkdtempSync('/dev/shm/j3034-funded-'), bundle = join(out, 'proof.cjs');
const built = await build({ entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, alias: testAliases(aliasFile, root, join(root, 'tests')), plugins: [plugin], banner: { js: blocked }, metafile: true, logLevel: 'error' });
writeFileSync('/tmp/j3034-8dd37-' + mode + '-' + file + '.meta.json', JSON.stringify(built.metafile));
console.log('J_FUNDED_TARGET', target, 'MODE', mode, 'FILE', file);
const r = spawnSync(process.execPath, ['--max-old-space-size=512', bundle], { cwd: root, env: testEnvironment({ ...process.env, TMPDIR: '/dev/shm' }), encoding: 'utf8', timeout: 120000, maxBuffer: 262144 });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); console.log('J_CHILD_EXIT', r.status);
if (r.error) throw r.error;
process.exitCode = r.status ?? 2;
