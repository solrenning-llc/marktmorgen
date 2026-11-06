/** Select exact source checkout; retain the evidence cases and expectations unchanged. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(process.argv[2] ?? evidenceRoot);
const require = createRequire(join(sourceRoot, 'package.json'));
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const file = 'k-2880-note-funnel.proof.ts';
for (const path of ['app/api/store/funnel-share/route.ts', 'lib/funnel-bundle-store.ts', 'lib/page-funnel-store.ts', 'lib/form-store.ts']) {
  const bytes = readFileSync(join(sourceRoot, path));
  console.log('SOURCE', path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
}
const temp = mkdtempSync(join(tmpdir(), 'k2-2880-'));
try {
  const outfile = join(temp, 'proof.cjs');
  await require('esbuild').build({ entryPoints: [join(evidenceRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, sourceRoot, join(sourceRoot, 'tests')), logLevel: 'error' });
  const result = spawnSync(process.execPath, [outfile], { cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
