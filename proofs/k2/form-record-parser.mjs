/** Select real source files from a frozen checkout; only CSV authentication is a virtual fixture. */
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
const alias = testAliases('k-form-record-parser.proof.ts', sourceRoot, join(sourceRoot, 'tests'));
for (const path of ['lib/forms.ts', 'lib/form-sensitive.ts', 'lib/form-store.ts', 'lib/store-export.ts', 'app/api/store/forms/export/route.ts']) {
  const bytes = readFileSync(join(sourceRoot, path));
  console.log('FORM_RECORD_SOURCE', path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
}
const temp = mkdtempSync(join(tmpdir(), 'k2-form-record-'));
try {
  const outfile = join(temp, 'proof.cjs');
  await require('esbuild').build({
    entryPoints: [join(evidenceRoot, 'tests/k-form-record-parser.proof.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', alias, logLevel: 'error',
    plugins: [{ name: 'k2-form-record-export-owner', setup(build) {
      build.onResolve({ filter: /^@\/lib\/studio-route$/ }, args => ({ path: args.path, namespace: 'k2-form-record' }));
      build.onLoad({ filter: /.*/, namespace: 'k2-form-record' }, () => ({ loader: 'js', contents: `
        export async function creatorFrom(_request, permission) {
          const boundary = globalThis.__k2FormRecord;
          if (!boundary) throw new Error('Synthetic export owner boundary is missing');
          boundary.calls++; boundary.permission = permission;
          return { store: boundary.store };
        }
      ` }));
    } }],
  });
  const result = spawnSync(process.execPath, [outfile], {
    cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL',
  });
  if (result.error) console.error('FORM_RECORD_EXECUTION_FAILURE', result.error.message);
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
