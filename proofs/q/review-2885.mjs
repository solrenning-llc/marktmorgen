import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'q-2885-'));
const parentFlag = process.argv.indexOf('--parent-source');
const parent = parentFlag >= 0 ? resolve(process.argv[parentFlag + 1]) : null;
const group = process.argv.includes('--author') ? 'author' : process.argv.includes('--linked') ? 'linked' : 'proof';
const linked = ['path-growth-record.test.ts', 'path-reminder.test.ts', 'path-return-record.test.ts', 'path-board.test.ts', 'path-concurrency.test.ts', 'path-studio-reminder.test.ts', 'path-facts.test.ts', 'path-wording-source.test.ts', 'plan-cost-registry.test.ts'];
const fileFlag = process.argv.indexOf('--file');
const files = fileFlag >= 0 ? [process.argv[fileFlag + 1]] : group === 'author' ? ['path-read-exact.test.ts'] : group === 'linked' ? linked : ['q-2885-path.proof.ts'];
let failed = 0;
try {
  for (const file of files) {
    const aliases = testAliases(file, root, join(root, 'tests'));
    if (parent) aliases['@/lib/path'] = parent;
    const outfile = join(temp, file + '.cjs');
    await build({ entryPoints: [join(root, 'tests', file)], bundle: true, platform: 'node', format: 'cjs', outfile, alias: aliases, logLevel: 'error', banner: { js: 'globalThis.fetch = async () => { throw new Error("Q2885: external network is forbidden"); };' } });
    const run = spawnSync(process.execPath, [outfile], { cwd: root, encoding: 'utf8', env: testEnvironment(process.env), timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    console.log(JSON.stringify({ file, mode: parent ? 'parent-path' : 'head', status: run.status, signal: run.signal }));
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    if (run.error) console.error(run.error.message);
    if (run.status !== 0) failed++;
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(JSON.stringify({ group, files: files.length, failed }));
process.exitCode = failed ? 1 : 0;
