/** Independent R24 boundary: a readable link stored under another store is unknown, never absent. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addLink, readLinks } from '@/lib/short-links';
import { store as redis } from '../../../tests/redis-stub';

for (const action of ['read', 'add'] as const) {
  test(`another store's readable link cannot decide the ${action} boundary`, async () => {
    const source = { sid: `s2892-source-${action}`, statsId: `s2892source${action}` };
    const target = { sid: `s2892-target-${action}`, statsId: `s2892target${action}` };
    const made = await addLink(source, { name: 'Kept', place: 'x', target: { kind: 'store' } }, () => false);
    assert.equal(made.ok, true);
    const values = (await redis.pipeline([['HVALS', `nl:slink:store:${source.statsId}`]]))[0] as string[];
    assert.equal(values.length, 1);
    const key = `nl:slink:store:${target.statsId}`;
    await redis.pipeline([['HSET', key, 'foreign', values[0]]]);
    if (action === 'read') await assert.rejects(() => readLinks(target.statsId));
    else assert.deepEqual(await addLink(target, { name: 'Fresh', place: 'x', target: { kind: 'store' } }, () => false), { ok: false, reason: 'unavailable' });
    assert.equal((await redis.pipeline([['HLEN', key]]))[0], 1);
  });
}
