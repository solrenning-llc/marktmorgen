/**
 * Rule 30 on Codex G's residual MEDIUM on #3123 (review 5815472405): the
 * same class in lib/community.ts setProfile. A member's @handle is claimed in
 * the community's handle table (handle -> member key) before the record says
 * it is theirs. The erasure deletes only the handle the record holds
 * (forgetHandle with member.h), so a handle claimed by a change whose record
 * was erased in between, or one a concurrent change wrote and this change then
 * replaced, stayed tied to the erased person. Now each is given back once the
 * record is known not to carry it.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
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
  if(failed==="cas"&&commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith('local cur = redis.call("HGET"'))return [];
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
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

  for(const mode of ["read","cas"] as const){
    const m=await member();
    const base=(await readMember(cid,m.key))!;
    const record={...base,n:"Original Name",h:"original-name"};
    await pipeline([["HSET",members,m.key,JSON.stringify(record)],["HSET",handles,"original-name",m.key]]);
    const snapshot=(await readMember(cid,m.key))!;
    afterClaim=async()=>{failed=mode};
    const outcome=await setProfile(cid,snapshot,profile("Changed Name "+n),club).then(()=>"returned",()=>"thrown");
    failed="none";
    is(`${mode}: failed profile change is reported`,outcome,"thrown");
    is(`${mode}: unchanged member still carries its original handle`,(await readMember(cid,m.key))?.h,"original-name");
    is(`${mode}: original handle still resolves to this unchanged member`,(await whoIs(cid,["original-name"])).get("original-name"),m.key);
    const other=await member();
    await setProfile(cid,(await readMember(cid,other.key))!,profile("Original Name"),club);
    const actual=(await whoIs(cid,["original-name"])).get("original-name");
    console.log("G_OLD_HANDLE",JSON.stringify({mode,original:m.key,other:other.key,resolves:actual}));
    is(`${mode}: rejected rename does not let another member take the old handle`,actual,m.key);
  }
  done();
}
void main();
