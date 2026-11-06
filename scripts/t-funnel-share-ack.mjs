/** Isolated proof runner. The only product substitution is in-memory Redis. */
import { build, version } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = join(root, 'tests');
const proof = join(here, 't-funnel-share-ack.proof.ts');
const locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/esbuild'].version;
if (version !== '0.28.2' || locked !== version) throw new Error('Use the repository-pinned esbuild 0.28.2');
const out = mkdtempSync(join(tmpdir(), 't-funnel-share-ack-'));
// Banner runs before any bundled application module initializes.
const barrier = `
let __networkAttempts = 0;
const __denyNetwork = () => { __networkAttempts++; throw new Error('Proof forbids network or subprocess operations'); };
globalThis.fetch = __denyNetwork;
globalThis.WebSocket = __denyNetwork;
for (const [name, methods] of Object.entries({
 'node:http':['request','get'], 'node:https':['request','get'],
 'node:http2':['connect'], 'node:net':['connect','createConnection'],
 'node:tls':['connect'], 'node:dgram':['createSocket'],
 'node:dns':['lookup','resolve','resolve4','resolve6'],
 'node:child_process':['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']
})) for (const method of methods) require(name)[method] = __denyNetwork;
for (const method of ['lookup','resolve','resolve4','resolve6']) require('node:dns').promises[method] = __denyNetwork;
process.on('exit', () => {
 console.log(JSON.stringify({ networkOrSubprocessAttempts: __networkAttempts }));
 if (__networkAttempts) process.exitCode = 2;
});
`;
try {
  if (process.argv.includes('--types')) {
    const config = join(out, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ extends: join(root, 'tsconfig.json'), compilerOptions: {
      incremental: false, plugins: [], baseUrl: root,
      typeRoots: [join(root, 'node_modules/@types')],
      paths: { '@/*': ['./*'] },
    }, include: [proof], exclude: [join(root, 'node_modules')] }));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', config], { cwd: root, timeout: 120_000, maxBuffer: 128 * 1024, encoding: 'utf8' });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 2;
  } else {
    const linked = process.argv.includes('--linked');
    const files = linked ? ['funnel-share.test.ts', 'funnel-starter-catalog.test.ts', 'funnel-sharing-review.test.ts'] : ['t-funnel-share-ack.proof.ts'];
    for (const file of files) {
      const outfile = join(out, `${file}.cjs`);
      const alias = testAliases(file, root, here);
      if (!linked) alias['@/lib/redis'] = proof;
      const linkedEntry = `
import { MemoryRedis } from '@/lib/redis-memory';
const original = MemoryRedis.prototype.run;
let dispatches = 0, units = 0;
MemoryRedis.prototype.run = function(command) {
 dispatches++;
 units += command[0] === 'EVAL' && String(command[1]).startsWith('-- marktmorgen:funnel-share:v1') ? 8 : 1;
 if (units > 2000) throw new Error('Linked synthetic command ceiling exceeded');
 return original.call(this, command);
};
process.on('exit', () => console.log(JSON.stringify({linkedSyntheticDispatches:dispatches, linkedUnitsIncludingShareLuaAllowance:units})));
import(${JSON.stringify(join(here, file))}).catch(error => { console.error(error); process.exitCode = 2; });
`;
      await build({ ...(linked ? { stdin: { contents: linkedEntry, resolveDir: root, sourcefile: 't-funnel-share-linked-entry.ts', loader: 'ts' } } : { entryPoints: [join(here, file)] }), bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error', alias, banner: { js: barrier } });
      const result = spawnSync(process.execPath, [outfile], { cwd: root, env: testEnvironment(process.env), timeout: 120_000, maxBuffer: 128 * 1024, encoding: 'utf8' });
      process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status ?? 2;
    }
  }
} finally { rmSync(out, { recursive: true, force: true }); }
