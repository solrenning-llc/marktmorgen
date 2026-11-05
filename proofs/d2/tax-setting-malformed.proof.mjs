// Reviewer-only RED evidence. Run from a repository checkout with dependencies:
// node proofs/d2/tax-setting-malformed.proof.mjs
// Uses the real persisted-store reader and tax field builder with MemoryRedis.
// No checkout is opened and no provider or production Redis is contacted.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';

const source = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { storeForEmail } from '@/lib/store';
import { applyTax } from '@/lib/tax';
import { store as redis } from './tests/redis-stub';

(async () => {
globalThis.fetch = async () => { throw new Error('External IO is forbidden in this proof'); };
const email = 'fiscal-audit@example.test';
const key = 'nl:store:owner:' + createHash('sha256').update('nimbus-store:' + email).digest('hex').slice(0, 40);
let checks = 0, failures = 0;
async function check(label, run) {
  checks++;
  try { await run(); console.log('PASS ' + label); }
  catch (error) { failures++; console.log('FAIL ' + label + ': ' + error.message); }
}
async function read(tax) {
  redis.clear();
  await redis.pipeline([['SET', key, JSON.stringify({ handle: 'fiscal-audit', name: 'Fiscal audit fixture', email, tax })]]);
  return storeForEmail(email);
}
for (const [label, tax, expected] of [
  ['explicit enabled', { enabled: true, included: false, ids: false, invoices: false }, 'true'],
  ['explicit disabled', { enabled: false, included: false, ids: false, invoices: false }, null],
  ['legacy optional document fields absent', { enabled: true, included: true }, 'true'],
  ['legacy tax setting absent', undefined, null],
]) await check(label, async () => {
  const store = await read(tax);
  assert.ok(store, 'valid or documented legacy record remains readable');
  const body = new URLSearchParams();
  applyTax(store, body);
  assert.equal(body.get('automatic_tax[enabled]'), expected);
});
for (const [label, enabled] of [
  ['string true', 'true'], ['string false', 'false'], ['null', null],
  ['number one', 1], ['array', []], ['object', {}],
]) await check('present malformed enabled: ' + label, async () => {
  let continued = false;
  let observed;
  try {
    const store = await read({ enabled, included: false, ids: false, invoices: false });
    if (store) {
      const body = new URLSearchParams();
      applyTax(store, body);
      observed = { parsed: store.tax.enabled, automaticTax: body.get('automatic_tax[enabled]') };
      continued = true;
    }
  } catch { /* A refusal before proceeding is safe for malformed persisted evidence. */ }
  assert.equal(continued, false, 'malformed persisted setting must not become usable off: ' + JSON.stringify(observed));
});
console.log(checks + ' checks, ' + failures + ' failures');
process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
const bundled = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'd2-tax-setting-malformed.ts', loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: testAliases('d2-tax-setting-malformed.ts', process.cwd(), resolve('tests')),
  logLevel: 'error',
});
const result = spawnSync(process.execPath, ['-'], {
  input: bundled.outputFiles[0].text, encoding: 'utf8',
  env: testEnvironment(process.env), maxBuffer: 3_000_000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
