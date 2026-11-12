import { build } from 'esbuild';
import { testAliases, testEnvironment } from './test-config.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = mkdtempSync(join(tmpdir(), 'g-2681-proof-'));
try {
  for (const [index, filename] of process.argv.slice(2).entries()) {
    const output = join(outputDir, `${index}.cjs`);
    await build({ entryPoints: [resolve(root, 'tests', filename)], bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'error', alias: testAliases(filename, root, resolve(root, 'tests')) });
    const result = spawnSync(process.execPath, [output], { cwd: root, env: testEnvironment(process.env), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    console.log(`=== ${filename} ===\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
