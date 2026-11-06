/** Codex G return proof; new signature/token explicit, original g-1924-adversarial retained unchanged separately. */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { affiliateCookieName, acceptPartnership } from "@/lib/affiliates";
import { POST as answerRoute } from "@/app/api/store/affiliates/partner-answer/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, part, done } from "./check";

const A = "prodaaaaaa", p = "aaaaaaaaaaaa", q = "bbbbbbbbbbbb";
async function fixture() {
  redis.clear();
  const owner = "gterms@example.test", handle = "gterms";
  await claimHandle(owner, handle, "G Terms", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner,"acct_1Gtermsxxxxxxxx",true);
  await setSubscription(owner,{customerId:"cus_gterms",subscriptionId:"sub_gterms",active:true,tier:"creator",period:paidPeriod()});
  await setAffiliateSetting(owner,parseAffiliateSetting({enabled:true,percent:20,days:30}));
  const store = (await storeForEmail(owner))!;
  for(const id of [p,q]) await redis.pipeline([["HSET",`nl:aff:${statsId}:people`,id,JSON.stringify({id,email:`${id}@example.test`,code:`c${id}`,status:"approved",appliedAt:1,decidedAt:5,note:"",rate:null,paypal:"",share:null,cleared:null,by:null})]]);
  const token=randomBytes(32).toString("hex");
  const key=`nl:aff:session:${createHash("sha256").update(`nimbus-aff-session:${token}`).digest("hex").slice(0,40)}`;
  await redis.pipeline([["SET",key,JSON.stringify({s:statsId,a:p})]]);
  return {store, async yes(change: string){
    const form=new FormData(); form.set("handle",handle);form.set("answer","yes");form.set("change",change);
    return answerRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/partner-answer",{method:"POST",headers:{cookie:`${affiliateCookieName(handle)}=${token}`,origin:"https://marktmorgen.com",host:"marktmorgen.com"},body:form}));
  }};
}

async function main(){
 const original=redis.pipeline.bind(redis);
 for(const shape of ["native","empty-after-apply","null-after-apply"] as const){
  part("An applied invitation keeps its durable email/code claims: "+shape);
  const {store}=await fixture();
  let injected=0;
  const email="late@example.test";
  redis.pipeline=(async(commands:(string|number)[][])=>{
   const out=await original(commands);
   const commit=commands.length===1&&((commands[0]?.[0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:affiliate-put:v1\n"))||(commands[0]?.[0]==="HSET"&&commands[0][1]===`nl:aff:${store.statsId}:people`));
   if(shape!=="native"&&injected===0&&commit){
    injected++;
    return shape==="empty-after-apply"?[]:[null];
   }
   return out;
  }) as typeof redis.pipeline;
  let result:Awaited<ReturnType<typeof acceptPartnership>>;
  try{result=await acceptPartnership(store,email,{percent:20,products:[A]});}finally{redis.pipeline=original;}
  const people=(await original([["HGETALL",`nl:aff:${store.statsId}:people`]]))[0] as string[];
  const rows=people.filter((_,i)=>i%2===1).map(v=>JSON.parse(v) as {id:string,email:string,code:string,status:string});
  const landed=rows.find(r=>r.email===email);
  if(!landed)throw Error("synthetic control: invitation never applied");
  const [byEmail,byCode]=await original([["HGET",`nl:aff:${store.statsId}:emails`,email],["HGET",`nl:aff:${store.statsId}:codes`,landed.code]]);
  is(shape+": applied record exists",landed.status,"approved");
  is(shape+": only requested injection occurred",injected,shape==="native"?0:1);
  console.log("Applied-invitation result",shape,result.ok?"opened":result.reason,"email/code mapped",[byEmail===landed.id,byCode===landed.id]);
  is(shape+": email claim still names its already-written record",byEmail,landed.id);
  is(shape+": code claim still names its already-written record",byCode,landed.id);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
