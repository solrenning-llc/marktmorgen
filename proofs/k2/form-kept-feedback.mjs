/** Frozen-source proof runner: real KEEP and warning renderer; only existing service edges are synthetic. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(process.argv[2] ?? evidenceRoot);
const require = createRequire(join(sourceRoot, 'package.json'));
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const alias = testAliases('k-form-kept-feedback.proof.ts', sourceRoot, join(sourceRoot, 'tests'));
for (const name of ['metered-limits', 'request-origin', 'request-guard', 'store', 'flows', 'store-join', 'affiliate-leads', 'page-funnel-store', 'visit']) alias['@/lib/' + name] = join(sourceRoot, 'tests/k-form-submit-world.ts');
for (const path of ['app/api/store/form/route.ts', 'lib/form-store.ts', 'lib/forms.ts', 'lib/form-sensitive.ts', 'components/sales-blocks.tsx', 'lib/buyer-words/form.ts', 'lib/redis-memory.ts']) {
  const bytes = readFileSync(join(sourceRoot, path));
  console.log('KEPT_FEEDBACK_SOURCE', path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
}
const temp = mkdtempSync(join(tmpdir(), 'k2-kept-feedback-'));
const deadline = Date.now() + 120_000;
try {
  const outfile = join(temp, 'proof.cjs');
  await require('esbuild').build({ entryPoints: [join(evidenceRoot, 'tests/k-form-kept-feedback.proof.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', alias, logLevel: 'error' });
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Error('The proof deadline was reached before execution');
  const result = spawnSync(process.execPath, [outfile], { cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit', timeout: remaining, killSignal: 'SIGKILL' });
  if (result.error) console.error('KEPT_FEEDBACK_EXECUTION_FAILURE', result.error.message);
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
