/** Real form helpers and room accounting; only the selected Redis reply is synthetic. */
import { readForms, readForm, responseCounts, addResponse, dropForm, writeForm } from '@/lib/form-store';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from './redis-stub';
import { ROOM } from './data-room';
import { form, responses } from './form-response-fixture';
import { done, is } from './check';
import { receiverOf } from '@/lib/funnel-bundle-store';
import { previewCopy } from '@/lib/store-copy';
import { MAX_FORMS } from '@/lib/forms';
import { COPIERS } from '@/lib/person-copy';
import { erasureScope } from '@/lib/person-erasure';
import { storeExport } from '@/lib/store-export';
import { claimHandle, ensureStatsId, storeForEmail } from '@/lib/store';

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const stats = 'sibling-shapes', key = `nl:form:r:${stats}:${form.id}`;
  const cases = [
    { name: 'inventory', call: () => readForms(stats), command: 'HVALS', replies: [[], [null], [[] , 0], [[false]], [['not json']], [[JSON.stringify({})]]] },
    { name: 'single form', call: () => readForm(stats, form.id), command: 'HGET', replies: [[], [false], ['not json'], [JSON.stringify({})], [null, 0]] },
    { name: 'counts', call: () => responseCounts(stats, [form.id]), command: 'LLEN', replies: [[], [null], ['1'], [-1], [1.5], [0, 0]] },
    { name: 'keep preflight', call: () => addResponse(stats, form.id, responses[0], ROOM), command: 'LLEN', replies: [[], [null, null], ['1', null], [1, false], [1, null], [0, JSON.stringify(responses[0])]] },
    { name: 'keep receipt', call: () => addResponse(stats, form.id, responses[0], ROOM), command: 'EVAL', replies: [[], [null], [[false]], [['not json']], [[JSON.stringify({})]], [[], 0]] },
    { name: 'delete receipt', call: () => dropForm(stats, form.id, ROOM), command: 'HDEL', replies: [[], [1], [null, 0], [1, null], [2, 0], [1, 2], ['1', 1], [1, 1, 0]] },
  ];
  try {
    for (const scenario of cases) for (const reply of scenario.replies) {
      redis.pipeline = pipeline; redis.clear();
      await writeForm(stats, form);
      await pipeline([['LPUSH', key, JSON.stringify(responses[0])]]);
      let injected = 0, commands = 0, after = 0;
      redis.pipeline = async batch => {
        if (commands + batch.length > 20) throw Error('Twenty application commands per case is the ceiling');
        commands += batch.length;
        if (!injected && batch[0][0] === scenario.command && (scenario.name !== 'keep receipt' || String(batch[0][1]).startsWith('-- marktmorgen:form-keep:'))) { injected++; return reply; }
        if (injected) after += batch.length;
        return pipeline(batch);
      };
      let outcome = 'known';
      try { await scenario.call(); } catch (error) { outcome = error instanceof UnknownReply ? 'unknown' : 'unexpected'; }
      is(`${scenario.name} ${JSON.stringify(reply)} refuses the unknown`, outcome, 'unknown');
      is(`${scenario.name} injects exactly once`, injected, 1);
      is(`${scenario.name} makes no further storage or room command`, after, 0);
    }
    redis.pipeline = pipeline; redis.clear();
    const owner = 'sibling-owner@example.com';
    await claimHandle(owner, 'siblingcopy', 'Synthetic forms', '');
    await ensureStatsId(owner);
    const shop = (await storeForEmail(owner))!;
    await writeForm(shop.statsId!, form);
    const scope = (await erasureScope(shop, 'person@example.com'))!;
    let unknown = false, commands = 0, injections = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => { throw Error('No provider IO allowed'); }) as typeof fetch;
    redis.pipeline = async batch => {
      if (commands + batch.length > 300) throw Error('Three hundred application commands is the export/copy ceiling');
      commands += batch.length;
      if (unknown && batch[0][0] === 'HVALS' && batch[0][1] === `nl:forms:${shop.statsId}`) { injections++; return [null]; }
      return pipeline(batch);
    };
    try {
      is('healthy person copy with no answers stays empty', await COPIERS['lib/form-store.ts'](scope), []);
      const known = JSON.parse(await new Response(storeExport(shop)).text());
      is('healthy store export keeps the saved form', known.forms[0].form.id, form.id);
      is('healthy funnel receiver counts its saved form', (await receiverOf(shop)).room.formsLeft, MAX_FORMS - 1);
      const now = Math.floor(Date.now() / 1000);
      const fundedTarget = { ...shop, ...ROOM, sid: shop.sid, period: { start: now - 86_400, end: now + 86_400, renews: true }, cycle: 'month' as const };
      is('healthy store-copy preview includes its source form', (await previewCopy(shop, fundedTarget, false)).needs.forms, 1);
      unknown = true;
      let copyUnknown = false;
      try { await COPIERS['lib/form-store.ts'](scope); } catch (error) { copyUnknown = error instanceof UnknownReply; }
      is('person copier refuses an unknown form inventory', copyUnknown, true);
      const partial = JSON.parse(await new Response(storeExport(shop)).text());
      is('store stream omits forms rather than inventing none', partial.forms, undefined);
      is('store stream declares the unread forms section', typeof partial.unreadPart4 === 'string' && partial.unreadPart4.includes('could not be read'), true);
      let receiverUnknown = false;
      try { await receiverOf(shop); } catch (error) { receiverUnknown = error instanceof UnknownReply; }
      is('funnel receiver refuses unknown capacity instead of inventing free slots', receiverUnknown, true);
      let previewUnknown = false;
      try { await previewCopy(shop, fundedTarget, false); } catch (error) { previewUnknown = error instanceof UnknownReply; }
      is('store-copy preview refuses an unknown source inventory rather than planning zero forms', previewUnknown, true);
      is('all four actual consumers encountered the selected unknown reply', injections, 4);
      console.log('FORM_SIBLING_CONSUMER_COMMANDS', commands);
    } finally { globalThis.fetch = fetchBefore; }
  } finally { redis.pipeline = pipeline; }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
