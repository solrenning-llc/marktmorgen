/**
 * A member's profile that shrinks gives its room back only once the shorter record is written (Claude 1 cloud's LEVE
 * on #2576, lib/community.ts setProfile): the shrink used to be given back before patchMember, so a write that did not
 * go in (its answer lost, or the record gone in between) left the members' slot counted under what it holds. Real
 * code with the stand-in Redis; the member write's answer is lost on purpose.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { dataUsed, needData } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { whoIs } from "@/lib/community-mentions";

type Command = (string | number)[];
let failed: "none"|"read"|"cas"="none";
let afterClaim: null | (() => Promise<void>) = null;
let beforeCas: null | (() => Promise<void>) = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if(failed==="read"&&commands.length===1&&commands[0][0]==="HGET"&&String(commands[0][1]).endsWith(":m"))return [];
  if(failed==="cas"&&commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).includes('local cur = redis.call("HGET", KEYS[1], ARGV[1])'))return [];
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('local cur = redis.call("HGET", KEYS[1], ARGV[1])')) {
    if (beforeCas) {
      const act = beforeCas;
      beforeCas = null;
      await act();
    }
    // The member CAS as Redis runs it: no await between HGET, the comparison, HSET and the directory.
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    return [1];
  }
  const answer = await pipeline(commands);
  if (afterClaim && commands.length === 1 && commands[0][0] === "HSETNX" && String(commands[0][1]).endsWith(":h")) {
    const act = afterClaim;
    afterClaim = null;
    await act();
  }
  return answer;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@handleorphan.example";
  const made = await claimHandle(OWNER, "handleorphanclub", "Handle Orphan Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HandleOrphan1", subscriptionId: "sub_HandleOrphan1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;
  const handles = `nl:cm:${cid}:h`;

  let n = 0;
  async function member(): Promise<{ key: string; email: string }> {
    n += 1;
    const email = `member${n}@handleorphan.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)]]);
    return { key, email };
  }
  /** Every handle in the table that points at this member key. */
  const handlesOf = async (key: string) => {
    const [flat] = (await pipeline([["HGETALL", handles]])) as [string[] | null];
    const out: string[] = [];
    for (let i = 0; flat && i + 1 < flat.length; i += 2) if (flat[i + 1] === key) out.push(flat[i]);
    return out.sort();
  };
  const profile = (name: string) => ({ name, dir: true, mail: false });

  part("A shorter name whose write is not known to have gone in gives nothing back");
  const m = await member();
  await needData(club, [{ slot: "cm:m", bytes: 5_000 }]);
  await setProfile(cid, (await readMember(cid, m.key))!, profile("A Rather Long Display Name For This Member"), club);
  const before = (await dataUsed(club))!.used;
  failed = "cas";
  const outcome = await setProfile(cid, (await readMember(cid, m.key))!, profile("Al"), club).then(() => "returned", () => "thrown");
  failed = "none";
  is("(the write's answer was lost, so the change failed)", outcome, "thrown");
  is("the room is not given back for a record that may not have shrunk", (await dataUsed(club))!.used, before);

  part("A shorter name that is written gives its room back");
  const ok = await setProfile(cid, (await readMember(cid, m.key))!, profile("Al"), club).then(() => "returned", () => "thrown");
  is("(written)", ok, "returned");
  is("the room shrinks once the shorter record is written", (await dataUsed(club))!.used < before, true);
  done();
}
void main();
