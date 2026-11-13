/**
 * Codex G return proof; new signature/token explicit, original g-1924-adversarial retained unchanged separately.
 * Ported onto main's write path (#1924): the answer runs under the program's partner lock and writes by swap over the
 * exact record read (lib/affiliates.ts answerShareChange), in place of the per-person lock and PUT_AFFILIATE.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { affiliateCookieName, changeIdentity, readAffiliate, proposePartnerShare, answerShareChange, decide, listPartners, withPartnerLock } from "@/lib/affiliates";
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
 part("Exact consent: stale and current forms, including replacement in the same second");
 {
  const {store,yes}=await fixture();
  await proposePartnerShare(store,p,{percent:30,products:[A],until},now);
  await proposePartnerShare(store,p,{percent:20,products:[A],until},now+1);
  const shown=await seen(store,p);
  await proposePartnerShare(store,p,{percent:5,products:[A],until},now+1);
  const refused=await yes(shown);
  is("stale exact-token route refuses replacement in the SAME second",[refused.status,refused.headers.get("location")?.includes("partner-none"),(await readAffiliate(store,p))!.share!.percent],[303,true,30]);
  const current=await yes(await seen(store,p));
  is("positive current-token route applies the share actually shown",[current.status,current.headers.get("location")?.includes("partner-yes"),(await readAffiliate(store,p))!.share!.percent],[303,true,5]);
 }
 for(const kind of ["withdraw","remove"] as const){
  part("A partner lock that ran out cannot authorize an old answer's write: "+kind);
  const {store}=await fixture();
  const initial={percent:30,products:[A],...(kind==="withdraw"?{until}:{})};
  const proposed={percent:20,products:[A],...(kind==="withdraw"?{until}:{})};
  await proposePartnerShare(store,p,initial,now);
  await proposePartnerShare(store,p,proposed,now+1);
  const shown=await seen(store,p);
  // Ported onto main's write path: the answer reads the program's people for the cap under the partner lock (HGETALL).
  // While it reads, the lock's lease runs out and a newer writer takes the lock and commits; the old answer must then
  // write nothing (holdLock fails before its write, and its write is a swap over the exact record read).
  const real=redis.pipeline.bind(redis);
  let reached=0,latest:unknown;
  redis.pipeline=(async(commands:(string|number)[][])=>{
   const answer=await real(commands);
   if(reached===0&&commands.some(c=>c[0]==="HGETALL"&&String(c[1]).endsWith(":people"))){
    reached++;
    redis.pipeline=real;
    redis.advance(16_000);
    if(kind==="withdraw")await withPartnerLock(store,()=>proposePartnerShare(store,p,initial,now+12));
    else await decide(store,p,"remove",undefined,now+12);
    const fresh=(await readAffiliate(store,p))!;
    latest=[fresh.status,fresh.share?.percent??null,fresh.terms?.change??null];
   }
   return answer;
  }) as typeof redis.pipeline;
  const result=await answerShareChange(store,p,true,shown,now+2);
  redis.pipeline=real;
  is(kind+": the answer's cap read really ran",reached,1);
  is(kind+": a newer writer committed while it read",latest,kind==="withdraw"?["approved",30,null]:["removed",30,null]);
  const final=(await readAffiliate(store,p))!;
  is(kind+": the old answer wrote nothing",result.ok,false);
  is(kind+": the newer state survives it",kind==="withdraw"?[final.share?.percent,final.terms?.change??null]:[final.status,final.share?.percent],kind==="withdraw"?[30,null]:["removed",30]);
 }
 part("Two partners saying yes at once on the same product never pass the cap together");
 {
  const {store}=await fixture();
  for(const id of [p,q]){
   await proposePartnerShare(store,id,{percent:10,products:[A],until},now);
   await proposePartnerShare(store,id,{percent:40,products:[A],until},now+1);
  }
  const identities=await Promise.all([p,q].map(id=>seen(store,id)));
  // Both answers at once: the partner lock serializes them, so the second reads the first's 40% in its cap.
  const results=await Promise.all([p,q].map((id,i)=>answerShareChange(store,id,true,identities[i],now+2)));
  const committed=20+(await listPartners(store)).reduce((sum,a)=>sum+(a.share?.percent??0),0);
  is("one yes lands, the other is refused by the cap (or waits for the lock)",results.filter(r=>r.ok).length,1);
  is("existing 90 percent ceiling survives concurrent answers",committed<=90,true);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
