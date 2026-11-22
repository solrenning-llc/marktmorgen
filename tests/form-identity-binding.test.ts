/** REAL CRUD, parser, form-store and MemoryRedis; only owner guard and selected HGET reply are synthetic. */
import type { NextRequest } from 'next/server';
import type { Store } from '@/lib/store';
import { POST } from '@/app/api/store/forms/route';
import { parseForm } from '@/lib/forms';
import { writeForm } from '@/lib/form-store';
import { store as redis } from '@/tests/redis-stub';
import { done, is } from '@/tests/check';

type Boundary = { body: Record<string, unknown>; shop: Store; guardCalls: number; permission: string };
const fixtureGlobal = globalThis as typeof globalThis & { __k2FormIdentity?: Boundary };
const stats = 'form-identity-fixture';
const key = `nl:forms:${stats}`;
const first = parseForm({
  id: 'form000001', name: 'Original A', updatedAt: 1,
  fields: [{ id: 'topic0', type: 'short', label: 'Topic', required: false }], offerList: false,
})!;
const second = parseForm({ ...first, id: 'form000002', name: 'Original B' })!;

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const beforeFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider operation is allowed in this proof'); }) as typeof fetch;
  try {
    for (const mode of ['healthy', 'wrong-identity', 'confirmed-missing'] as const) {
      redis.pipeline = pipeline; redis.clear();
      if (mode !== 'confirmed-missing') await writeForm(stats, first);
      await writeForm(stats, second);
      const boundary: Boundary = {
        body: { form: { ...first, name: 'Revision' } },
        shop: { sid: 'synthetic-form-owner', statsId: stats, sitePages: [], catalog: { items: [] } } as unknown as Store,
        guardCalls: 0, permission: '',
      };
      fixtureGlobal.__k2FormIdentity = boundary;
      const body = JSON.stringify(boundary.body);
      if (Buffer.byteLength(body) > 4096) throw Error('Four KiB is the synthetic request body ceiling');
      const request = new Request('https://example.test/api/store/forms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }) as unknown as NextRequest;
      let commands = 0, injected = 0, writes = 0;
      redis.pipeline = async batch => {
        if (commands + batch.length > 20) throw Error('Twenty application Redis commands per case is the ceiling');
        commands += batch.length;
        for (const command of batch) if (['EVAL', 'HSET', 'HDEL', 'SET', 'DEL'].includes(String(command[0]))) writes++;
        if (mode === 'wrong-identity' && batch.length === 1 && batch[0][0] === 'HGET' && batch[0][1] === key && batch[0][2] === first.id) {
          injected++;
          return [JSON.stringify(second)];
        }
        return pipeline(batch);
      };
      const response = await POST(request);
      const answer = await response.json() as { ok?: boolean; error?: string; form?: { id?: string } };
      // Direct inspection is outside the application's counted commands and injection.
      const [rawA, rawB] = await pipeline([['HGET', key, first.id], ['HGET', key, second.id]]);
      const afterA = typeof rawA === 'string' ? JSON.parse(rawA) as { id: string; name: string } : null;
      const afterB = typeof rawB === 'string' ? JSON.parse(rawB) as { id: string; name: string } : null;
      console.log('FORM_IDENTITY_OBSERVATION', JSON.stringify({
        mode, status: response.status, answer, commands, injected, writes,
        beforeA: mode === 'confirmed-missing' ? null : first, beforeB: second, afterA, afterB,
      }));
      is(`${mode}: owner page guard is used exactly once`, boundary.guardCalls, 1);
      is(`${mode}: existing page permission is preserved`, boundary.permission, 'page');
      is(`${mode}: exactly the selected HGET reply is substituted`, injected, mode === 'wrong-identity' ? 1 : 0);
      is(`${mode}: no provider operation`, providerCalls, 0);
      if (mode === 'healthy') {
        is('healthy: edit succeeds', response.status, 200);
        is('healthy: reply names requested form A', answer.form?.id, first.id);
        is('healthy: actual stored A receives the revision', afterA?.name, 'Revision');
        is('healthy: actual stored B is byte-identical', rawB, JSON.stringify(second));
        is('healthy: one actual save command', writes, 1);
        is('healthy: one read and one save', commands, 2);
      } else if (mode === 'wrong-identity') {
        is('wrong identity: refuse as temporarily unavailable', response.status, 503);
        is('wrong identity: response explicitly says unavailable', answer.error, 'unavailable');
        is('wrong identity: no actual save command', writes, 0);
        is('wrong identity: actual stored A is byte-identical', rawA, JSON.stringify(first));
        is('wrong identity: actual stored B is byte-identical', rawB, JSON.stringify(second));
        is('wrong identity: stop after the selected read', commands, 1);
      } else {
        is('confirmed missing: absence stays 404', response.status, 404);
        is('confirmed missing: A remains absent', rawA, null);
        is('confirmed missing: B is byte-identical', rawB, JSON.stringify(second));
        is('confirmed missing: no actual save command', writes, 0);
        is('confirmed missing: one confirmed read', commands, 1);
      }
    }
  } finally {
    redis.pipeline = pipeline; globalThis.fetch = beforeFetch;
    delete fixtureGlobal.__k2FormIdentity;
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
