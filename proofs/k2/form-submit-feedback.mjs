/** G7 RED: select frozen real product source; all service fixtures stay explicit and local. */
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
const deadline = Date.now() + 120_000;
for (const path of ['app/api/store/form/route.ts', 'app/[handle]/form/[form]/page.tsx', 'lib/form-store.ts', 'lib/forms.ts', 'lib/form-sensitive.ts', 'lib/buyer-words/form.ts']) {
  const bytes = readFileSync(join(sourceRoot, path));
  console.log('FORM_FEEDBACK_SOURCE', path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
}
console.log('FORM_FEEDBACK_BOUNDS', JSON.stringify({ postScenarios: 4, applicationCommandsPerScenario: 40, requestBytes: 4096, deadlineMs: 120_000, providerCallsAllowed: 0, pureSsrLocales: 7 }));
const temp = mkdtempSync(join(tmpdir(), 'k2-form-feedback-'));
let failures = 0;
try {
  for (const file of ['k-form-submit-feedback.test.ts', 'k-form-submit-feedback-render.test.ts']) {
    const alias = testAliases(file, sourceRoot, join(sourceRoot, 'tests'));
    // Explicit repeatability against a frozen source checkout without these two new config blocks.
    if (file === 'k-form-submit-feedback.test.ts') {
      for (const name of ['metered-limits', 'request-origin', 'request-guard', 'store', 'flows', 'store-join', 'affiliate-leads', 'page-funnel-store', 'visit']) alias['@/lib/' + name] = join(sourceRoot, 'tests/k-form-submit-world.ts');
    } else {
      const world = join(evidenceRoot, 'tests/k-form-submit-feedback-world.tsx');
      for (const name of ['next/navigation', 'next/link']) alias[name] = world;
      for (const name of ['store', 'form-store', 'catalog', 'page-funnel-store']) alias['@/lib/' + name] = world;
      for (const name of ['store-product', 'sales-blocks']) alias['@/components/' + name] = world;
    }
    const outfile = join(temp, file + '.cjs');
    await require('esbuild').build({ entryPoints: [join(evidenceRoot, 'tests', file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias, logLevel: 'error' });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('The local proof deadline was reached before dispatch');
    console.log('FORM_FEEDBACK_TEST', file);
    const result = spawnSync(process.execPath, [outfile], { cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit', timeout: remaining, killSignal: 'SIGKILL' });
    if (result.error) console.error('FORM_FEEDBACK_EXECUTION_FAILURE', result.error.message);
    if (result.status !== 0) failures++;
  }
  process.exitCode = failures ? 1 : 0;
} finally { rmSync(temp, { recursive: true, force: true }); }
