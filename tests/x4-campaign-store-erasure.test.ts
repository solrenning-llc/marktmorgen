/**
 * Codex X4's MEDIUM on main (relatorios-codex/X4-20261120-0603-fix-main-campaign-landing-erasure.md): a campaign
 * landing save paused just before WRITE_LANDINGS must not write the text or the data room back once the store's
 * erasure began (its erasing mark) or ended (its keys gone). Main, extra and legacy (from before ids) stores, by a
 * create and by an update. And Claude 3's MEDIUM on #4967: a legacy store erased while the save waits, whose owner
 * then opens a new store under the same address (another statsId), is not written back either.
 * Synthetic: the Redis stand-in only.
 */
import { saveLanding } from '@/lib/campaign-landing-store';
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail, storeRef, storeIdCommand, ownerKey, erasingField, ERASING_KEY, type Store } from '@/lib/store';
import { dataKey } from '@/lib/store-data';
import { store as redis } from './redis-stub';
import { is, done } from './check';

const EMAIL = 'x4-landings@example.invalid';
const LATE = { campaign: 'late', headline: 'Private synthetic person', sub: 'Late campaign draft', button: '' };

/** The id key of the store kept under the owner's address now, if it has one. */
async function ownerIdKey(): Promise<string | null> {
  const raw = redis.run(['GET', await ownerKey(EMAIL)]);
  const sid = typeof raw === 'string' ? (JSON.parse(raw) as { sid?: string }).sid : '';
  return sid ? storeIdCommand(sid)[1] : null;
}

/** Makes the store kept under the owner's address one from before ids: no id in its record, no id key. */
async function makeLegacy(): Promise<void> {
  const idKey = await ownerIdKey();
  if (idKey) redis.run(['DEL', idKey]);
  const kept = JSON.parse(String(redis.run(['GET', await ownerKey(EMAIL)]))) as Store;
  redis.run(['SET', await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: '' })]);
}

/** Runs `step` once, just before the first WRITE_LANDINGS EVAL of the save. */
async function saveWith(room: Store, step: () => Promise<void>): Promise<{ result: unknown; reached: boolean }> {
  const original = redis.pipeline;
  let reached = false;
  redis.pipeline = async (commands) => {
    if (!reached && commands.some((c) => c[0] === 'EVAL' && String(c[1]).startsWith('-- marktmorgen:landings-write:'))) {
      reached = true;
      await step();
    }
    return original.call(redis, commands);
  };
  let result: unknown;
  try {
    result = await saveLanding(room.statsId!, 'p1', LATE, room);
  } catch (error) {
    result = error;
  } finally {
    redis.pipeline = original;
  }
  return { result, reached };
}

async function main() {
  for (const kind of ['primary', 'extra', 'legacy'] as const) for (const state of ['live', 'gone', 'erasing'] as const) for (const update of [false, true]) {
    redis.clear();
    await claimHandle(EMAIL, 'x4-landings', 'Synthetic', '');
    await ensureStatsId(EMAIL);
    // A legacy store is one kept from before ids: it has none until something gives it one.
    await ensureStoreId(EMAIL);
    if (kind === 'legacy') await makeLegacy();
    const real = (await storeForEmail(EMAIL))!;
    const room = { ...real, ...(kind === 'extra' ? { extra: true } : {}), tier: 'scale' as const, subscriptionActive: true, subscriptionId: 'sub_synthetic' } as Store;
    const ref = storeRef(room);
    if (kind !== 'legacy') redis.run(['SET', storeIdCommand(room.sid)[1], ref]);
    const key = `nl:product:landing:${room.statsId}:p1`, dk = dataKey(room)!;
    if (update) await saveLanding(room.statsId!, 'p1', { campaign: 'before', headline: 'Before erasure', sub: 'Synthetic draft', button: '' }, room);
    const { result, reached } = await saveWith(room, async () => {
      if (state === 'gone') {
        // The erasure's record step: the store's own keys go (its id key, if it has one by now, and its record).
        const idKey = kind === 'extra' ? storeIdCommand(room.sid)[1] : await ownerIdKey();
        if (idKey) redis.run(['DEL', idKey]);
        if (kind !== 'extra') redis.run(['DEL', await ownerKey(EMAIL)]);
        redis.run(['DEL', key]);
        redis.run(['DEL', dk]);
      }
      if (state === 'erasing') {
        redis.run(['HSET', ERASING_KEY, await erasingField(ref), '']);
        redis.run(['DEL', key]);
        redis.run(['DEL', dk]);
      }
    });
    if (kind === 'legacy') is(`legacy/${state}/${update ? 'update' : 'create'} starts from a store with no id`, room.sid, '');
    const label = `${kind}/${state}/${update ? 'update' : 'create'}`;
    is(label + ' reached the actual writer', reached, true);
    if (state === 'live') is(label + ' live saves still work', result, 'saved');
    else {
      is(label + ' refuses the save', result === 'saved', false);
      is(label + ' does not restore deleted campaign text', redis.run(['GET', key]), null);
      is(label + ' does not restore its data room', redis.run(['EXISTS', dk]), 0);
    }
  }

  // Claude 3 on #4967: the legacy store is erased while the save waits, and its owner opens a new store under the
  // same address. The owner's record exists again, but it is another store (another statsId and id).
  for (const update of [false, true]) {
    redis.clear();
    await claimHandle(EMAIL, 'x4-landings', 'Synthetic', '');
    await ensureStatsId(EMAIL);
    await makeLegacy();
    const room = { ...(await storeForEmail(EMAIL))!, tier: 'scale' as const, subscriptionActive: true, subscriptionId: 'sub_synthetic' } as Store;
    const key = `nl:product:landing:${room.statsId}:p1`, dk = dataKey(room)!;
    if (update) await saveLanding(room.statsId!, 'p1', { campaign: 'before', headline: 'Before erasure', sub: 'Synthetic draft', button: '' }, room);
    const { result, reached } = await saveWith(room, async () => {
      const idKey = await ownerIdKey();
      const kept = JSON.parse(String(redis.run(['GET', await ownerKey(EMAIL)]))) as Store;
      if (idKey) redis.run(['DEL', idKey]);
      redis.run(['DEL', key]);
      redis.run(['DEL', dk]);
      const next = { ...kept, sid: '2'.repeat(32), statsId: 'reopenedstats1' };
      redis.run(['SET', await ownerKey(EMAIL), JSON.stringify(next)]);
      redis.run(['SET', storeIdCommand(next.sid)[1], EMAIL]);
    });
    is(`legacy/reopened/${update ? 'update' : 'create'} starts from a store with no id`, room.sid, '');
    const label = `legacy/reopened/${update ? 'update' : 'create'}`;
    is(label + ' reached the actual writer', reached, true);
    is(label + ' refuses the save', result === 'saved', false);
    is(label + ' does not restore the erased store\'s campaign text', redis.run(['GET', key]), null);
    is(label + ' does not restore its data room', redis.run(['EXISTS', dk]), 0);
  }
  done();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
