// Runs the second money review's proof of #2921 (CX-116, tests/c3-2921-rebuild.proof.ts, kept byte-identical) and judges
// only its A1 checks: the parts named "P1a" and "P1b" (a persistently failing build must not be rebuilt on every visit).
// Its P2/P2b (A2, a build racing a withdrawal) and P3 (A3, lib/contacts.ts forEachContact) also fail on main and are
// out of this PR's scope: they are printed, never judged here. Usage: node tests/c3-2921-run.mjs
import { build } from 'esbuild';
import { testAliases, testEnvironment } from './test-config.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const filename = 'c3-2921-rebuild.proof.ts';
const judged = /^(P1a|P1b):/;
const outputDir = mkdtempSync(join(tmpdir(), 'c3-2921-proof-'));
try {
  const output = join(outputDir, 'proof.cjs');
  await build({ entryPoints: [resolve(root, 'tests', filename)], bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'error', alias: testAliases(filename, root, resolve(root, 'tests')) });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: testEnvironment(process.env), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  console.log(`=== ${filename} ===\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  let part = '';
  let passed = 0;
  let failed = 0;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line && !line.startsWith(' ')) part = line;
    if (!judged.test(part)) continue;
    if (line.startsWith('  ok    ')) passed += 1;
    else if (line.startsWith('  FAIL  ')) failed += 1;
  }
  // A proof that stopped before its A1 checks (a throw, a hang cut short) proves nothing: it fails too.
  const complete = passed + failed === 3;
  console.log(`A1 (P1a, P1b): ${passed + failed} checks, ${failed} failing${complete ? '' : ', expected 3 checks'}.`);
  if (failed || !complete) process.exitCode = 1;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
