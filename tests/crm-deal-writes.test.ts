import { NextRequest } from "next/server";
import { CrmDealReadUnavailable, CrmDealWriteUnconfirmed, dropDeal, writeDeal } from "@/lib/crm";
import { DEFAULT_STAGES, MAX_DEALS, type Deal } from "@/lib/crm-rules";
import { createFormOpportunity } from "@/lib/form-opportunity";
import { crmAnswer } from "@/lib/crm-response";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/crm/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
async function main() {
  redis.clear(); process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  let statsId="crm-confirmation", key="nl:crm:deals:"+statsId;
  const deal: Deal={id:"abcdefghij",title:"Proposal",email:"buyer@example.com",cents:10000,stage:"lead00",note:"",createdAt:100,updatedAt:100};
  const original=redis.pipeline, normal=Symbol("normal");
  let preflight:unknown=normal, writeReply:unknown=normal, removeReply:unknown=normal, applied=false, writes=0;
  redis.pipeline=async commands=>{
    if(commands.some(c=>c[0]==="HEXISTS" && c[1]===key) && preflight!==normal){if(preflight instanceof Error)throw preflight;return preflight as unknown[];}
    const action=commands.find(c=>(c[0]==="HDEL" && c[1]===key) || (c[0]==="EVAL" && c[3]===key));
    if(action){writes++;const reply=action[0]==="EVAL"?writeReply:removeReply;if(reply!==normal){if(applied)await original.call(redis,commands);if(reply instanceof Error)throw reply;return reply as unknown[];}}
    return original.call(redis,commands);
  };
  const reset=async()=>{preflight=normal;writeReply=normal;removeReply=normal;applied=false;writes=0;await original.call(redis,[["DEL",key]]);};
  const invalidPreflights=[null,{},[],[null,0,0],[0],[0,0],[0,0,0,0],["0",0,0],[false,0,0],[0,"0",0],[0,-1,0],[1,0,0],[0,1.5,0],[0,NaN,0],[0,Infinity,0],[0,0,-1],[0,0,"0"],[0,0,1.5],[0,0,null],new Error("preflight reply lost")];
  const invalidWrites=[null,{},[],[null],["1"],[true],[2],[-1],[1,1],new Error("write reply lost")];
  try{
    part("Unknown capacity/existence reads never authorize writes");
    for(const reply of invalidPreflights){await reset();preflight=reply;let failed=false;try{await writeDeal(statsId,deal, ROOM);}catch(e){failed=e instanceof CrmDealReadUnavailable;}
      is("unconfirmed preflight is distinguished",failed,true);is("no deal write after unavailable preflight",writes,0);is("deal collection remains absent",(await original.call(redis,[["HLEN",key]]))[0],0);
    }
    part("Deal saves and removals require exact numeric acknowledgements");
    for(const reply of invalidWrites){await reset();writeReply=reply;let failed=false;try{await writeDeal(statsId,deal, ROOM);}catch(e){failed=e instanceof CrmDealWriteUnconfirmed;}
      is("unconfirmed save throws",failed,true);is("save is not retried",writes,1);
      await reset();await original.call(redis,[["HSET",key,deal.id,JSON.stringify(deal)]]);removeReply=reply;failed=false;try{await dropDeal(statsId,deal.id, ROOM);}catch(e){failed=e instanceof CrmDealWriteUnconfirmed;}
      is("unconfirmed removal throws",failed,true);is("removal is not retried",writes,1);is("unapplied removal preserves record",(await original.call(redis,[["HGET",key,deal.id]]))[0],JSON.stringify(deal));
    }
    await reset();writeReply=[];applied=true;let lost=false;try{await writeDeal(statsId,deal, ROOM);}catch(e){lost=e instanceof CrmDealWriteUnconfirmed;}
    is("applied save with lost reply is uncertain",lost,true);is("applied save is not rolled back",(await original.call(redis,[["HGET",key,deal.id]]))[0],JSON.stringify(deal));is("no repeated write after lost reply",writes,1);
    removeReply=[];writes=0;lost=false;try{await dropDeal(statsId,deal.id, ROOM);}catch(e){lost=e instanceof CrmDealWriteUnconfirmed;}
    is("applied deletion with lost reply is uncertain",lost,true);is("deleted record is not recreated",(await original.call(redis,[["HGET",key,deal.id]]))[0],null);is("no repeated deletion",writes,1);
    part("Confirmed capacity and absence retain existing behavior");
    await reset();is("confirmed creation succeeds",await writeDeal(statsId,deal, ROOM),true);is("confirmed update succeeds",await writeDeal(statsId,{...deal,title:"Updated"}, ROOM),true);
    writes=0;preflight=[0,MAX_DEALS,0];is("full collection refuses new deal",await writeDeal(statsId,{...deal,id:"bbbbbbbbbb"}, ROOM),false);is("capacity refusal writes nothing",writes,0);
    preflight=[1,MAX_DEALS,Number((await original.call(redis,[["HSTRLEN",key,deal.id]]))[0])];is("existing deal can still be edited at capacity",await writeDeal(statsId,deal, ROOM),true);
    preflight=normal;is("confirmed deletion succeeds",await dropDeal(statsId,deal.id, ROOM),true);is("confirmed absence returns false",await dropDeal(statsId,deal.id, ROOM),false);writes=0;is("invalid removal id refused",await dropDeal(statsId,"bad", ROOM),false);is("invalid id sends no deletion",writes,0);
    part("API and client distinguish prewrite read failure from uncertain change");
    const owner="crm-write-owner@example.com";await claimHandle(owner,"crm-write-check","CRM Write Check","");await ensureStatsId(owner);const store=(await storeForEmail(owner))!;statsId=store.statsId!;key="nl:crm:deals:"+statsId;const session=await openSession(owner);
    const call=async(body:Record<string,unknown>)=>{const response=await POST(new NextRequest("https://marktmorgen.com/api/store/crm",{method:"POST",headers:{"content-type":"application/json",cookie:SESSION_COOKIE+"="+session},body:JSON.stringify(body)}));return {status:response.status,answer:await response.json()};};
    await reset();preflight=[];const blocked=await call({action:"deal",deal:{title:"Proposal",stage:"lead00"}});
    is("read failure is explicit HTTP 503",[blocked.status,blocked.answer.error],[503,"crm_deal_read_unavailable"]);is("client keeps read failure actionable",crmAnswer(false,blocked.answer),{ok:false,error:"crm_deal_read_unavailable"});is("route writes nothing after unknown preflight",writes,0);
    preflight=normal;writeReply=[];applied=true;const uncertain=await call({action:"deal",deal:{title:"Proposal",stage:"lead00"}});
    is("uncertain save is explicit HTTP 502",[uncertain.status,uncertain.answer.error],[502,"crm_write_unconfirmed"]);is("client enters uncertain-write recovery",crmAnswer(false,uncertain.answer),{ok:false,error:"crm_write_unconfirmed"});is("route does not retry applied save",writes,1);
    const rows=(await original.call(redis,[["HVALS",key]]))[0] as string[];is("applied opportunity remains stored",rows.length,1);
    const saved=JSON.parse(rows[0]);removeReply=[];writes=0;const removed=await call({action:"undeal",id:saved.id});
    is("uncertain deletion is explicit HTTP 502",[removed.status,removed.answer.error],[502,"crm_write_unconfirmed"]);is("deleted record stays absent",(await original.call(redis,[["HGET",key,saved.id]]))[0],null);is("route does not repeat deletion",writes,1);
  }finally{redis.pipeline=original;}
  part("Concurrent manual saves and form conversions share the same capacity");
  const raceStore = "crm-capacity-race", raceKey = "nl:crm:deals:" + raceStore;
  for (let i = 0; i < MAX_DEALS - 1; i++) await redis.pipeline([["HSET", raceKey, "f" + String(i).padStart(9, "0"), "existing"]]);
  const outcomes = await Promise.all(Array.from({ length: 64 }, async (_, i) => {
    if (i % 2 === 0) return await writeDeal(raceStore, { ...deal, id: "m" + String(i).padStart(9, "0") }, ROOM) ? "created" : "full";
    const ref = String(i).padStart(10, "0") + "a".repeat(54);
    return (await createFormOpportunity(raceStore, ref, deal, DEFAULT_STAGES, ROOM)).state;
  }));
  is("only one of 64 competing manual/form creations can occupy the last slot", [outcomes.filter(result => result === "created").length, outcomes.filter(result => result === "full").length, (await redis.pipeline([["HLEN", raceKey]]))[0]], [1, 63, MAX_DEALS]);
  is("existing records remain editable at capacity", await writeDeal(raceStore, { ...deal, id: "f000000000", title: "Edited at capacity" }, ROOM), true);
  is("editing at capacity leaves the count unchanged", (await redis.pipeline([["HLEN", raceKey]]))[0], MAX_DEALS);
  await redis.pipeline([["HDEL", raceKey, "f000000000"]]);
  is("deleting a record frees one slot for a new manual deal", await writeDeal(raceStore, { ...deal, id: "replacement".slice(0, 10) }, ROOM), true);
  is("capacity remains bounded after slot reuse", (await redis.pipeline([["HLEN", raceKey]]))[0], MAX_DEALS);
  done();
}
void main();
