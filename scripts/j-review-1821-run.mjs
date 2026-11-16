import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd(), out = mkdtempSync(join(tmpdir(), 'j2764-partial-'));
let failed = false;
try {
  for (const [file, canonical] of [
    ['j-1821-paid-read.proof.ts', 'mcp-store-pages-cost.test.ts'],
  ]) {
    const bundle = join(out, `${file}.cjs`);
    await build({ entryPoints: [join(root, 'tests', file)], bundle: true,
      platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
      alias: testAliases(canonical, root, join(root, 'tests')) });
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, [bundle], {
      stdio: 'inherit', env: testEnvironment(process.env),
    });
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(out, { recursive: true, force: true }); }
