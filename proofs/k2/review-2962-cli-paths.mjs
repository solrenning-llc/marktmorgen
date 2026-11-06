import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), sourceRoot = resolve(process.argv[2] ?? ownRoot);
const blob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
for (const [path, expected] of [['cli/marktmorgen.mjs', '11884fee8e261141996bec28949c7b8cfe9b354a'], ['tests/cli-entry.test.ts', '6462e4a2ec0298b5b6d4ca39ca34039c6eb5a324'], ['tests/cli.test.ts', 'c5c5cbc56c07fc6fdd39f60cdc93d65702c653f3']]) assert.equal(blob(readFileSync(join(sourceRoot, path))), expected, path);
const require = createRequire(join(sourceRoot, 'package.json')), { build } = require('esbuild');
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, 'tests/test-config.mjs')));
const temp = mkdtempSync(join(tmpdir(), 'k2-review-2962-')), deadline = Date.now() + 120_000;
const baselineOnly = process.argv[3] === '--linked-baseline-only';
// Recovery carries the already recorded 23 test children; it launches only child 24.
let subprocesses = baselineOnly ? 23 : 0, currentSubprocesses = 0, printed = 0;
function run(label, args, cwd, expected, reserve = 1, env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }) {
  if (subprocesses + reserve > 24) throw Error('Twenty-four test subprocess admission exceeded');
  subprocesses += reserve;
  currentSubprocesses += reserve;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? ''); printed += Buffer.byteLength(output);
  if (printed > 128 * 1024) throw Error('Combined log admission exceeded');
  console.log(`\n=== ${label} ===\n${output}`);
  if (expected !== undefined) assert.equal(result.status, expected, label);
  return { ...result, output };
}
try {
  const preimage = execFileSync('git', ['show', '4f8cc43514505ff4db6c14dbbc441d8da0efc6db:cli/marktmorgen.mjs'], { cwd: sourceRoot, timeout: 120_000 });
  assert.equal(blob(preimage), '81b00a4ea3d252fceeff1aee15e0841749cb0baf');
  if (!baselineOnly) {
  const prelude = join(temp, 'bound-author.cjs');
  writeFileSync(prelude, `const cp=require('node:child_process'),native=cp.spawnSync;let used=0;const deadline=${deadline};cp.spawnSync=(file,args,options={})=>{if(used+1>10)throw Error('Ten author CLI children exceeded');used++;return native(file,args,{...options,timeout:Math.max(1,deadline-Date.now()),maxBuffer:128*1024})};globalThis.fetch=async()=>{throw Error('External IO forbidden')};process.on('exit',()=>console.log('AUTHOR_CLI_CHILDREN_USED',used));\n`);
  const author = join(temp, 'author.cjs');
  await build({ entryPoints: [join(sourceRoot, 'tests/cli-entry.test.ts')], outfile: author, bundle: true, platform: 'node', format: 'cjs', alias: testAliases('cli-entry.test.ts', sourceRoot, join(sourceRoot, 'tests')), tsconfig: join(sourceRoot, 'tsconfig.json'), logLevel: 'error' });
  for (const variant of ['red', 'green']) {
    const cwd = join(temp, variant); mkdirSync(join(cwd, 'cli'), { recursive: true });
    if (variant === 'red') writeFileSync(join(cwd, 'cli/marktmorgen.mjs'), preimage); else copyFileSync(join(sourceRoot, 'cli/marktmorgen.mjs'), join(cwd, 'cli/marktmorgen.mjs'));
    const output = run(`same author twenty assertions: ${variant}`, ['--require', prelude, author], cwd, variant === 'red' ? 1 : 0, 11).output;
    assert.match(output, /AUTHOR_CLI_CHILDREN_USED 10/);
    assert.match(output, variant === 'red' ? /20 checks, \d+ failing/ : /20 checks, all passing/);
  }
  }
  const entry = `import{store}from'./tests/redis-stub';const native=store.pipeline.bind(store);let commands=0,requests=0;store.pipeline=async batch=>{if(commands+batch.length>5000)throw Error('Five thousand synthetic commands exceeded');commands+=batch.length;return native(batch)};const NativeRequest=globalThis.Request;globalThis.Request=class extends NativeRequest{constructor(input,init){if(requests+1>8)throw Error('Eight synthetic requests exceeded');const body=init?.body;if(body!==undefined&&(typeof body!=='string'||Buffer.byteLength(body)>4096))throw Error('Four KiB synthetic body admission exceeded');requests++;super(input,init)}};process.on('exit',()=>console.log('LINKED_CLI_ADMISSION',JSON.stringify({commands,requests})));void import('./tests/cli.test.ts');`;
  for (const variant of baselineOnly ? ['red'] : ['green', 'red']) {
    const linked = join(temp, `linked-${variant}.cjs`);
    const plugins = variant === 'red' ? [{ name: 'exact-cli-preimage-only', setup(build) { build.onLoad({ filter: /marktmorgen\.mjs$/ }, args => resolve(args.path) === join(sourceRoot, 'cli/marktmorgen.mjs') ? { contents: preimage.toString('utf8'), loader: 'js', resolveDir: dirname(args.path) } : undefined); } }] : [];
    await build({ stdin: { contents: entry, resolveDir: sourceRoot, sourcefile: 'bounded-cli-related.ts', loader: 'ts' }, outfile: linked, bundle: true, platform: 'node', format: 'cjs', alias: testAliases('cli.test.ts', sourceRoot, join(sourceRoot, 'tests')), tsconfig: join(sourceRoot, 'tsconfig.json'), plugins, logLevel: 'error' });
    const output = run(`unchanged related real CLI/MCP contract: ${variant}`, [linked], sourceRoot, 1, 1, testEnvironment(process.env)).output;
    assert.match(output, /TypeError: Cannot read properties of undefined \(reading 'tools'\)/);
    assert.match(output, /LINKED_CLI_ADMISSION \{"commands":16,"requests":1\}/);
  }
  // No subprocess remains for the prepared independent importer control.
  assert.equal(subprocesses, 24); console.log('REVIEW_CLI_TOTAL', JSON.stringify({ subprocesses, currentSubprocesses, priorSubprocesses: baselineOnly ? 23 : 0, adversarialExecuted: false, logBytes: printed, maxLogBytes: 128 * 1024, timeoutMs: 120000 }));
} finally { rmSync(temp, { recursive: true, force: true }); }
