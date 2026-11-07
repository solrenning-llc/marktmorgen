import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from './test-config.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
const file = 'review-c2-2654-grant-evidence.proof.ts';
const temporary = mkdtempSync('/tmp/c2-2654-grant-');
try {
  const outfile = join(temporary, 'proof.cjs');
  await build({ entryPoints: [join(here, file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, root, here), logLevel: 'silent' });
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], { cwd: root, env: testEnvironment(process.env), stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true }); }
