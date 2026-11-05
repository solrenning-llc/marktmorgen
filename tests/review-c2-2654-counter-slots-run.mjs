import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from './test-config.mjs';
const here = dirname(fileURLToPath(import.meta.url)), proofRoot = dirname(here);
const productRoot = process.argv[2] ? resolve(process.argv[2]) : proofRoot;
const file = 'review-c2-2654-counter-slots.proof.ts';
const temporary = mkdtempSync('/tmp/c2-2654-slots-');
try {
  const outfile = join(temporary, 'proof.cjs');
  await build({ entryPoints: [join(here, file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases('number-gates-a.test.ts', productRoot, here), logLevel: 'silent' });
  const result = spawnSync(process.execPath, [outfile], { cwd: productRoot, env: testEnvironment(process.env), stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true }); }
