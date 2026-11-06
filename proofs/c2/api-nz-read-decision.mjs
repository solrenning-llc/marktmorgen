/** Explicit opt-in; proof.ts is excluded from canonical *.test.ts discovery. */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, 'tests/test-config.mjs')));
const out = mkdtempSync(join(tmpdir(), 'c2-api-leads-'));
try {
  const files = process.argv.includes('--linked') ? ['api-fields.test.ts', 'api-read-units-more.test.ts'] : ['c-api-nz-read-decision.proof.ts'];
  let failed = false;
  for (const name of files) {
    const outfile = join(out, name + '.cjs');
    await build({ entryPoints: [join(root, 'tests', name)], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error', alias: testAliases(name, root, join(root, 'tests')), banner: { js: 'globalThis.fetch = async () => { throw new Error("External network forbidden in C2 proof"); };' } });
    const result = spawnSync(process.execPath, [outfile], { cwd: root, env: testEnvironment(process.env), encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 });
    console.log(`FILE ${name}`);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) console.error(result.error);
    console.log(`EXIT ${result.status}; SIGNAL ${result.signal}`);
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(out, { recursive: true }); }
