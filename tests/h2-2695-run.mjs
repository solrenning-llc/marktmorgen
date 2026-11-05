import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from './test-config.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(join(tmpdir(), 'h2-blog-proof-'));
try {
 const file = 'h2-2695-metadata.proof.ts', bundle = join(output, 'test.cjs');
 await build({ entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, alias: testAliases(file, root, join(root, 'tests')), logLevel: 'error' });
 const result = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), stdio: 'inherit' });
 if (result.error) throw result.error;
 process.exitCode = result.status ?? 1;
} finally { rmSync(output, { recursive: true, force: true }); }
