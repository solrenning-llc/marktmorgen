import { readTroubleStrict } from '@/lib/checkout-trouble';
import { CHECKOUT_TROUBLE_READ } from './plan-cost-registry';
import { store as redis } from './redis-stub';
import { done, is } from './check';
const sid = 'g'.repeat(32), now = Date.parse('2027-01-01T00:00:00.000Z'), day = 86_400_000;
const pipeline = redis.pipeline.bind(redis);
async function main() {
  globalThis.fetch = (async () => { throw new Error('No external service'); }) as typeof fetch;
  const dates = Array.from({length: 7}, (_, i) => new Date(now-i*day).toISOString().slice(0,10));
  const max = Math.floor(Number.MAX_SAFE_INTEGER / 7);
  const last = {at: now, code: '\u0000'.repeat(60), message: '\u0000'.repeat(300)};
  for (const d of dates) await pipeline([['HSET', `nl:cotrouble:${sid}`, d, String(max)]]);
  await pipeline([['HSET', `nl:cotrouble:${sid}`, 'last', JSON.stringify(last), '2027-01-02', '999999999999999999999999', '2026-12-25', '999999999999999999999999']]);
  let batches: (string|number)[][] = [], bytes=0;
  redis.pipeline = async batch => { batches.push(...batch); const reply = await pipeline(batch); bytes += Buffer.byteLength(JSON.stringify(batch))+Buffer.byteLength(JSON.stringify(reply)); return reply; };
  const result = await readTroubleStrict(sid, now);
  is('seven exact UTC dates cross year boundary and exclude old/future counters', result?.week, 7*max);
  is('fixed read contains only the seven dates plus last', batches, [['HMGET', `nl:cotrouble:${sid}`, ...dates, 'last']]);
  is('combined safe counts and worst double JSON escaping fit registered ceiling', bytes<=CHECKOUT_TROUBLE_READ.bytes, true);
  console.log(`MEASURE combined maximum ${bytes} bytes`);
  redis.pipeline = pipeline;
  const known = [...Array(7).fill(null), JSON.stringify(last)];
  for (const at of [-1, 1.5, Number.MAX_SAFE_INTEGER+1, '0', null]) {
    redis.pipeline = async () => [[...Array(7).fill(null), JSON.stringify({...last, at})]];
    is(`invalid last timestamp ${String(at)} is unknown`, await readTroubleStrict(sid, now), null);
  }
  for (const reply of [Array(1), [Array(8)], [known, known], undefined, {}, [[...known.slice(0,7), JSON.stringify({...last, code:'x'.repeat(61)})]]]) {
    redis.pipeline = async () => reply as never;
    is('sparse, extra or malformed read does not become zero', await readTroubleStrict(sid, now), null);
  }
  redis.pipeline = async () => [[...Array(7).fill(null), JSON.stringify({...last, at:now-7*day-1})]];
  is('old last reason is not shown', await readTroubleStrict(sid, now), {week:0,last:null});
  redis.pipeline = async () => [known];
  is('explicit missing day counters are confirmed zero', (await readTroubleStrict(sid, now))?.week, 0);
  redis.pipeline = pipeline;
  done();
}
main().catch(error => { redis.pipeline=pipeline; console.error(error); process.exit(1); });
