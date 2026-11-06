/** Independent actual-reader and authenticated export proof; Redis alone is synthetic. */
import { NextRequest } from 'next/server';
import { readPath, pathJson, type PathRecord } from '@/lib/path';
import { GET } from '@/app/api/store/path/route';
import { claimHandle, ensureStatsId } from '@/lib/store';
import { openSession, SESSION_COOKIE } from '@/lib/auth';
import { UnknownReplyError } from '@/lib/redis-reply';
import { store as redis } from './redis-stub';

async function main() {
  redis.clear();
  const email = 'q2885-owner@example.test';
  await claimHandle(email, 'q2885owner', 'Synthetic Q store', 'Synthetic introduction');
  const store = (await ensureStatsId(email))!;
  const token = await openSession(email);
  const key = `nl:path:${store.sid}`;
  const original = redis.pipeline.bind(redis);
  const now = Date.UTC(2026, 10, 6, 12);
  const record: PathRecord = { revision: 'r'.repeat(32), answers: { goalCents: 0, goalCurrency: 'usd', skills: 'Synthetic skill', subject: 'Synthetic subject', minutes: 15, audience: 'none', timeZone: 'UTC' }, startedAt: now, checkins: ['2026-11-06'], best: -1, bestAt: 0, money: null, counts: null };
  const valid = pathJson(record);
  await original([['SET', key, valid]]);
  let checks = 0, failures = 0;
  const expect = (name: string, got: unknown, want: unknown) => { checks++; if (JSON.stringify(got) !== JSON.stringify(want)) { failures++; console.log('FAIL', name, JSON.stringify({ got, want })); } };
  const cases: { name: string; reply: unknown[]; unavailable: boolean }[] = [
    { name: 'confirmed missing record', reply: [null], unavailable: false },
    { name: 'valid existing record', reply: [valid], unavailable: false },
    { name: 'missing reply', reply: [], unavailable: true },
    { name: 'extra reply', reply: [valid, null], unavailable: true },
    { name: 'sparse one-slot reply', reply: new Array(1), unavailable: true },
    { name: 'numeric record', reply: [0], unavailable: true },
    { name: 'empty serialized record', reply: [''], unavailable: true },
    { name: 'invalid JSON record', reply: ['{broken'], unavailable: true },
    { name: 'JSON null record', reply: ['null'], unavailable: true },
    { name: 'unrecognized serialized record', reply: ['{}'], unavailable: true },
  ];
  for (const item of cases) {
    let intercepted = 0, commands = 0;
    redis.pipeline = async batch => {
      commands += batch.length;
      if (commands > 100) throw new Error('Synthetic command ceiling exceeded');
      if (batch.length === 1 && batch[0][0] === 'GET' && batch[0][1] === key) { intercepted++; return item.reply as never; }
      return original(batch);
    };
    let outcome: unknown;
    try { outcome = await readPath(store); } catch (error) { outcome = error instanceof UnknownReplyError ? 'unavailable' : 'other-error'; }
    const response = await GET(new NextRequest('https://marktmorgen.com/api/store/path', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    const body = await response.json();
    redis.pipeline = original;
    const kept = (await original([['GET', key]]))[0];
    expect(item.name + ': both actual reads reached', intercepted, 2);
    expect(item.name + ': retained source is unchanged', kept, valid);
    if (item.unavailable) {
      expect(item.name + ': reader preserves uncertainty', outcome, 'unavailable');
      expect(item.name + ': actual export refuses', response.status, 503);
      expect(item.name + ': export never says no Path', Object.hasOwn(body, 'path'), false);
    } else {
      expect(item.name + ': actual export succeeds', response.status, 200);
      if (item.reply[0] === null) { expect(item.name + ': reader absence is confirmed', outcome, null); expect(item.name + ': export absence is confirmed', body.path, null); }
      else { expect(item.name + ': stored answers survive', body.path.answers.subject, record.answers.subject); expect(item.name + ': revision is private', Object.hasOwn(body.path, 'revision'), false); }
    }
    console.log('Q2885_OBSERVATION', JSON.stringify({ name: item.name, reader: outcome === null ? null : typeof outcome === 'string' ? outcome : 'record', status: response.status, bodyHasPath: Object.hasOwn(body, 'path'), intercepted, commands }));
  }
  console.log(JSON.stringify({ checks, failures, transport: 'MemoryRedis', authenticatedExport: true, nativeRedis: false, providerCalls: 0 }));
  process.exitCode = failures ? 1 : 0;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
