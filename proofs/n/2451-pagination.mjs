/** Evidence archive only. Run against an independently checked-out RED/final ref. */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(process.argv[2] || process.cwd());
const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'n2451-pagination-'));
try {
  const out = join(temp, 'case.cjs');
  await build({
    stdin: {
      contents: `import {store} from ${JSON.stringify(join(root, 'tests/redis-stub.ts'))};
let n=0; const real=store.pipeline.bind(store); store.pipeline=async commands=>{if(n+commands.length>20000)throw Error('N2451 synthetic command ceiling');n+=commands.length;return real(commands)};
process.on('beforeExit',()=>console.log('N2451_COMMANDS',n));
void import(${JSON.stringify(join(root, 'tests/email-platform-target-evidence.test.ts'))});`,
      resolveDir: root, sourcefile: 'n2451-entry.ts', loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: out,
    alias: testAliases('email-platform-target-evidence.test.ts', root, join(root, 'tests')),
    nodePaths: [join(root, 'node_modules')],
    banner: { js: "globalThis.fetch=async()=>{throw Error('External network forbidden')};" },
  });
  const run = spawnSync(process.execPath, ['--max-old-space-size=512', out], {
    cwd: root, env: testEnvironment({ ...process.env, NIMBUS_DATA_KEY: 'tests-only-not-a-real-deployment-secret' }),
    encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024,
  });
  if (run.error) throw run.error;
  const log = (run.stdout || '') + (run.stderr || '');
  if (Buffer.byteLength(log) > 256 * 1024) throw Error('N2451 log ceiling');
  process.stdout.write(log);
  process.exitCode = run.status === 0 ? 0 : 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
