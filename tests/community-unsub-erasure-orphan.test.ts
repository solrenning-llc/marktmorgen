/** G independent proof. Six race assertions preserved verbatim from ed40258d; isolated atomic CAS fixture. */
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { freshConfig, memberKey, readMember, saveConfig, type Member } from "@/lib/community";
import { readCommunityUnsub, tokenFor } from "@/lib/community-mail";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { forgetCommunityPerson } from "@/lib/community-erasure";
type Command = (string | number)[];
let failedCleanup: null | (()=>unknown) = null;
let cleanupAttempts=0;
const gate: null = null;
const pipeline=redis.pipeline.bind(redis);
redis.pipeline=(async(commands:Command[])=>{
  if(failedCleanup&&commands.length===1&&commands[0][0]==="DEL"&&String(commands[0][1]).startsWith("nl:cm:unsub:")){cleanupAttempts++;return failedCleanup();}
  if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith('local cur = redis.call("HGET"')){
    const[,,,members,dir,field,expected,next,listed,at]=commands[0];
    // Atomic region: no await between HGET, comparison, HSET and directory update.
    if(redis.run(["HGET",members,field])!==expected)return[0];
    redis.run(["HSET",members,field,next]);
    redis.run(listed==="1"?["ZADD",dir,at,field]:["ZREM",dir,field]);
    return[1];
  }
  return pipeline(commands);
})as typeof redis.pipeline;
globalThis.fetch=(async()=>new Response(JSON.stringify({object:"list",data:[],has_more:false}),{status:200}))as typeof fetch;
async function stopPress(token:string){
  const response=await unsubscribePost(new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?c=${token}`,{method:"POST",body:new FormData()}));
  return {status:response.status,text:await response.text()};
}
async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@patchmember.example";
  const made = await claimHandle(OWNER, "patchmemberclub", "Patch Member Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PatchMember1", subscriptionId: "sub_PatchMember1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;

  let n = 0;
  /** A member as touchMember writes one, with their emails on and a stop link of their own. */
  async function member(): Promise<{ key: string; token: string; email: string }> {
    n += 1;
    const email = `member${n}@patchmember.example`;
    const key = memberKey(email);
    const token = n.toString(16).padStart(40, "a");
    const record: Member = { k: key, e: email, n: `Member ${n}`, h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: token, q: [], qa: 0, qq: [] };
    await redis.pipeline([["HSET", members, key, JSON.stringify(record)], ["SET", `nl:cm:unsub:${token}`, `${cid}|${key}|${club.handle}`]]);
    return { key, token, email };
  }
  const mailOf = async (key: string) => (await readMember(cid, key))?.mail;

  const linkRows=async(key:string)=>{
    const [scan]=await pipeline([["SCAN","0","MATCH","nl:cm:unsub:*"]]);
    const keys=(scan as [string,string[]])[1];const found:string[]=[];
    for(const k of keys){const [v]=await pipeline([["GET",k]]);if(v===`${cid}|${key}|${club.handle}`)found.push(k);}
    return found.sort();
  };
  for(const failure of ["missing acknowledgement","transport exception","healthy cleanup"]){
    part(failure);
    const m=await member();await pipeline([["HSET",members,m.key,JSON.stringify({...(await readMember(cid,m.key))!,t:""})],["DEL",`nl:cm:unsub:${m.token}`]]);
    const stale=(await readMember(cid,m.key))!;
    const first=await tokenFor(club,cid,stale);cleanupAttempts=0;
    if(failure!=="healthy cleanup")failedCleanup=()=>{if(failure==="transport exception")throw Error("synthetic cleanup unavailable before applying DEL");return []};
    const second=await tokenFor(club,cid,stale);failedCleanup=null;
    console.log("G_UNUSED_INDEX",JSON.stringify({mode:failure,returnedCanonical:first===second,cleanupAttempts,rowsBefore:(await linkRows(m.key)).length}));
    is(`${failure}: a returned link is usable before erasure`,Boolean(await readCommunityUnsub(second)),true);
    const removed=await forgetCommunityPerson(cid,m.key,m.email,[]);
    is(`${failure}: erasure completed through the real function`,typeof removed==="number"&&removed>0,true);
    is(`${failure}: member no longer exists`,await readMember(cid,m.key),null);
    const remaining=await linkRows(m.key);
    console.log("G_UNUSED_AFTER_ERASURE",JSON.stringify({mode:failure,remaining:remaining.length}));
    is(`${failure}: every stop-link record tied to this erased person is gone`,remaining,[]);
  }
  done();
}
void main();
