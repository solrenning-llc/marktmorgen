import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(process.argv[2] ?? ownRoot);
const require = createRequire(join(sourceRoot, 'package.json'));
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'k2-opportunity-admission-'));
const deadline = Date.now() + 120_000;
const timer = setTimeout(() => { console.error('The opportunity admission proof exceeded 120 seconds'); process.exit(1); }, 120_000);
timer.unref();
try {
  const file = 'k-form-opportunity-admission.proof.ts', out = join(temp, 'proof.cjs');
  await require('esbuild').build({ entryPoints: [join(ownRoot, 'tests', file)], outfile: out, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, sourceRoot, join(sourceRoot, 'tests')), logLevel: 'error' });
  const result = spawnSync(process.execPath, [out], { cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit', timeout: Math.max(1, deadline - Date.now()) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { clearTimeout(timer); rmSync(temp, { recursive: true, force: true }); }
