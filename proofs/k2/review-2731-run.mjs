import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'k2-2731-'));
const ref = process.argv[2];
const files = process.argv.slice(3);
let failed = 0;
try {
  let source;
  if (ref && ref !== 'HEAD') {
    source = join(temp, 'waitlist-tokens.ts');
    writeFileSync(source, execFileSync('git', ['show', `${ref}:lib/waitlist-tokens.ts`], { cwd: root }));
  }
  for (const file of files.length ? files : ['proofs/k2/review-2731-grant.proof.ts']) {
    const name = file.split('/').at(-1);
    const alias = testAliases(name, root, join(root, 'tests'));
    if (source) alias['@/lib/waitlist-tokens'] = source;
    const outfile = join(temp, name + '.cjs');
    await build({ entryPoints: [join(root, file)], outfile, bundle: true, platform: 'node', format: 'cjs', alias, logLevel: 'error' });
    const run = spawnSync(process.execPath, [outfile], { cwd: root, env: testEnvironment(process.env), stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
