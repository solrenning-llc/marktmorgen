import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'e2-2671-cost-wording-'));
try {
  const output = join(temporary, 'proof.cjs');
  await build({ entryPoints: [join(root, 'tests/e2-review-2671-cost-wording.proof.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'error' });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
