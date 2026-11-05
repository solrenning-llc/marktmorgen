/** Observe the unchanged private receiverPrint in a real candidate module; never call a provider. */
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testAliases, testEnvironment } from './test-config.mjs';
const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? runnerRoot);
const source = readFileSync(join(root, 'lib/paypal-payouts.ts'), 'utf8');
const output = mkdtempSync(join(tmpdir(), 'h2-receiver-hmac-'));
try {
  const bundle = join(output, 'proof.cjs');
  await build({ stdin: { contents: source + `
import { strict as h2Assert } from 'node:assert';
const h2Address = 'synthetic@example.test';
process.env.NIMBUS_DATA_KEY = 'synthetic-h2-root-one-'.repeat(3);
process.env.STRIPE_SECRET_KEY = 'synthetic-h2-fallback';
const h2Expected = createHmac('sha256', deriveKey('paypal-payout-receiver/v1')!).update(h2Address).digest('hex');
const h2First = receiverPrint(h2Address);
h2Assert.equal(h2First, h2Expected);
h2Assert.match(h2First, /^[0-9a-f]{64}$/);
h2Assert.equal(receiverPrint(h2Address), h2First);
h2Assert.notEqual(receiverPrint('other@example.test'), h2First);
process.env.NIMBUS_DATA_KEY = 'synthetic-h2-root-two-'.repeat(3);
h2Assert.notEqual(receiverPrint(h2Address), h2First);
delete process.env.NIMBUS_DATA_KEY;
h2Assert.match(receiverPrint(h2Address), /^[0-9a-f]{64}$/);
delete process.env.STRIPE_SECRET_KEY;
h2Assert.equal(receiverPrint(h2Address), '');
console.log('7 receiver HMAC assertions pass; no provider call.');
`, resolveDir: join(root, 'lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, nodePaths: [join(runnerRoot, 'node_modules'), join(root, 'node_modules')], alias: testAliases('h2-2681-receiver-hmac-run.mjs', root, join(root, 'tests')), logLevel: 'error' });
  const result = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(output, { recursive: true, force: true }); }
