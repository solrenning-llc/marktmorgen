import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), sourceRoot = resolve(process.argv[2] ?? ownRoot);
const featureRed = resolve(process.argv[3] ?? join(sourceRoot, '../review-3016-red-feature'));
const sitemapRed = resolve(process.argv[4] ?? join(sourceRoot, '../review-3016-red-sitemap'));
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
for (const [path, expected] of [['lib/community-about.ts', '8e6422e9e8358190112bd15c90078a9aeb964005'], ['tests/sk1-community-about.test.ts', 'b5e561112108f68697b03c76930fbd7c80000859'], ['tests/sk1-sitemap-link.test.ts', 'fcb1d80af20be3ea5bde8fdc4cde9b183e405fa7']]) assert.equal(blob(readFileSync(join(sourceRoot, path))), expected, path);
assert.equal(blob(readFileSync(join(featureRed, 'tests/sk1-community-about.test.ts'))), '4fde95877f715237a508a2e606c5f95922be2323');
assert.equal(existsSync(join(featureRed, 'lib/community-about.ts')), false);
assert.equal(blob(readFileSync(join(sitemapRed, 'tests/sk1-sitemap-link.test.ts'))), 'fcb1d80af20be3ea5bde8fdc4cde9b183e405fa7');
const require = createRequire(join(sourceRoot, 'package.json')), { build } = require('esbuild');
const temp = mkdtempSync(join(tmpdir(), 'k2-review-3016-')), deadline = Date.now() + 120_000;
let logs = 0, reserved = 0;
function run(label, bundle, root, cap, expected) {
  if (reserved + cap > 16000) throw Error('First-dimension aggregate command admission exceeded'); reserved += cap;
  const result = spawnSync(process.execPath, [bundle], { cwd: root, env: { ...process.env, DEMO_STUDIO_ADMIN: 'operator@example.test', STRIPE_DEMO_ACCOUNT_ID: 'acct_fixtureDemo', NIMBUS_DATA_KEY: process.env.NIMBUS_DATA_KEY ?? 'tests-only-not-a-real-deployment-secret' }, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  const text = (result.stdout ?? '') + (result.stderr ?? ''); logs += Buffer.byteLength(text);
  if (logs > 128 * 1024) throw Error('Combined log admission exceeded');
  console.log(`\n=== ${label} ===\n${text}`);
  assert.equal(result.status, expected, label); return text;
}
async function compile(root, file, outfile, bounded = true) {
  const { testAliases } = await import(pathToFileURL(join(root, 'tests/test-config.mjs')));
  const entry = `import{store}from'./tests/redis-stub';const native=store.pipeline.bind(store);let commands=0;store.pipeline=async batch=>{if(commands+batch.length>2000)throw Error('Author group command admission exceeded');commands+=batch.length;return native(batch)};globalThis.fetch=async()=>{throw Error('External network forbidden')};process.on('exit',()=>console.log('AUTHOR_GROUP_COMMANDS',commands));void import('./tests/${file}');`;
  return build({ ...(bounded ? { stdin: { contents: entry, resolveDir: root, sourcefile: 'bounded-author-entry.ts', loader: 'ts' } } : { entryPoints: [join(root, 'tests', file)] }), outfile, bundle: true, platform: 'node', format: 'cjs', nodePaths: [join(root, 'node_modules')], alias: testAliases(file, root, join(root, 'tests')), tsconfig: join(root, 'tsconfig.json'), logLevel: 'silent' });
}
try {
  let compileFailed = false;
  try { await compile(featureRed, 'sk1-community-about.test.ts', join(temp, 'feature-red.cjs'), false); }
  catch (error) {
    const messages = error.errors?.map(item => item.text) ?? [String(error)];
    assert.ok(messages.some(text => /Could not resolve.*community-about/.test(text)), 'The real new-feature RED must fail for the absent module');
    console.log('ORIGINAL_FEATURE_RED_COMPILE', JSON.stringify({ testBlob: '4fde95877f715237a508a2e606c5f95922be2323', diagnostics: messages, runtimeAssertionsExecuted: 0 })); compileFailed = true;
  }
  assert.equal(compileFailed, true);
  const groups = [
    { root: sourceRoot, file: 'sk1-community-about.test.ts', label: 'final author About assertions', status: 0 },
    { root: sitemapRed, file: 'sk1-sitemap-link.test.ts', label: 'exact author sitemap RED', status: 1 },
    { root: sourceRoot, file: 'sk1-sitemap-link.test.ts', label: 'same author sitemap final', status: 0 },
  ];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i], bundle = join(temp, `author-${i}.cjs`); await compile(g.root, g.file, bundle);
    const output = run(g.label, bundle, g.root, 2000, g.status);
    if (g.status === 0) assert.match(output, /checks, all passing/); else assert.match(output, /FAIL|TypeError/);
  }
  const file = 'k-review-3016-public-about.proof.ts', bundle = join(temp, 'own.cjs');
  const { testAliases } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
  await build({ entryPoints: [join(ownRoot, 'tests', file)], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', nodePaths: [join(sourceRoot, 'node_modules')], alias: testAliases(file, sourceRoot, join(sourceRoot, 'tests')), tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'silent' });
  const output = run('independent eight-case public privacy/veracity/bounds proof', bundle, sourceRoot, 10000, 1); assert.match(output, /checks, 4 failing/);
  console.log('REVIEW_ADMISSION', JSON.stringify({ reservedCommands: reserved, maxCommands: 16000, logBytes: logs, maxLogBytes: 128 * 1024, timeoutMs: 120000 }));
} finally { rmSync(temp, { recursive: true, force: true }); }
