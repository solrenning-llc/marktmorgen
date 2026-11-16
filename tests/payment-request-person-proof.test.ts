import { createRequest } from "@/lib/payment-request-store";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestLimitsFor, type RequestDraft } from "@/lib/payment-request-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
async function main() {
 redis.clear();
 const owner="synthetic-person-proof@example.com";
 await claimHandle(owner,"personproof","Synthetic store","");
 await ensureStatsId(owner);await ensureStoreId(owner);
 await setStripeAccount(owner,"acct_fixture010",true);
 const paid=await setSubscription(owner,{customerId:"cus_personproof",subscriptionId:"sub_personproof",active:true,tier:"creator",period:paidPeriod()});
 if (!paid?.subscriptionActive) throw new Error("Synthetic subscription fixture was not accepted");
 const store=(await storeForEmail(owner))!;
 if (requestLimitsFor(store).open <= 0) throw new Error("Synthetic paid fixture cannot exercise admission");
 const original=redis.pipeline;
 const id="a".repeat(32);
 const draft={email:"synthetic-recipient@example.com",name:"Synthetic",lines:[{text:"Synthetic work",quantity:1,cents:100}],total:100,note:"",dueDate:"",autoReminders:0} as RequestDraft;
 let calls:(string|number)[][]=[];
 const attempt=async (members:unknown,exists?:unknown) => {
  calls=[];
  redis.pipeline=async commands=>{
   calls.push(...commands);
   if(commands[0]?.[0]==="SMEMBERS")return members as unknown[];
   if(commands[0]?.[0]==="EXISTS")return exists as unknown[];
   if(commands[0]?.[0]==="SREM")return [1];
   // The new request's own write lock (lib/payment-request-store.ts), taken just before it is counted, and let go.
   if(commands[0]?.[0]==="SET"&&String(commands[0][1]).startsWith("nl:payreq:w:"))return ["OK"];
   if(commands[0]?.[0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:release:v1"))return [1];
   throw new Error("Synthetic stop before admission writes");
  };
  return createRequest(store,draft);
 };
 part("Unverified person index never authorizes cleanup or admission");
 for(const members of [null,[],[null],[[null]],[["bad"]],[[id,id]],[[id],[]]]) {
  const result=await attempt(members);
  is("unknown membership refused",result.ok? "accepted":result.reason,"unavailable");
  is("unknown membership leaves references",calls.some(c=>c[0]==="SREM"),false);
  is("unknown membership never reaches reservation",calls.some(c=>c[0]==="ZADD"),false);
 }
 for(const exists of [null,[],[null],[undefined],["0"],[false],[2],[0,1]]) {
  const result=await attempt([[id]],exists);
  is("unknown existence refused",result.ok?"accepted":result.reason,"unavailable");
  is("unknown existence preserves person references",calls.some(c=>c[0]==="SREM"),false);
  is("unknown existence stops before reservations",calls.some(c=>c[0]==="ZADD"),false);
 }
 part("Only verified absence removes the indexed person reference");
 await attempt([[id]],[1]);
 is("verified live reference retained",calls.some(c=>c[0]==="SREM"),false);
 await attempt([[id]],[0]);
 is("verified absent reference alone removed",calls.filter(c=>c[0]==="SREM").map(c=>c.slice(2)),[[id]]);
 await attempt([[]]);
 is("verified empty membership reaches ordinary admission",calls.some(c=>c[0]==="ZADD"),true);
 redis.pipeline=original;
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
