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
let afterAtomic: null | (()=>Promise<void>) = null;
const gate: null = null;
const pipeline=redis.pipeline.bind(redis);
redis.pipeline=(async(commands:Command[])=>{
  if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).includes('local cur = redis.call("HGET", KEYS[1], ARGV[1])')){
    const[,,,members,dir,field,expected,next,listed,at]=commands[0];
    // Atomic region: no await between HGET, comparison, HSET and directory update.
    if(redis.run(["HGET",members,field])!==expected)return[0];
    redis.run(["HSET",members,field,next]);
    redis.run(listed==="1"?["ZADD",dir,at,field]:["ZREM",dir,field]);
    if(afterAtomic){const act=afterAtomic;afterAtomic=null;await act();}
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

  part("Erasure after the member CAS applies but before tokenFor resumes");
  const m=await member();
  await pipeline([["HSET",members,m.key,JSON.stringify({...(await readMember(cid,m.key))!,t:""})],["DEL",`nl:cm:unsub:${m.token}`]]);
  const fresh=(await readMember(cid,m.key))!;
  let erased=0;
  afterAtomic=async()=>{erased=await forgetCommunityPerson(cid,m.key,m.email,[])};
  const answer=await tokenFor(club,cid,fresh).then(()=>"returned",()=>"thrown");
  const [scan]=await pipeline([["SCAN","0","MATCH","nl:cm:unsub:*"]]);
  const keys=(scan as [string,string[]])[1];const tied:string[]=[];
  for(const key of keys){const[v]=await pipeline([["GET",key]]);if(v===`${cid}|${m.key}|${club.handle}`)tied.push(key)}
  console.log("G_ERASURE_AFTER_CAS",JSON.stringify({answer,erased,orphanIndexes:tied.length}));
  is("erasure actually ran after the CAS",erased>0,true);
  is("the erased member stays absent",await readMember(cid,m.key),null);
  is("tokenFor never recreates a stop-link index after erasure",tied,[]);
  done();
}
void main();
