/** Execute this evidence against an explicitly selected source checkout, without changing global aliases. */
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
const file = 'k-form-identity-read.proof.ts';
const alias = testAliases(file, sourceRoot, join(sourceRoot, 'tests'));
for (const path of ['lib/form-store.ts', 'app/api/store/forms/route.ts', 'lib/forms.ts', 'lib/form-sensitive.ts']) {
  const bytes = readFileSync(join(sourceRoot, path));
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  console.log('FORM_IDENTITY_SOURCE', path, sha);
}
const temp = mkdtempSync(join(tmpdir(), 'k2-form-identity-'));
try {
  const outfile = join(temp, 'proof.cjs');
  await require('esbuild').build({
    entryPoints: [join(evidenceRoot, 'tests', file)], outfile, bundle: true,
    platform: 'node', format: 'cjs', alias, logLevel: 'error',
    plugins: [{
      name: 'k2-form-identity-owner-boundary',
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/(?:store-request|store)$/ }, args => ({ path: args.path, namespace: 'k2-form-identity' }));
        build.onLoad({ filter: /.*/, namespace: 'k2-form-identity' }, () => ({ loader: 'js', contents: `
          export async function guardStoreWrite(_request, permission) {
            const state = globalThis.__k2FormIdentity;
            if (!state) throw new Error('Synthetic owner boundary is missing');
            state.guardCalls++;
            state.permission = permission;
            return { ok: true, body: state.body, store: state.shop, ref: 'synthetic-owner@example.com' };
          }
          export function text(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
          export async function setSitePages() { throw new Error('Unexpected creation of store stats'); }
        ` }));
      },
    }],
  });
  const result = spawnSync(process.execPath, [outfile], { cwd: sourceRoot, env: testEnvironment(process.env), stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
