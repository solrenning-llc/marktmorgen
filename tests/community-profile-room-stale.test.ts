/**
 * A member's profile change takes room in the store's data room for what it adds, and gives back what it removes
 * (lib/community.ts, setProfile; MEMBERS_SLOT). The room was worked out from the caller's snapshot of the record,
 * not from the record the compare-and-set wrote, so two changes started from one snapshot gave the same bytes back
 * twice, and the record then held bytes no reservation paid for: past the store's data-room ceiling (MR: a ceiling
 * before every spend). MEDIUM of Codex Z, Claude 1 (6787703741, and again at 6ff3a91275) and Claude 3 on #3024.
 *
 * The scenario of that review: a member has three long links; two overlapping changes from the same snapshot.
 * A clears the links and gives back their bytes; B writes one short link and, against the old three-link snapshot,
 * gave back the same bytes again. The counted bytes must match a control run where B starts from what A wrote.
 *
 * Real setProfile, patchMember and data room on tests/redis-stub.ts; synthetic data only.
 */
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { dataUsed } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const CAS = 'local cur = redis.call("HGET"';
const pipeline = redis.pipeline.bind(redis);
// The member CAS as Redis runs it (tests/community-old-handle-release.test.ts): no await between HGET, the
// comparison, HSET and the directory.
redis.pipeline = (async (commands: Command[]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(CAS)) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const long = (n: number) => ({ network: "github", url: `https://github.com/${"a".repeat(36)}${n}` });
const short = { network: "github", url: "https://github.com/b" };

async function club(owner: string, handle: string): Promise<Store> {
  const made = await claimHandle(owner, handle, "Room Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  await saveConfig(store.community!.id, freshConfig(store.name));
  return store;
}

/** A member with three long links, already counted in the room, and the snapshot both changes start from. */
async function member(store: Store, email: string): Promise<Member> {
  const cid = store.community!.id;
  const key = memberKey(email);
  const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [], s: [] };
  await pipeline([["HSET", `nl:cm:${cid}:m`, key, JSON.stringify(record)]]);
  const first = await setProfile(cid, (await readMember(cid, key))!, { name: "Ana", dir: false, mail: false, links: [long(1), long(2), long(3)] as never }, store);
  if (first.s.length !== 3) throw new Error("the three long links were not kept, so the probe would test nothing");
  return first;
}

const used = async (store: Store) => (await dataUsed(store))?.used ?? null;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("control: the second change starts from what the first wrote");
  const fresh = await club("fresh@room.example", "roomfresh");
  const freshSnap = await member(fresh, "ana@fresh.example");
  const freshStart = await used(fresh);
  const a1 = await setProfile(fresh.community!.id, freshSnap, { name: "Ana", dir: false, mail: false, links: [] }, fresh);
  await setProfile(fresh.community!.id, a1, { name: "Ana", dir: false, mail: false, links: [short] as never }, fresh);
  const freshEnd = await used(fresh);

  part("two changes from one snapshot: the room is worked out from the record each one writes");
  const stale = await club("stale@room.example", "roomstale");
  const snap = await member(stale, "ana@stale.example");
  const staleStart = await used(stale);
  is("both stores start from the same counted bytes", staleStart, freshStart);
  await setProfile(stale.community!.id, snap, { name: "Ana", dir: false, mail: false, links: [] }, stale);
  // B was read before A went in: the same three-link snapshot.
  const written = await setProfile(stale.community!.id, snap, { name: "Ana", dir: false, mail: false, links: [short] as never }, stale);
  is("the record holds B's one short link", written.s.length, 1);
  is("the counted bytes match the control, so nothing is stored without a reservation", await used(stale), freshEnd);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
