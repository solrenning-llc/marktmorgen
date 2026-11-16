// Opt-in independent proof. Reuse the author's real functions/routes and
// synthetic transport, adding two reply shapes without editing its source.
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { testAliases, testEnvironment } from './test-config.mjs';

const root = process.cwd();
const file = 'number-gates-c.test.ts';
const original = execFileSync('git', ['show', `1d024ffc983333e9580b2a20e8b4e4e20683de06:tests/${file}`], { encoding: 'utf8' });
const anchor = 'const SET_INCR_UNKNOWN: [string, unknown][] = [';
if (original.split(anchor).length !== 2) throw new Error('Author fixture changed; review the delta first');
const additions = `
  ["S proof: own accessor count", Object.defineProperty(["OK", 1], "1", { get() { return 1; }, enumerable: true })],
  ["S proof: inherited SET receipt", (() => { const a = [, 1]; const p = Object.create(Array.prototype); Object.defineProperty(p, "0", { value: "OK", configurable: true }); Object.setPrototypeOf(a, p); return a; })()],
`;
let source = original.replace(anchor, anchor + additions);
// The author's open-link fixtures spread these pairs into new plain arrays.
// Exclude our shapes there: the spread normalizes them before the real call,
// so those would not be valid tests of a malformed production reply.
source = source.replace('...SET_INCR_UNKNOWN.map(', '...SET_INCR_UNKNOWN.filter(([label]) => !label.startsWith("S proof:")).map(');
const openPart = '  part("Opening an emailed link:';
const at = source.indexOf(openPart);
if (at < 0) throw new Error('Missing open-route fixture');
source = source.slice(0, at) + source.slice(at).replace('of SET_INCR_UNKNOWN)', 'of SET_INCR_UNKNOWN.filter(([label]) => !label.startsWith("S proof:")))');
const bundle = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: resolve(root, 'tests'), sourcefile: file },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: testAliases(file, root, resolve(root, 'tests')), logLevel: 'silent',
});
const child = spawnSync(process.execPath, ['-'], {
  input: bundle.outputFiles[0].text, encoding: 'utf8',
  env: testEnvironment(process.env), maxBuffer: 8_000_000,
});
const output = String(child.stdout ?? '') + String(child.stderr ?? '');
process.stdout.write(output.split('\n').filter(line => /S proof:|checks,|expected |got /.test(line)).join('\n') + '\n');
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
