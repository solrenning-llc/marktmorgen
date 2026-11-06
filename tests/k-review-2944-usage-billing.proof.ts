/** Second independent technical review: exact reader envelopes and legacy safety, no real account/provider. */
import { settleAllUsage, settleUsage, type Meter } from '@/lib/usage-billing';
import { UnknownReplyError } from '@/lib/redis-reply';
import { store as redis } from '@/tests/redis-stub';
import { done, is, part } from '@/tests/check';

process.env.STRIPE_SECRET_KEY = 'sk_test_k2_review_2944_synthetic_only';
const calls: { method: string; path: string; body: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? 'GET';
  if (url.origin !== 'https://api.stripe.com' || url.pathname !== '/v1/invoiceitems') throw Error('Unexpected synthetic transport call');
  calls.push({ method, path: url.pathname + url.search, body: String(init?.body ?? '') });
  if (method === 'GET') return Response.json({ object: 'list', data: [], has_more: false });
  if (method === 'POST') return Response.json({ id: 'ii_Review2944Synthetic', object: 'invoiceitem' });
  throw Error('Unexpected synthetic transport method');
}) as typeof fetch;

const NOW = Date.UTC(2026, 10, 20, 14), MONTH = '2026-11', FOLDER = 'review2944-synthetic';
// Same kind of test meter as the author's: it exercises the dormant reader path.
// No production meter, commercial parameter, gate or allowance is changed.
const meter: Meter = { name: 'review2944', measured: async () => 10, owed: () => 500, byPlan: false, covered: 0, describe: (_month, amount) => `Synthetic legacy use ${amount}`, folders: async () => [] };
const billed = `nl:${meter.name}:billed:${FOLDER}:${MONTH}`, adding = `nl:${meter.name}:adding:${FOLDER}:${MONTH}`;
const native = redis.pipeline.bind(redis);
let selected: unknown[] | null = null, traps = 0, promiseProbes = 0;
const seen: (string | number)[][] = [];
redis.pipeline = async batch => {
  seen.push(...batch);
  if (selected && batch.length === 2 && batch[0][0] === 'GET' && batch[0][1] === billed && batch[1][0] === 'GET' && batch[1][1] === adding) return selected;
  return native(batch);
};
const reset = () => { redis.clear(); calls.length = 0; seen.length = 0; selected = null; traps = 0; promiseProbes = 0; };
const settle = async () => {
  try { return { state: (await settleUsage(meter, FOLDER, MONTH, true, NOW)).state, unknown: false }; }
  catch (error) { return { state: error instanceof UnknownReplyError ? 'unknown' : 'unexpected', unknown: error instanceof UnknownReplyError }; }
};
const postCount = () => calls.filter(call => call.method === 'POST').length;
async function rejected(name: string, reply: unknown[]) {
  part(name); reset(); selected = reply;
  is(`${name}: unknown before settlement`, await settle(), { state: 'unknown', unknown: true });
  is(`${name}: no synthetic provider request`, calls.length, 0);
  is(`${name}: no record is written or deleted`, seen.some(command => ['SET', 'DEL'].includes(String(command[0]))), false);
  console.log('REVIEW_2944_CASE', JSON.stringify({ name, syntheticProviderCalls: calls.length, writes: seen.filter(command => ['SET', 'DEL'].includes(String(command[0]))).length }));
}

async function main() {
  await rejected('one extra pipeline reply', ['0', null, 'padding']);
  const sparse = new Array<unknown>(2); sparse[0] = '0';
  await rejected('missing own adding slot', sparse);
  // Await probes then before the reader receives an async reply. Permit only that
  // unavoidable Promise assimilation probe; no data/reflection trap may execute.
  const proxy = new Proxy(['0', null], { get(_target, key) { if (key === 'then') { promiseProbes++; return undefined; } traps++; throw Error('Executable reply must not run'); }, ownKeys() { traps++; throw Error('Executable reply must not run'); }, getOwnPropertyDescriptor() { traps++; throw Error('Executable reply must not run'); } });
  await rejected('proxy envelope', proxy);
  is('proxy envelope: no reply trap executes', traps, 0);
  console.log('REVIEW_2944_PROXY_BOUNDARY', JSON.stringify({ promiseAssimilationProbes: promiseProbes, dataOrReflectionTraps: traps }));
  await rejected('unsafe integer billed text', ['9007199254740992', null]);
  await rejected('JSON null is not a line record', ['0', 'null']);

  part('Legacy optional fields retain their actual defaults'); reset();
  const legacy = JSON.stringify({ from: 0, to: 500, at: NOW, seconds: 10, customerId: 'cus_Meter000001', subscriptionId: 'sub_Meter000001' });
  await native([['SET', billed, '0'], ['SET', adding, legacy]]);
  is('legacy seconds-only line completes', await settle(), { state: 'billed', unknown: false });
  is('legacy: one synthetic invoice-item request', postCount(), 1);
  const body = new URLSearchParams(calls.find(call => call.method === 'POST')?.body);
  is('legacy: actual billing guard receives whole cents', body.get('amount'), '500');
  is('legacy: seconds and absent description retain defaults', body.get('description'), 'Synthetic legacy use 10');
  is('legacy: native billed/adding data settles exactly', await native([['GET', billed], ['GET', adding]]), ['500', null]);
  console.log('REVIEW_2944_CASE', JSON.stringify({ name: 'legacy seconds-only', syntheticProviderCalls: calls.length, invoiceItems: postCount(), amount: body.get('amount'), description: body.get('description') }));

  part('Actual billing boundary rejects fractional cents'); reset();
  const fractional = JSON.stringify({ from: 0, to: 1.5, at: NOW, amount: 10, line: 'Synthetic', customerId: 'cus_Meter000001', subscriptionId: 'sub_Meter000001' });
  await native([['SET', billed, '0'], ['SET', adding, fractional]]);
  is('fractional end: real billing guard fails safely', await settle(), { state: 'failed', unknown: false });
  is('fractional end: no synthetic invoice item is posted', postCount(), 0);
  is('fractional end: unfinished bytes remain for review', await native([['GET', billed], ['GET', adding]]), ['0', fractional]);
  console.log('REVIEW_2944_CASE', JSON.stringify({ name: 'fractional end boundary', syntheticProviderCalls: calls.length, invoiceItems: postCount(), state: 'failed' }));

  part('Daily isolation preserves readable folders'); reset();
  const bad = 'review2944-bad', good = 'review2944-good';
  await native([['SET', `nl:${meter.name}:billed:${bad}:${MONTH}`, 'unreadable'], ['SET', `nl:${meter.name}:billed:${good}:${MONTH}`, '0']]);
  const messages: string[] = [], beforeError = console.error;
  let rows: Awaited<ReturnType<typeof settleAllUsage>>;
  try {
    console.error = (...args: unknown[]) => { messages.push(String(args[0])); };
    // Zero owed matches today's production meters; it is not a switch on a production meter.
    rows = await settleAllUsage({ ...meter, owed: () => 0, folders: async () => [bad, good] }, NOW);
  } finally { console.error = beforeError; }
  is('daily run: unknown folder is skipped, readable one remains', rows.map(row => [row.folder, row.state]), [[good, 'nothing']]);
  is('daily run: exactly one unknown store is logged', messages.length, 1);
  is('daily run: zero synthetic provider requests', calls.length, 0);
  is('daily run: existing billed figures are unchanged', await native([['GET', `nl:${meter.name}:billed:${bad}:${MONTH}`], ['GET', `nl:${meter.name}:billed:${good}:${MONTH}`]]), ['unreadable', '0']);
  console.log('REVIEW_2944_CASE', JSON.stringify({ name: 'daily isolation', folders: rows.map(row => row.folder), logged: messages.length, syntheticProviderCalls: calls.length }));
  redis.pipeline = native;
  done();
}
void main().catch(error => { redis.pipeline = native; console.error(error); process.exitCode = 1; });
