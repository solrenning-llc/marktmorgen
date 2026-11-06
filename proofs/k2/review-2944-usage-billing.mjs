/** Three bounded directed replay groups, then eight independent cases; no native network or productive account. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), independentOnly = args.includes('--independent-only');
const root = resolve(args.find(value => !value.startsWith('--')) ?? evidenceRoot), here = join(root, 'tests');
const require = createRequire(join(root, 'package.json'));
const { testAliases, testEnvironment } = await import(pathToFileURL(join(here, 'test-config.mjs')));
const deadline = Date.now() + 120_000, logLimit = 128 * 1024;
let emitted = 0;
const emit = text => {
  const bytes = Buffer.byteLength(text);
  if (emitted + bytes > logLimit) throw Error('The 128 KiB aggregate log admission was exceeded');
  emitted += bytes; process.stdout.write(text);
};
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
for (const path of ['lib/usage-billing.ts', 'lib/billing.ts', 'lib/redis-reply.ts', 'lib/redis-count.ts', 'tests/usage-billing-exact.test.ts']) emit('REVIEW_2944_SOURCE ' + path + ' ' + blob(readFileSync(join(root, path))) + '\n');
const base = execFileSync('git', ['show', '5c07315505e1d53ee6401021601cd688fa98ecda:lib/usage-billing.ts'], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
if (blob(Buffer.from(base)) !== '5c072f8f0b663612412ee9a0005592a04eb7363e') throw Error('Unexpected base source');
const groups = [
  { name: 'author-head', base: false, files: ['usage-billing-exact.test.ts'], caps: [2000], expected: [0] },
  { name: 'author-base-red', base: true, files: ['usage-billing-exact.test.ts'], caps: [2000], expected: [1] },
  { name: 'linked', base: false, files: ['sg2-l8-usage-billing.test.ts', 'sg2-l8-usage-marks.test.ts'], caps: [1000, 1000], expected: [0, 0] },
  { name: 'independent', base: false, files: ['k-review-2944-usage-billing.proof.ts'], caps: [2000], expected: [0] },
].filter(group => !independentOnly || group.name === 'independent');
const admitted = groups.reduce((sum, group) => sum + group.caps.reduce((a, b) => a + b, 0), 0);
if (admitted > 16_000) throw Error('Aggregate application admission exceeds the authorized ceiling');
emit('REVIEW_2944_BOUNDS ' + JSON.stringify({ independentCases: 8, directedGroups: independentOnly ? 0 : 3, groupMaximum: 2000, admittedAggregateOperations: admitted, authorizedAggregateOperations: 16_000, deadlineMs: 120_000, aggregateLogBytes: logLimit, nativeProviderCallsAllowed: 0 }) + '\n');
const guard = `
const budget = globalThis.__k2Review2944Budget = {operations:0,nativeMemoryCommands:0,syntheticFetchCalls:0,blockedNativeFetch:0};
const cap = Number(process.env.K2_REVIEW_2944_CAP);
globalThis.__k2Review2944Admit = (units) => {if(!Number.isSafeInteger(units)||units<0||budget.operations+units>cap)throw Error('Review group operation admission exceeded');budget.operations+=units;};
let fixture = async () => {budget.blockedNativeFetch++;throw Error('Native provider/network is forbidden');};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async(...args)=>{globalThis.__k2Review2944Admit(1);budget.syntheticFetchCalls++;return fixture(...args);},set:value=>{if(typeof value!=='function')throw Error('Invalid synthetic transport');fixture=value;}});
process.on('exit',()=>console.log('REVIEW_2944_GROUP_COUNTS',JSON.stringify({group:process.env.K2_REVIEW_2944_GROUP,cap,...budget})));
`;
const temp = mkdtempSync(join(tmpdir(), 'k2-review-2944-'));
try {
  for (const group of groups) for (let i = 0; i < group.files.length; i++) {
    const file = group.files[i], outfile = join(temp, group.name + '-' + file + '.cjs');
    const entry = file.startsWith('k-review-') ? join(evidenceRoot, 'tests', file) : join(here, file);
    await require('esbuild').build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', alias: testAliases(file, root, here), logLevel: 'error', inject: ['k2-review-2944-budget'], plugins: [{ name: 'review-2944-local-boundaries', setup(build) {
      build.onResolve({ filter: /^k2-review-2944-budget$/ }, () => ({ path: 'budget', namespace: 'review-2944' }));
      build.onLoad({ filter: /.*/, namespace: 'review-2944' }, () => ({ contents: guard, loader: 'js' }));
      build.onLoad({ filter: /[/\\]tests[/\\]redis-stub\.ts$/ }, args => {
        if (args.path !== join(here, 'redis-stub.ts')) return;
        return { contents: readFileSync(args.path, 'utf8') + `\nconst reviewNative=store.pipeline.bind(store);store.pipeline=async(commands)=>{globalThis.__k2Review2944Admit(commands.length);globalThis.__k2Review2944Budget.nativeMemoryCommands+=commands.length;return reviewNative(commands);};\n`, loader: 'ts', resolveDir: here };
      });
      if (group.base) build.onLoad({ filter: /[/\\]lib[/\\]usage-billing\.ts$/ }, args => args.path === join(root, 'lib/usage-billing.ts') ? { contents: base, loader: 'ts', resolveDir: join(root, 'lib') } : undefined);
    } }] });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Review deadline reached before the next replay');
    emit('REVIEW_2944_REPLAY ' + JSON.stringify({ group: group.name, file, baseUsageOnly: group.base, admittedOperations: group.caps[i] }) + '\n');
    const env = testEnvironment({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, K2_REVIEW_2944_CAP: String(group.caps[i]), K2_REVIEW_2944_GROUP: group.name + '/' + file });
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [outfile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', failure;
      const timer = setTimeout(() => { failure = Error('Review deadline exceeded'); child.kill('SIGKILL'); }, remaining);
      const take = chunk => { try { const text = chunk.toString(); emit(text); output += text; } catch (error) { failure = error; child.kill('SIGKILL'); } };
      child.stdout.on('data', take); child.stderr.on('data', take);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', status => { clearTimeout(timer); if (failure) reject(failure); else resolveRun({ status, output }); });
    });
    if (result.status !== group.expected[i]) throw Error('Unexpected replay exit; review stopped before further cases');
    if (group.base && !result.output.includes('19 checks, 14 failing.')) throw Error('Author RED differs from the recorded counter-proof');
    if (!result.output.includes('"blockedNativeFetch":0')) throw Error('Native-network boundary was not proven closed');
  }
  emit('REVIEW_2944_COMPLETED ' + JSON.stringify({ admittedAggregateOperations: admitted, emittedBytesBeforeSummary: emitted, nativeNetwork: 'none; synthetic fetch functions only' }) + '\n');
} finally { rmSync(temp, { recursive: true, force: true }); }
