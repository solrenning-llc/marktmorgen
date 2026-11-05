import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testAliases, testEnvironment } from './test-config.mjs';
const root = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'i2-community-review-'));
try {
  const outfile = join(directory, 'proof.cjs');
  await build({ entryPoints: [join(root, 'tests/review-i2-community-recipient-evidence.test.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', alias: testAliases('community-mail-read-evidence.test.ts', root, join(root, 'tests')) });
  const result = spawnSync(process.execPath, [outfile], { cwd: root, env: testEnvironment(process.env), stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
