import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testAliases } from '../../tests/test-config.mjs';

const root = resolve(import.meta.dirname, '../..');
const selected = process.argv.slice(2);
const files = selected.length ? selected : ['e2-a3-read-evidence.proof.ts'];
const directory = mkdtempSync(join(tmpdir(), 'e2-a3-read-evidence-'));
let failed = false;
try {
  for (const file of files) {
    if (!/^[a-zA-Z0-9.-]+\.(?:test|proof)\.ts$/.test(file)) throw new Error('expected a test filename');
    const bundle = join(directory, file + '.cjs');
    await build({
      entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs',
      outfile: bundle, logLevel: 'error', alias: {
        ...testAliases(file, root, join(root, 'tests')),
        'next/headers': join(root, 'tests/security/next-headers.ts'),
      },
    });
    const result = spawnSync(process.execPath, [bundle], { cwd: root, stdio: 'inherit', timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
    rmSync(bundle, { force: true });
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
