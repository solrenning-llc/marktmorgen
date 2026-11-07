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
 for(const mode of ["healthy","malformed-hold","unknown-hold"] as const){
  const {store}=await fixture();let applied=0,backs=0,holds=0;
  const email="late@example.test",peopleKey=`nl:aff:${store.statsId}:people`;
  redis.pipeline=(async(commands:(string|number)[][])=>{
   const out=await original(commands);
   const put=commands.length===1&&commands[0]?.[0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:affiliate-put:v1\n");
   if(mode!=="healthy"&&put&&applied===0){applied++;return[null];}
   if(applied&&commands.length===1&&commands[0]?.[0]==="HGET"&&commands[0][1]===peopleKey){backs++;return["{cut"];}
   if(applied&&commands.length===2&&commands[0]?.[0]==="HGET"&&commands[0][1]===peopleKey&&commands[1]?.[0]==="GET"){
    holds++;return mode==="malformed-hold"?["{cut",out[1]]:[7,out[1]];
   }
   return out;
  }) as typeof redis.pipeline;
  let result:unknown;
  try{result=await acceptPartnership(store,email,{percent:20,products:[A]});}catch(e){result=e instanceof Error?e.constructor.name:String(e);}finally{redis.pipeline=original;}
  const rows=(await original([["HGETALL",peopleKey]]))[0] as string[];
  const found=rows.filter((_,i)=>i%2===1).map(s=>JSON.parse(s) as {id:string;email:string;code:string;status:string}).find(r=>r.email===email);
  if(!found)throw Error("control: applied record missing");
  const refs=await original([["HGET",`nl:aff:${store.statsId}:emails`,email],["HGET",`nl:aff:${store.statsId}:codes`,found.code]]);
  console.log(JSON.stringify({mode,applied,backs,holds,result,refs,stored:found.status}));
  is(mode+": fault reached exactly as planned",[applied,backs,holds>0],mode==="healthy"?[0,0,false]:[1,1,true]);
  is(mode+": durable approved record exists",found.status,"approved");
  is(mode+": both durable claims name the applied record",refs,[found.id,found.id]);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
