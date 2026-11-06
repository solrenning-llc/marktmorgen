// G: real membership move and real access writers, varied copy/undo transport boundaries.
import { moveMemberships, putMember, readTeam } from '@/lib/team';
import { writePipelineAccess } from '@/lib/pipeline-access';
import type { AccessMap } from '@/lib/pipeline-access-rules';
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from '@/lib/store';
import { dataKey } from '@/lib/store-data';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this proof'); };
const from = 'g-copy-old@example.test', to = 'g-copy-new@example.test';
const small: AccessMap = { sales0: 'none' }, large: AccessMap = { sales0: 'none', wkshp1: 'view' };
async function fixture(source: AccessMap, prior: AccessMap) {
  redis.clear();
  const owner = 'g-copy-matrix@example.test';
  await claimHandle(owner, 'g-copy-matrix', 'Synthetic store', '');
  await ensureStoreId(owner); await ensureStatsId(owner);
  await setSubscription(owner, { customerId: 'cus_GCopyMatrix', subscriptionId: 'sub_GCopyMatrix', active: true, tier: 'pro', period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  await putMember(shop, from, 'support');
  await writePipelineAccess(shop.statsId!, from, source, shop);
  await writePipelineAccess(shop.statsId!, to, prior, shop);
  const base = redis.pipeline.bind(redis), key = `nl:crm:pacc:${shop.statsId}`;
  const sourceRaw = (await base([['HGET', key, from]]))[0];
  const priorRaw = (await base([['HGET', key, to]]))[0];
  const room = async () => (await base([['HGET', dataKey(shop)!, 'crm:pacc']]))[0];
  const roomBefore = await room();
  return { shop, base, key, sourceRaw, priorRaw, room, roomBefore };
}

async function main() {
  const cases: [string, AccessMap, AccessMap][] = [
    ['new destination', small, {}], ['larger prior destination', small, large],
    ['smaller prior destination', large, small], ['unrestricted source clears prior', {}, large],
  ];
  for (const [label, source, prior] of cases) {
    for (const mode of ['applied-empty', 'unapplied-empty', 'applied-throw', 'unapplied-throw', 'applied-getter']) {
      const f = await fixture(source, prior);
      let faults = 0, getterCalls = 0;
      redis.pipeline = async commands => {
        if (!faults && commands.length === 1 && ['HSET', 'HDEL'].includes(String(commands[0][0])) && commands[0][1] === f.key && commands[0][2] === to) {
          faults++;
          if (mode.startsWith('applied-')) await f.base(commands);
          if (mode === 'applied-getter') {
            const malformed: unknown[] = [undefined];
            Object.defineProperty(malformed, '0', { configurable: true, get() { getterCalls++; throw Error('G: local accessor receipt cannot be read'); } });
            return malformed;
          }
          if (mode.endsWith('-throw')) throw Error('G: copy receipt lost');
          return [];
        }
        return f.base(commands);
      };
      try { await moveMemberships(from, to); }
      finally { redis.pipeline = f.base; }
      const target = (await f.base([['HGET', f.key, to]]))[0], afterRoom = await f.room();
      is(`${label}/${mode}: the actual copy boundary was faulted`, faults, 1);
      is(`${label}/${mode}: the old member remains the only member`, (await readTeam(f.shop.sid)).members.map(m => m.email), [from]);
      is(`${label}/${mode}: source record stays exact`, (await f.base([['HGET', f.key, from]]))[0], f.sourceRaw);
      is(`${label}/${mode}: destination is restored byte for byte`, target, f.priorRaw);
      is(`${label}/${mode}: confirmed restoration restores exactly the prior room`, afterRoom, f.roomBefore);
      if (mode === 'applied-getter') is(`${label}/${mode}: receipt validation does not run an accessor`, getterCalls, 0);
      console.log('G_COPY_MATRIX', JSON.stringify({ label, mode, faults, target, before: f.priorRaw, roomBefore: f.roomBefore, afterRoom, getterCalls }));
    }
  }
  // A second transport failure during undo cannot justify refunding the copy's room.
  for (const mode of ['applied-empty', 'unapplied-empty', 'applied-throw', 'unapplied-throw']) {
    const f = await fixture(small, {});
    let copyFaults = 0, undoFaults = 0;
    let chargedRoom: unknown;
    redis.pipeline = async commands => {
      if (commands.length === 1 && ['HSET', 'HDEL'].includes(String(commands[0][0])) && commands[0][1] === f.key && commands[0][2] === to) {
        if (!copyFaults) {
          copyFaults++; chargedRoom = await f.room(); await f.base(commands);
          throw Error('G: real copy applied, first response lost');
        }
        if (!undoFaults) {
          undoFaults++;
          if (mode.startsWith('applied-')) await f.base(commands);
          if (mode.endsWith('-throw')) throw Error('G: second transport failure during undo');
          return [];
        }
      }
      return f.base(commands);
    };
    try { await moveMemberships(from, to); }
    finally { redis.pipeline = f.base; }
    const target = (await f.base([['HGET', f.key, to]]))[0], afterRoom = await f.room();
    is(`unknown undo/${mode}: both actual write boundaries were faulted`, [copyFaults, undoFaults], [1, 1]);
    is(`unknown undo/${mode}: old membership remains`, (await readTeam(f.shop.sid)).members.map(m => m.email), [from]);
    is(`unknown undo/${mode}: source is unchanged`, (await f.base([['HGET', f.key, from]]))[0], f.sourceRaw);
    is(`unknown undo/${mode}: actual destination reflects whether undo applied`, target, mode.startsWith('applied-') ? f.priorRaw : f.sourceRaw);
    is(`unknown undo/${mode}: no room refunded on the unconfirmed restoration`, afterRoom, chargedRoom);
    console.log('G_COPY_UNKNOWN_UNDO', JSON.stringify({ mode, target, chargedRoom, afterRoom, copyFaults, undoFaults }));
  }
  done();
}
void main();
