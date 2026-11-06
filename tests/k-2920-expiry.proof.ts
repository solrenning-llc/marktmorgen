/** Independent review of the inert expiry contract and its repository TypeScript compatibility. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = resolve(process.env.K2920_SOURCE_ROOT ?? process.cwd());
const baseRoot = resolve(process.env.K2920_BASE_ROOT ?? sourceRoot);
const loaded: Promise<Record<string, unknown>> = import(pathToFileURL(join(sourceRoot, 'lib/course-access-expiry-rules.ts')).href);
async function rule() {
  const state = (await loaded).courseAccessExpiryState;
  assert.equal(typeof state, 'function');
  return state as (expiry: unknown, now: unknown) => string;
}

test('ordered exact endpoints preserve the full expiry relation', async () => {
  const state = await rule(), max = 8_640_000_000_000_000;
  const ordered = [-max, -max + 1, -1, 0, 1, max - 1, max];
  for (let expiry = 0; expiry < ordered.length; expiry++) for (let now = 0; now < ordered.length; now++) {
    assert.equal(state(ordered[expiry], ordered[now]), expiry > now ? 'active' : 'expired');
  }
});

test('revoked and trapping proxies remain invalid without inspection', async () => {
  const state = await rule();
  let inspections = 0;
  const trapping = new Proxy({}, { get() { inspections++; throw Error('No property read allowed'); }, ownKeys() { inspections++; throw Error('No enumeration allowed'); }, getPrototypeOf() { inspections++; throw Error('No prototype read allowed'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [trapping, revoked.proxy]) {
    assert.equal(state(value, 0), 'invalid');
    assert.equal(state(0, value), 'invalid');
    assert.equal(state(null, value), 'invalid');
  }
  assert.equal(inspections, 0);
});

test('classification has no ambient clock dependency', async () => {
  const state = await rule(), before = Date.now;
  Date.now = () => { throw Error('No ambient clock allowed'); };
  try {
    assert.equal(state(100, 99), 'active');
    assert.equal(state(100, 100), 'expired');
    assert.equal(state(undefined, 0), 'unspecified');
    assert.equal(state(undefined, undefined), 'invalid');
  } finally { Date.now = before; }
});

function diagnostics(testText?: string) {
  const require = createRequire(join(baseRoot, 'package.json'));
  const ts = require('typescript') as typeof import('typescript');
  const config = ts.readConfigFile(join(baseRoot, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, baseRoot);
  const options = { ...parsed.options, incremental: false, noEmit: true, typeRoots: [join(baseRoot, 'node_modules/@types')] };
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host);
  const authorTest = join(sourceRoot, 'tests/course-access-expiry-rules.test.ts');
  if (testText !== undefined) host.readFile = file => resolve(file) === resolve(authorTest) ? testText : read(file);
  const program = ts.createProgram([join(sourceRoot, 'lib/course-access-expiry-rules.ts'), authorTest], options, host);
  return ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code, file: d.file?.fileName, line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
}

test('the unchanged author test typechecks under the real repository target', () => {
  assert.deepEqual(diagnostics(), []);
});

test('using the same bigint value through its constructor removes the target diagnostic', () => {
  const original = readFileSync(join(sourceRoot, 'tests/course-access-expiry-rules.test.ts'), 'utf8');
  // Candidate is virtual only: no author source, test expectation or repository target is changed.
  assert.deepEqual(diagnostics(original.replace(/\b0n\b/, 'BigInt(0)')), []);
});
