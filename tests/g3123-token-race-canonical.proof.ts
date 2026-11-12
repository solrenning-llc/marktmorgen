/** G independent proof. Six race assertions preserved verbatim from ed40258d; isolated atomic CAS fixture. */
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { freshConfig, memberKey, readMember, saveConfig, type Member } from "@/lib/community";
import { readCommunityUnsub, tokenFor } from "@/lib/community-mail";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
type Command = (string | number)[];
let gate: null | (()=>Promise<void>) = null;
const pipeline=redis.pipeline.bind(redis);
redis.pipeline=(async(commands:Command[])=>{
  if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith('local cur = redis.call("HGET"')){
    if(gate)await gate();
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

  part("Two first unsubscribe links made from the same healthy member snapshot");
  {
    const m=await member();
    await pipeline([["HSET",members,m.key,JSON.stringify({...(await readMember(cid,m.key))!,t:""})]]);
    const first=(await readMember(cid,m.key))!;
    const second={...first};
    let entered=0;let release!:()=>void;
    const both=new Promise<void>(r=>{release=r});
    gate=async()=>{entered++;if(entered===2)release();await both};
    const [a,b]=await Promise.all([tokenFor(club,cid,first),tokenFor(club,cid,second)]);
    gate=null;
    is("two independent calls returned",[entered>=2,a.length,b.length,a!==b],[true,40,40,true]);
    is("both index writes were confirmed",[await pipeline([["GET",`nl:cm:unsub:${a}`]]),await pipeline([["GET",`nl:cm:unsub:${b}`]])],[[`${cid}|${m.key}|${club.handle}`],[`${cid}|${m.key}|${club.handle}`]]);
    const links=await Promise.all([readCommunityUnsub(a),readCommunityUnsub(b)]);
    console.log("G_TOKEN_RACE",JSON.stringify({returnedDistinct:a!==b,liveLinks:links.map(Boolean),memberMail:await mailOf(m.key)}));
    is("every returned first link remains a usable stop link",links.map(Boolean),[true,true]);
    const unusable=links[0]?b:a;
    is("pressing either returned link can stop the emails",await stopPress(unusable).then(r=>[r.status,r.text]),[200,"Unsubscribed."]);
    is("the stop from either delivered link is actually saved",await mailOf(m.key),false);
    const usable=links[0]?a:b;
    is("positive control: the last token still works",[await stopPress(usable).then(r=>r.status),await mailOf(m.key)],[200,false]);
  }
  done();
}
void main();
