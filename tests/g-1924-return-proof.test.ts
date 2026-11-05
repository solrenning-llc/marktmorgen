/** Codex G return proof; new signature/token explicit, original g-1924-adversarial retained unchanged separately. */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, setAffiliateSetting } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { affiliateCookieName, changeIdentity, readAffiliate, proposePartnerShare, answerShareChange, sharePromiseProblem, decide, listPartners } from "@/lib/affiliates";
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
  part("Expired person lock cannot authorize an old whole-record write: "+kind);
  const {store}=await fixture();
  const initial={percent:30,products:[A],...(kind==="withdraw"?{until}:{})};
  const proposed={percent:20,products:[A],...(kind==="withdraw"?{until}:{})};
  await proposePartnerShare(store,p,initial,now);
  await proposePartnerShare(store,p,proposed,now+1);
  let reached=0,latest:unknown;
  const result=await answerShareChange(store,p,true,await seen(store,p),now+2,async()=>{
   reached++;
   // Deterministic Redis TTL advance, no sleep or product mutation.
   redis.advance(11_000);
   if(kind==="withdraw")await proposePartnerShare(store,p,initial,now+12);
   else await decide(store,p,"remove",now+12);
   const fresh=(await readAffiliate(store,p))!;
   latest=[fresh.status,fresh.share?.percent??null,fresh.terms?.change??null];
   return true;
  });
  is(kind+": original cap hook really ran",reached,1);
  is(kind+": newer writer committed before stale answer resumes",latest,kind==="withdraw"?["approved",30,null]:["removed",null,null]);
  const final=(await readAffiliate(store,p))!;
  console.log("Expired-lock result",kind,result,final.status,final.share?.percent);
  is(kind+": newer state survives stale answer",kind==="withdraw"?[final.share?.percent,final.terms?.change??null]:[final.status,final.share],kind==="withdraw"?[30,null]:["removed",null]);
 }
 part("Different partners still need one atomic product commitment");
 {
  const {store}=await fixture();
  for(const id of [p,q]){
   await proposePartnerShare(store,id,{percent:10,products:[A],until},now);
   await proposePartnerShare(store,id,{percent:40,products:[A],until},now+1);
  }
  const identities=await Promise.all([p,q].map(id=>seen(store,id)));
  let ready=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const results=await Promise.all([p,q].map((id,i)=>answerShareChange(store,id,true,identities[i],now+2,async share=>{
   const allowed=(await sharePromiseProblem(store,id,share,now+2))===null;
   ready++;if(ready===2)release();await barrier;return allowed;
  })));
  is("both REAL cap checks ran before commit",ready,2);
  console.log("Concurrent current-token results",results);
  const committed=20+(await listPartners(store)).reduce((sum,a)=>sum+(a.share?.percent??0),0);
  console.log("Committed percent",committed);
  is("existing 90 percent ceiling survives current-token concurrent answers",committed<=90,true);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
