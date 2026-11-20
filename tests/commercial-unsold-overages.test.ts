/**
 * Owner, 20/11/2026 (decision 3 (b) to Claude 4, "Revisão comercial, trava 2"): the commercial review no longer
 * requires a margin scenario for use past a plan that no plan or add-on sells. Visits and orders past a plan stopped
 * being sold on 17/10/2026 (lib/traffic-rules.ts, lib/order-rules.ts: use rests at the plan's figure), and lesson video
 * past a plan's hours on 31/10/2026 (lib/watch-rules.ts, 232 [CA1] unit 3). A scenario with no revenue can never be
 * approved (lib/net-margin-rules.ts, "no_revenue"), so those three kept every review failing. If any of them is sold
 * again, its meter owes something, this test fails, and its scenario must come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_PLAN_REVENUE_CEILINGS, CURRENT_COMMERCIAL_TERMS, REQUIRED_MARGIN_SCENARIOS } from '@/lib/commercial-margin';

const UNSOLD = ['video_overage', 'visits_overage', 'orders_overage'];
const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const sources = (dir: string): string[] => readdirSync(join(process.cwd(), dir)).flatMap((name) => {
  const file = `${dir}/${name}`;
  if (statSync(join(process.cwd(), file)).isDirectory()) return sources(file);
  return /\.(ts|tsx|mjs)$/.test(name) ? [file] : [];
});

test('no meter puts use past a plan on an invoice: video, visits and orders all owe nothing', () => {
  for (const file of ['lib/watch-billing.ts', 'lib/traffic-billing.ts', 'lib/orders-billing.ts']) assert.match(read(file), /owed: \(\) => 0,/, file);
  assert.equal(CURRENT_COMMERCIAL_TERMS.traffic.overage, 'not-sold');
  assert.equal(CURRENT_COMMERCIAL_TERMS.orders.overage, 'not-sold');
});

test('only the usage meters put use on an invoice: no other code adds a line to the next invoice', () => {
  const callers = ['lib', 'app', 'components'].flatMap(sources).filter((file) => /(?<!function )\baddToNextInvoice\s*\(/.test(read(file)));
  assert.deepEqual(callers.sort(), ['lib/usage-billing.ts']);
  assert.match(read('lib/billing.ts'), /export async function addToNextInvoice\(/);
});

test('the review requires no scenario for an overage that is not sold', () => {
  for (const key of UNSOLD) assert.ok(!(REQUIRED_MARGIN_SCENARIOS as readonly string[]).includes(key), key);
});

test('every remaining scenario is a plan sold today, held to its own price', () => {
  assert.deepEqual([...REQUIRED_MARGIN_SCENARIOS].sort(), Object.keys(BASE_PLAN_REVENUE_CEILINGS).sort());
  for (const key of REQUIRED_MARGIN_SCENARIOS) assert.ok(Number.isSafeInteger(BASE_PLAN_REVENUE_CEILINGS[key]) && BASE_PLAN_REVENUE_CEILINGS[key]! > 0, key);
});
