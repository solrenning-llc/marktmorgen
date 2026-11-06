import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(process.env.C2_REVIEW_REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const own = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { build } = createRequire(join(own, 'package.json'))('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, 'tests/test-config.mjs')));
const out = mkdtempSync(join(tmpdir(), 'c2-2963-'));
const files = process.argv.includes('--release-only') ? ['preorder-release-exact.test.ts'] : process.argv.includes('--author') ? ['preorder-release-exact.test.ts', 'preorder-soon-exact.test.ts'] : process.argv.includes('--linked') ? ['preorders.test.ts', 'waitlist.test.ts', 'preorder-email-copy.test.ts'] : ['c2-2963-preorder-release.proof.ts'];
try {
  let failed = false;
  for (const name of files) {
    const outfile = join(out, name + '.cjs');
    const aliases = testAliases(name, root, join(root, 'tests'));
    // The relative proof import and the selected source must share one MemoryRedis instance.
    if (name.endsWith('.proof.ts')) aliases['@/lib/redis'] = join(own, 'tests/redis-stub.ts');
    await build({ entryPoints: [join(name.endsWith('.proof.ts') ? own : root, 'tests', name)], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error', alias: aliases, nodePaths: [join(own, 'node_modules')], banner: { js: 'globalThis.fetch = async () => { throw new Error("External network forbidden in C2 review"); };' } });
    const r = spawnSync(process.execPath, [outfile], { cwd: root, env: testEnvironment(process.env), encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 });
    console.log(`FILE ${name}`); process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
    console.log(`EXIT ${r.status}; SIGNAL ${r.signal}`); if (r.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(out, { recursive: true }); }
