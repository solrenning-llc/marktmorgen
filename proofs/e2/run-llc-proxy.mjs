import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const out = mkdtempSync(join(tmpdir(), 'e2-llc-proxy-'));
try {
  const bundle = join(out, 'proof.cjs');
  await build({ entryPoints: [join(root, 'tests/e2-llc-proxy-completeness.proof.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error' });
  const result = spawnSync(process.execPath, [bundle], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
