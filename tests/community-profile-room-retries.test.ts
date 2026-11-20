/**
 * A member's profile change takes room in the store's data room for what it adds (lib/community.ts, setProfile and
 * patchMember; MEMBERS_SLOT). Its compare-and-set is tried up to five times when the record changed since it was
 * read. Each try used to run its own reservation and, when the set answered 0, its own give-back: up to five
 * reservations and five give-backs (each a TAKE_DATA script) for one buyer action, against the one room call the
 * action ran before, and no cost line measured them. MEDIUM of Claude 7 on #3024 (review at 2d7c9cd60b).
 *
 * What is held here: what one try reserved is kept across the retries; a later try tops it up only when it needs
 * more than is held, at most once; and whatever is held beyond what the record took is given back once, after the
 * write (or all of it, when nothing was written). So one profile change runs at most three room calls, two when
 * only other writers (a visit's `seen`, a mute) change the record, and the room counts exactly what the record took.
 *
 * Real setProfile, patchMember and data room on tests/redis-stub.ts; the member CAS as Redis runs it, with a
 * concurrent write landed between a try's read and its set; synthetic data only.
 */
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { dataUsed, TAKE_DATA } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const CAS = 'local cur = redis.call("HGET"';
// Found inside the script, not at its start: main (since #2576) opens the script with its version line ("-- marktmorgen:member-cas:v1").
const pipeline = redis.pipeline.bind(redis);

/** A write by somebody else, landed on the record between a try's read and its set; null leaves it alone. */
let interfere: ((record: Member) => Member) | null = null;
/** How many more tries the concurrent write lands on. */
let interferences = 0;
/** The data room's scripts run since the last reset: each reservation and each give-back is one. */
let roomCalls = 0;
let loseWriteReply = false;

redis.pipeline = (async (commands: Command[]) => {
  for (const command of commands) if (command[0] === "EVAL" && command[1] === TAKE_DATA) roomCalls += 1;
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes(CAS)) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (interfere && interferences > 0) {
      interferences -= 1;
      const now = JSON.parse(String(redis.run(["HGET", members, field]))) as Member;
      redis.run(["HSET", members, field, JSON.stringify(interfere(now))]);
    }
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    if (loseWriteReply) {
      loseWriteReply = false;
      throw new Error("the write reply was lost");
    }
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const long = (n: number) => ({ network: "github", url: `https://github.com/${"a".repeat(36)}${n}` });
const three = [long(1), long(2), long(3)] as never;

async function club(owner: string, handle: string): Promise<Store> {
  const made = await claimHandle(owner, handle, "Retry Club", "");
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

/** A member with no name and no links yet, as a first visit leaves them. */
async function member(store: Store, email: string): Promise<Member> {
  const cid = store.community!.id;
  const key = memberKey(email);
  const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1_000_000_000, muted: false, removed: false, t: "", q: [], qa: 0, qq: [], s: [] };
  await pipeline([["HSET", `nl:cm:${cid}:m`, key, JSON.stringify(record)]]);
  return (await readMember(cid, key))!;
}

const used = async (store: Store) => (await dataUsed(store))?.used ?? null;
/** A visit dated again: the same record, one second later, the same size. */
const visit = (record: Member): Member => ({ ...record, seen: record.seen + 1 });

async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "saved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("control: a change that goes in on its first try");
  const plain = await club("plain@retry.example", "retryplain");
  const plainSnap = await member(plain, "ana@plain.example");
  const plainStart = await used(plain);
  roomCalls = 0;
  await setProfile(plain.community!.id, plainSnap, { name: "Ana", dir: true, mail: false, links: three }, plain);
  const plainCalls = roomCalls;
  const plainGrowth = (await used(plain))! - plainStart!;
  is("the first try takes the room once", plainCalls, 1);
  is("the change took room for what it added", plainGrowth > 0, true);

  part("the member write lands and its pipeline reply rejects");
  const lost = await club("lost@retry.example", "retrylost");
  const lostSnap = await member(lost, "ana@lost.example");
  const lostStart = await used(lost);
  roomCalls = 0;
  loseWriteReply = true;
  is("the caller sees the lost reply", await attempt(() => setProfile(lost.community!.id, lostSnap, { name: "Ana", dir: true, mail: false, links: three }, lost)), "the write reply was lost");
  is("the record already holds the three links", (await readMember(lost.community!.id, lostSnap.k))?.s.length, 3);
  is("room for the written record stays reserved", (await used(lost))! - lostStart!, plainGrowth);
  is("no room give-back when the reply is lost", roomCalls, 1);

  part("four visits land between read and set: one reservation is kept across the retries");
  const busy = await club("busy@retry.example", "retrybusy");
  const busySnap = await member(busy, "ana@busy.example");
  const busyStart = await used(busy);
  interfere = visit;
  interferences = 4;
  roomCalls = 0;
  const saved = await attempt(() => setProfile(busy.community!.id, busySnap, { name: "Ana", dir: true, mail: false, links: three }, busy));
  is("the fifth try goes in", saved, "saved");
  is("the record holds the three links", (await readMember(busy.community!.id, busySnap.k))?.s.length, 3);
  is("the room counts exactly what the record took, as in the control", (await used(busy))! - busyStart!, plainGrowth);
  is("one room call, as without retries (was a reservation and a give-back per try)", roomCalls, plainCalls);

  part("the record changes on every try: nothing is written, and all that was held is given back once");
  const stuck = await club("stuck@retry.example", "retrystuck");
  const stuckSnap = await member(stuck, "ana@stuck.example");
  const stuckStart = await used(stuck);
  interfere = visit;
  interferences = 5;
  roomCalls = 0;
  is("the change fails as a record that kept changing", await attempt(() => setProfile(stuck.community!.id, stuckSnap, { name: "Ana", dir: true, mail: false, links: three }, stuck)), "a member's record kept changing");
  is("the room is back where it was", await used(stuck), stuckStart);
  is("two room calls: one reservation, one give-back", roomCalls, 2);

  part("the member's own other save shrinks the record once: one top-up, then the excess back once");
  const shrunk = await club("shrunk@retry.example", "retryshrunk");
  const shrunkSnap0 = await member(shrunk, "ana@shrunk.example");
  // The member already shows three links; the change keeps them and adds a name.
  const shrunkSnap = await setProfile(shrunk.community!.id, shrunkSnap0, { name: "", dir: false, mail: false, links: three }, shrunk);
  interfere = (record) => ({ ...record, s: record.s.slice(0, 1) });
  interferences = 1;
  roomCalls = 0;
  is("the change goes in on its second try", await attempt(() => setProfile(shrunk.community!.id, shrunkSnap, { name: "Ana", dir: true, mail: false, links: three }, shrunk)), "saved");
  is("at most two room calls: the first reservation and one top-up", roomCalls <= 2, true);

  part("the member's own saves shrink it on every try: the room calls stay bounded at three");
  const racing = await club("racing@retry.example", "retryracing");
  const racingSnap0 = await member(racing, "ana@racing.example");
  const racingSnap = await setProfile(racing.community!.id, racingSnap0, { name: "", dir: false, mail: false, links: three }, racing);
  let left = 3;
  interfere = (record) => ({ ...record, s: record.s.slice(0, Math.max(0, (left -= 1))) });
  interferences = 5;
  roomCalls = 0;
  const raced = await attempt(() => setProfile(racing.community!.id, racingSnap, { name: "Ana", dir: true, mail: false, links: three }, racing));
  is("the change fails as a record that kept changing", raced, "a member's record kept changing");
  is("at most three room calls: a reservation, one top-up and one give-back", roomCalls <= 3, true);
  interfere = null;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
