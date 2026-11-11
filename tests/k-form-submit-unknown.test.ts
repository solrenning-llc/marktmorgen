/** Real HTTP POST + form helpers + MemoryRedis; only selected receipts/services are synthetic. */
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/form/route';
import { writeForm } from '@/lib/form-store';
import { store as redis } from './redis-stub';
import { form } from './form-response-fixture';
import { effects, shop } from './k-form-submit-world';
import { done, is, part } from './check';

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const fetchBefore = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider IO allowed'); }) as typeof fetch;
  const storedForm = { ...form, offerList: false };
  const formsKey = `nl:forms:${shop.statsId}`, answersKey = `nl:form:r:${shop.statsId}:${form.id}`;
  const scenarios = ['healthy', 'missing', 'unknown-definition', 'definition-outage', 'unknown-keep'] as const;
  try {
    for (const scenario of scenarios) {
      part(scenario);
      redis.pipeline = pipeline;
      redis.clear();
      for (const key of Object.keys(effects) as (keyof typeof effects)[]) effects[key] = 0;
      // Fixture writes and direct observations are outside the application's command count.
      if (scenario !== 'missing') await writeForm(shop.statsId!, storedForm);
      const body = new URLSearchParams({ handle: shop.handle!, form: form.id, page: 'page000001', f: 'funnel0001', q_name00: 'Synthetic', q_email0: 'person@example.com' });
      if (Buffer.byteLength(body.toString(), 'utf8') > 4_096) throw Error('The request body exceeds its admitted fixture ceiling');
      const request = new Request('https://example.com/api/store/form', { method: 'POST', body }) as NextRequest;
      let commands = 0, injected = 0, afterUnknown = 0;
      redis.pipeline = async batch => {
        if (commands + batch.length > 20) throw Error('Twenty application Redis commands per scenario is the ceiling');
        commands += batch.length;
        if ((scenario === 'unknown-definition' || scenario === 'definition-outage') && batch[0][0] === 'HGET' && batch[0][1] === formsKey) {
          injected++;
          if (scenario === 'definition-outage') throw Error('Synthetic definition transport outage');
          return [false];
        }
        if (scenario === 'unknown-keep' && batch[0][0] === 'EVAL' && String(batch[0][1]).startsWith('-- marktmorgen:form-keep:')) {
          injected++;
          // Not applied here, but a lost receipt cannot tell that from applied (k-form-kept-feedback.test.ts):
          // retaining room is conservative, and the buyer is told "unsure", never "nothing was sent".
          return [null];
        }
        if (injected) afterUnknown += batch.length;
        return pipeline(batch);
      };
      const response = await POST(request);
      const location = response.headers.get('location');
      const saved = (await pipeline([['LLEN', answersKey]]))[0];
      const definition = (await pipeline([['HGET', formsKey, form.id]]))[0];
      const healthy = scenario === 'healthy';
      const definitionUnknown = scenario === 'unknown-definition' || scenario === 'definition-outage';
      is('status follows confirmed evidence', response.status, definitionUnknown ? 503 : 303);
      is('location describes only the evidenced outcome', definitionUnknown ? location === null : healthy ? location?.includes(`/form/${form.id}?`) : location?.includes(`status=${scenario === 'missing' ? 'closed' : 'unsure'}`), true);
      is('successful redirect is offered only after a confirmed keep', location?.includes(`/form/${form.id}?`) ?? false, healthy);
      is('actual response storage agrees with success', saved, healthy ? 1 : 0);
      is('the form record remains unchanged', definition, scenario === 'missing' ? null : JSON.stringify(storedForm));
      is('selected unknown reply occurs exactly once', injected, definitionUnknown || scenario === 'unknown-keep' ? 1 : 0);
      is('unknown never triggers another Redis command', afterUnknown, 0);
      is('admission happens only after a known definition', effects.admission, scenario === 'healthy' || scenario === 'unknown-keep' ? 1 : 0);
      is('enrollment occurs only after confirmed storage', effects.enroll, healthy ? 1 : 0);
      is('funnel completion occurs only after confirmed storage', effects.funnel, healthy ? 1 : 0);
      is('unknown never looks up the next funnel step', effects.funnelReads, healthy ? 1 : 0);
      is('no list confirmation is requested when offerList is off', effects.joins, 0);
      console.log('FORM_SUBMIT_APPLICATION_COMMANDS', scenario, commands);
    }
    is('no actual provider was contacted', providerCalls, 0);
  } finally {
    redis.pipeline = pipeline;
    globalThis.fetch = fetchBefore;
  }
  done();
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
