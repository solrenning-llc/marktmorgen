/** CX-129 G7: REAL POST/helper/MemoryRedis; the new error transport must retain every no-effect guard. */
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/form/route';
import { writeForm } from '@/lib/form-store';
import { store as redis } from '@/tests/redis-stub';
import { form } from '@/tests/form-response-fixture';
import { effects, shop } from '@/tests/k-form-submit-world';
import { done, is, part } from '@/tests/check';

async function main() {
  const pipeline = redis.pipeline.bind(redis), beforeFetch = globalThis.fetch;
  const stored = { ...form, offerList: false };
  const formsKey = `nl:forms:${shop.statsId}`, answersKey = `nl:form:r:${shop.statsId}:${form.id}`;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider IO is allowed'); }) as typeof fetch;
  try {
    for (const mode of ['unknown-definition', 'definition-outage', 'healthy', 'missing'] as const) {
      part(mode); redis.pipeline = pipeline; redis.clear();
      for (const key of Object.keys(effects) as (keyof typeof effects)[]) effects[key] = 0;
      // Setup is separate from the application's bounded batch count.
      if (mode !== 'missing') await writeForm(shop.statsId!, stored);
      const body = new URLSearchParams({ handle: shop.handle, form: form.id, page: 'page000001', f: 'funnel0001', q_name00: 'Synthetic', q_email0: 'person@example.com' });
      if (Buffer.byteLength(body.toString()) > 4096) throw Error('Four KiB is the local request-body ceiling');
      const request = new Request('https://example.com/api/store/form', { method: 'POST', body }) as NextRequest;
      let commands = 0, injected = 0, afterUnknown = 0;
      const unknown = mode === 'unknown-definition' || mode === 'definition-outage';
      redis.pipeline = async batch => {
        if (commands + batch.length > 40) throw Error('Forty application commands per POST scenario is the ceiling');
        commands += batch.length;
        if (unknown && batch.length === 1 && batch[0][0] === 'HGET' && batch[0][1] === formsKey && batch[0][2] === form.id) {
          injected++;
          if (mode === 'definition-outage') throw Error('Synthetic selected definition transport failure');
          return [false];
        }
        if (injected) afterUnknown += batch.length;
        return pipeline(batch);
      };
      const response = await POST(request), location = response.headers.get('location');
      const target = location ? new URL(location) : null;
      const [saved, definition] = await pipeline([['LLEN', answersKey], ['HGET', formsKey, form.id]]);
      const healthy = mode === 'healthy';
      const successTarget = target?.pathname === `/@${shop.handle}/form/${form.id}` && !target.searchParams.has('status');
      is(`${mode}: buyer POST redirects under the explicit G7 contract`, response.status, 303);
      is(`${mode}: response is not cached`, response.headers.get('cache-control'), 'no-store');
      is(`${mode}: redirect stays on the request origin`, target?.origin, 'https://example.com');
      if (unknown) {
        is('unknown: dedicated feedback pathname', target?.pathname, `/@${shop.handle}/form/${form.id}`);
        is('unknown: explicit unavailable marker, not a success result', target?.searchParams.get('status'), 'unavailable');
        is('unknown: only a known store page is carried', target?.searchParams.get('p'), 'page000001');
        is('unknown: validated funnel marker is carried', target?.searchParams.get('f'), 'funnel0001');
        is('unknown: no answers or success query are carried', target ? [...target.searchParams.keys()].sort() : null, ['f', 'p', 'status']);
      } else if (healthy) {
        is('healthy: confirmed result pathname remains', target?.pathname, `/@${shop.handle}/form/${form.id}`);
        is('healthy: no failure status is invented', target?.searchParams.has('status'), false);
      } else {
        is('missing: confirmed absence retains the page return', target?.pathname, `/@${shop.handle}/apply`);
        is('missing: confirmed absence remains closed', target?.searchParams.get('status'), 'closed');
        is('missing: existing form anchor remains', target?.hash, `#form-${form.id}`);
      }
      is(`${mode}: a result-path failure is never classified as success`, successTarget, healthy);
      is(`${mode}: actual saved responses still agree with success`, saved, healthy ? 1 : 0);
      is(`${mode}: the stored definition is unchanged`, definition, mode === 'missing' ? null : JSON.stringify(stored));
      is(`${mode}: exact selected injection count`, injected, unknown ? 1 : 0);
      is(`${mode}: no command follows an unknown definition`, afterUnknown, 0);
      is(`${mode}: admission occurs only after a known definition`, effects.admission, healthy ? 1 : 0);
      is(`${mode}: no enrollment follows an unkept response`, effects.enroll, healthy ? 1 : 0);
      is(`${mode}: no funnel completion follows an unkept response`, effects.funnel, healthy ? 1 : 0);
      is(`${mode}: unknown never looks up a funnel step`, effects.funnelReads, healthy ? 1 : 0);
      is(`${mode}: no list confirmation with offerList off`, effects.joins, 0);
      is(`${mode}: no provider operation`, providerCalls, 0);
      console.log('FORM_FEEDBACK_POST_OBSERVATION', JSON.stringify({ mode, status: response.status, location, commands, injected, afterUnknown, effects: { ...effects }, saved }));
    }
  } finally { redis.pipeline = pipeline; globalThis.fetch = beforeFetch; }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
