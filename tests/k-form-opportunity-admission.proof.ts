/** Actual conversion writer + data room: an unknown receipt cannot free a persisted deal's reservation. */
import { createFormOpportunity } from '@/lib/form-opportunity';
import { DEFAULT_STAGES, type Deal } from '@/lib/crm-rules';
import { dealBytes, dealSlot } from '@/lib/crm';
import { dataKey, dataUsed } from '@/lib/store-data';
import { store as redis } from '@/tests/redis-stub';
import { ROOM } from '@/tests/data-room';
import { done, is, part } from '@/tests/check';

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const fetchBefore = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw Error('No provider IO allowed'); }) as typeof fetch;
  try {
    for (const mode of ['healthy', 'applied-transport-error', 'applied-null-receipt'] as const) {
      part(mode);
      redis.pipeline = pipeline; redis.clear();
      const stats = 'opportunity-admission-' + mode;
      const ref = 'a'.repeat(64), id = ref.slice(0, 10);
      const draft: Deal = { id, title: 'Synthetic reviewed application', email: 'person@example.test', cents: 0, stage: DEFAULT_STAGES[0].id, note: 'Synthetic admission evidence', createdAt: 1760000000, updatedAt: 1760000000 };
      if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 4_096) throw Error('The fixture record exceeds its admitted ceiling');
      const saved = { ...draft, id, formResponseRef: ref }, expectedBytes = dealBytes(saved);
      const recordKey = `nl:crm:deals:${stats}`;
      let commands = 0, mutations = 0, injected = 0, active = false;
      redis.pipeline = async batch => {
        if (active) {
          if (commands + batch.length > 20) throw Error('Twenty application commands per case is the ceiling');
          commands += batch.length;
        }
        const conversion = batch.some(command => command[0] === 'EVAL' && String(command[1]).startsWith('-- marktmorgen:form-opportunity:'));
        if (conversion) mutations++;
        const real = await pipeline(batch); // The actual script stores the record before its receipt is disturbed.
        if (conversion && mutations === 1 && mode !== 'healthy') {
          injected++;
          if (mode === 'applied-transport-error') throw Error('Synthetic lost conversion reply');
          return [null];
        }
        return real;
      };
      let outcome = 'known';
      active = true;
      try { await createFormOpportunity(stats, ref, draft, DEFAULT_STAGES, ROOM); } catch { outcome = 'unknown'; }
      finally { active = false; }
      is('caller distinguishes the lost receipt', outcome, mode === 'healthy' ? 'known' : 'unknown');
      is('the selected fault occurs once', injected, mode === 'healthy' ? 0 : 1);
      is('the actual conversion was attempted exactly once', mutations, 1);
      // Observation is outside application accounting; its values come from the actual store and data-room reader.
      is('the actual saved record remains intact', (await pipeline([['HGET', recordKey, id]]))[0], JSON.stringify(saved));
      is('a persisted conversion retains its exact room slot', (await pipeline([['HGET', dataKey(ROOM)!, dealSlot(id)]]))[0], String(expectedBytes));
      is('the actual room total still covers the persisted deal', ((await dataUsed(ROOM))?.used ?? -1) >= expectedBytes, true);
      active = true;
      const retry = await createFormOpportunity(stats, ref, draft, DEFAULT_STAGES, ROOM);
      active = false;
      is('a healthy retry recovers the existing conversion', retry.state, 'existing');
      is('recovery does not leave the persisted deal uncharged', (await pipeline([['HGET', dataKey(ROOM)!, dealSlot(id)]]))[0], String(expectedBytes));
      is('recovery does not duplicate the record', (await pipeline([['HLEN', recordKey]]))[0], 1);
      console.log('FORM_OPPORTUNITY_ADMISSION_OBSERVATION', JSON.stringify({ mode, commands, mutations, expectedBytes, used: (await dataUsed(ROOM))?.used }));
    }
    is('no provider was contacted', providerCalls, 0);
  } finally { redis.pipeline = pipeline; globalThis.fetch = fetchBefore; }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
