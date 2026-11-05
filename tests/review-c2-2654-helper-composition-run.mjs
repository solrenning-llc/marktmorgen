import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from './test-config.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const productRoot = process.argv[2] ? resolve(process.argv[2]) : dirname(here);
const temporary = mkdtempSync('/tmp/c2-2654-composition-');
const helper = readFileSync(join(here, 'review-c2-2654-proposed-helper.fixture.ts'), 'utf8');
try {
  const outfile = join(temporary, 'proof.cjs');
  await build({ entryPoints: [join(here, 'review-c2-2654-counter-slots.proof.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases('number-gates-a.test.ts', productRoot, here), plugins: [{ name: 'proposed-helper-only', setup(build) { build.onLoad({ filter: /lib\/redis-reply\.ts$/ }, () => ({ contents: helper, loader: 'ts' })); } }], logLevel: 'silent' });
  console.log('CONDITIONAL COMPOSITION ONLY: proposed helper f01e99d5; this does not approve the unmodified product head.');
  const result = spawnSync(process.execPath, [outfile], { cwd: productRoot, env: testEnvironment(process.env), stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true }); }
