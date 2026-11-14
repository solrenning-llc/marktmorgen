/**
 * Beside Codex G's proof (tests/community-old-handle-after-failure.test.ts,
 * review 5815632734 of #3123): claimHandle only reserves the new handle, and
 * setProfile gives back the one the member had only once the record is known
 * not to carry it, through the same exact give-back (GIVE_BACK_HANDLE).
 *
 * - healthy rename: the old handle is let go once the change is saved, so
 *   another member gets the plain handle, and the new one resolves.
 * - a name that gives no handle: the old one is let go once the record says "".
 * - CAS applied, answer lost: the record carries the new handle, so the new
 *   one stays and the old one goes; the caller still sees the failure.
 * - CAS not applied and the give-back answers in no known shape: both stay
 *   reserved (the stated limit) and the caller sees the original failure.
 * - record erased between the claim and the update: both are given back.
 * - old handle already pointing at somebody else: it is not deleted.
 */
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { whoIs } from "@/lib/community-mentions";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

type Command = (string | number)[];
// Found anywhere in the script: #2576 heads the member CAS with its "-- marktmorgen:member-cas:v1" tag.
const CAS = 'local cur = redis.call("HGET", KEYS[1], ARGV[1])';
const GIVE_BACK = "-- marktmorgen:community-handle-give-back:v1\n";
let casMode: "apply" | "applied-lost" | "lost" = "apply";
let giveBackAnswer: null | unknown[] = null;
let beforeCas: null | (() => Promise<void>) = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(GIVE_BACK) && giveBackAnswer) return giveBackAnswer;
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes(CAS)) {
    if (beforeCas) {
      const act = beforeCas;
      beforeCas = null;
      await act();
    }
    if (casMode === "lost") return [];
    // The member CAS as Redis runs it: no await between HGET, the comparison, HSET and the directory.
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    return casMode === "applied-lost" ? [] : [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@oldhandle.example";
  const made = await claimHandle(OWNER, "oldhandleclub", "Old Handle Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OldHandle1", subscriptionId: "sub_OldHandle1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;
  const handles = `nl:cm:${cid}:h`;
  const profile = (name: string) => ({ name, dir: true, mail: false });
  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const UNKNOWN = "Redis answered a change to a community member record in an unknown shape";

  let n = 0;
  /** A member whose record already carries `old` as its handle, with the index pointing at it. */
  async function named(old: string): Promise<{ key: string; snapshot: Member }> {
    n += 1;
    const email = `member${n}@oldhandle.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: `Old ${n}`, h: old, dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)], ["HSET", handles, old, key]]);
    return { key, snapshot: (await readMember(cid, key))! };
  }
  async function plain(): Promise<string> {
    n += 1;
    const email = `member${n}@oldhandle.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)]]);
    return key;
  }
  const owner = async (handle: string) => (await pipeline([["HGET", handles, handle]]))[0];

  // Healthy rename.
  {
    const m = await named("healthy-old");
    const saved = await setProfile(cid, m.snapshot, profile("Healthy New"), club);
    is("healthy: the record carries the new handle", saved.h, "healthy-new");
    is("healthy: the new handle resolves to the member", (await whoIs(cid, ["healthy-new"])).get("healthy-new"), m.key);
    is("healthy: the old handle is given back once the change is saved", await owner("healthy-old"), null);
    const other = await plain();
    const took = await setProfile(cid, (await readMember(cid, other))!, profile("Healthy Old"), club);
    is("healthy: another member then gets the plain old handle", took.h, "healthy-old");
  }

  // A name that gives no handle.
  {
    const m = await named("empty-old");
    const saved = await setProfile(cid, m.snapshot, profile("!!"), club);
    is("no handle: the record carries none", saved.h, "");
    is("no handle: the old handle is given back once the record says so", await owner("empty-old"), null);
  }

  // CAS applied, answer lost.
  {
    const m = await named("applied-old");
    casMode = "applied-lost";
    const outcome = await setProfile(cid, m.snapshot, profile("Applied New"), club).then(() => "returned", failure);
    casMode = "apply";
    is("applied-lost: the failure is still reported", outcome, UNKNOWN);
    is("applied-lost: the record carries the new handle", (await readMember(cid, m.key))?.h, "applied-new");
    is("applied-lost: the new handle stays with the record", await owner("applied-new"), m.key);
    is("applied-lost: the old handle the record no longer carries is given back", await owner("applied-old"), null);
  }

  // CAS not applied, give-back unknown.
  {
    const m = await named("double-old");
    casMode = "lost";
    giveBackAnswer = [];
    const outcome = await setProfile(cid, m.snapshot, profile("Double New"), club).then(() => "returned", failure);
    casMode = "apply";
    giveBackAnswer = null;
    is("double failure: the original failure is what the caller sees", outcome, UNKNOWN);
    is("double failure: the record keeps the old handle", (await readMember(cid, m.key))?.h, "double-old");
    is("double failure: the old handle still resolves to the member", (await whoIs(cid, ["double-old"])).get("double-old"), m.key);
    is("double failure: the new handle stays reserved (the stated limit)", await owner("double-new"), m.key);
  }

  // Record erased between the claim and the update.
  {
    const m = await named("erased-old");
    beforeCas = async () => {
      await pipeline([["HDEL", members, m.key]]);
    };
    const back = await setProfile(cid, m.snapshot, profile("Erased New"), club);
    is("erased: nothing is written", (await pipeline([["HGET", members, m.key]]))[0], null);
    is("erased: the member as it was is returned", back.h, "erased-old");
    is("erased: the new handle is given back", await owner("erased-new"), null);
    is("erased: the old handle is given back too", await owner("erased-old"), null);
  }

  // Old handle already pointing at somebody else.
  {
    const m = await named("moved-old");
    const stranger = memberKey("stranger@oldhandle.example");
    await pipeline([["HSET", handles, "moved-old", stranger]]);
    const saved = await setProfile(cid, m.snapshot, profile("Moved New"), club);
    is("other owner: the change is saved", saved.h, "moved-new");
    is("other owner: a handle now held by somebody else is not deleted", await owner("moved-old"), stranger);
  }
  done();
}
void main();
