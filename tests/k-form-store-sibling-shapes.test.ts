/** Real form helpers and room accounting; only the selected Redis reply is synthetic. */
import { readForms, readForm, responseCounts, addResponse, dropForm, writeForm } from '@/lib/form-store';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from './redis-stub';
import { ROOM } from './data-room';
import { form, responses } from './form-response-fixture';
import { done, is } from './check';

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
        if (!injected && batch[0][0] === scenario.command) { injected++; return reply; }
        if (injected) after += batch.length;
        return pipeline(batch);
      };
      let outcome = 'known';
      try { await scenario.call(); } catch (error) { outcome = error instanceof UnknownReply ? 'unknown' : 'unexpected'; }
      is(`${scenario.name} ${JSON.stringify(reply)} refuses the unknown`, outcome, 'unknown');
      is(`${scenario.name} injects exactly once`, injected, 1);
      is(`${scenario.name} makes no further storage or room command`, after, 0);
    }
  } finally { redis.pipeline = pipeline; }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
