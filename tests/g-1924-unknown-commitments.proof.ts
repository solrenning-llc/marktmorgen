/** Codex G return proof; new signature/token explicit, original g-1924-adversarial retained unchanged separately. */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { affiliateCookieName, changeIdentity, readAffiliate, proposePartnerShare, listPartners } from "@/lib/affiliates";
import { POST as answerRoute } from "@/app/api/store/affiliates/partner-answer/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, part, done } from "./check";

const A = "prodaaaaaa", p = "aaaaaaaaaaaa", q = "bbbbbbbbbbbb";
const now = Math.floor(Date.now()/1000), until = now + 90*86400;
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

async function seen(store: Awaited<ReturnType<typeof fixture>>["store"], id: string): Promise<string> {
 const change=(await readAffiliate(store,id))?.terms?.change;
 if(!change)throw new Error("control: waiting proposal missing");
 return changeIdentity(change);
}
async function main(){
 const original=redis.pipeline.bind(redis);
 const actual=async(store:Awaited<ReturnType<typeof fixture>>["store"])=>20+(await listPartners(store)).filter(a=>a.status==="approved").reduce((n,a)=>n+(a.share?.percent??0),0);
 async function arrange(desired:number){
  const f=await fixture();
  await proposePartnerShare(f.store,p,{percent:10,products:[A],until},now);
  await proposePartnerShare(f.store,p,{percent:desired,products:[A],until},now+1);
  await proposePartnerShare(f.store,q,{percent:40,products:[A],until},now+2);
  return f;
 }
 part("The real authenticated partner-answer route has valid positive and cap controls");
 {
  const f=await arrange(20),response=await f.yes(await seen(f.store,p));
  is("a fitting known offer is accepted",[response.status,response.headers.get("location")?.includes("partner-yes"),await actual(f.store)],[303,true,80]);
 }
 {
  const f=await arrange(40),response=await f.yes(await seen(f.store,p));
  is("a known overcommit is refused",[response.status,response.headers.get("location")?.includes("partner-cap"),await actual(f.store)],[303,true,70]);
 }
 for(const shape of ["null-hash","missing-envelope","odd-hash","extra-envelope"] as const){
  part("Unknown other commitments cannot authorize a current-token yes: "+shape);
  const f=await arrange(40),identity=await seen(f.store,p);
  let reads=0;
  redis.pipeline=(async(commands:(string|number)[][])=>{
   const native=await original(commands);
   if(commands.length!==1||commands[0]?.[0]!=="HGETALL"||commands[0][1]!==`nl:aff:${f.store.statsId}:people`)return native;
   reads++;
   const raw=native[0] as string[];
   const at=raw.indexOf(p);const own=[p,raw[at+1]];
   if(shape==="null-hash")return[null];
   if(shape==="missing-envelope")return[];
   if(shape==="odd-hash")return[[...own,q]];
   return[[...own],0];
  }) as typeof redis.pipeline;
  let response:Response|undefined;
  try{response=await f.yes(identity);}finally{redis.pipeline=original;}
  is(shape+": failure injected into actual commitment read",reads>0,true);
  console.log("Unknown-commitment route",shape,response.status,response.headers.get("location"),"reads",reads,"actual committed",await actual(f.store));
  is(shape+": the existing commitment survives an unknown cap read",(await readAffiliate(f.store,p))!.share!.percent,10);
  is(shape+": actual commitments stay within the existing ceiling",(await actual(f.store))<=90,true);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
