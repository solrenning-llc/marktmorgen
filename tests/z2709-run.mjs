import { build } from 'esbuild';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from './test-config.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || join(here, '..'));
const files = process.argv.slice(3);
const folder = mkdtempSync(join(tmpdir(), 'z2709-'));
try {
  for (const file of files.length ? files : ['z2709-month-read.proof.ts']) {
    const product = file.startsWith('product:');
    const name = product ? file.slice(8) : file;
    const source = product ? join(root, 'tests') : here;
    const out = join(folder, name + '.cjs');
    await build({ entryPoints: [join(source, name)], bundle: true, platform: 'node', format: 'cjs', outfile: out,
      alias: testAliases(name, root, source), logLevel: 'error' });
    const run = spawnSync(process.execPath, [out], { cwd: root, stdio: 'inherit', env: testEnvironment(process.env) });
    if (run.status !== 0) process.exitCode = run.status ?? 1;
  }
} finally { rmSync(folder, { recursive: true, force: true }); }
