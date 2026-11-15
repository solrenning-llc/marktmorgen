import { createAgreement } from "@/lib/agreement-store";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { agreementsAllowed, MAX_KEPT_AGREEMENTS, MAX_PER_PERSON, type AgreementDraft } from "@/lib/agreement-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
async function main() {
 redis.clear();
 const owner="synthetic-person-proof@example.com";
 await claimHandle(owner,"agreementproof","Synthetic store","");
 await ensureStatsId(owner);await ensureStoreId(owner);
 await setStripeAccount(owner,"acct_fixture001",true);
 const paid=await setSubscription(owner,{customerId:"cus_agreementproof",subscriptionId:"sub_agreementproof",active:true,tier:"creator",period:paidPeriod()});
 if (!paid?.subscriptionActive) throw new Error("Synthetic subscription fixture was not accepted");
 const store=(await storeForEmail(owner))!;
 if (!agreementsAllowed(store)) throw new Error("Synthetic paid fixture cannot exercise admission");
 const original=redis.pipeline;
 const id="a".repeat(32);
 const draft: AgreementDraft={kind:"agreement",email:"synthetic-recipient@example.com",name:"Synthetic",title:"Synthetic agreement",body:"Synthetic terms",lines:[{text:"Synthetic work",quantity:1,cents:100}],total:100,payRequest:""};
 let calls:(string|number)[][]=[];
 const attempt=async (members:unknown,exists?:unknown) => {
  calls=[];
  redis.pipeline=async commands=>{
   calls.push(...commands);
   if(commands[0]?.[0]==="SMEMBERS")return members as unknown[];
   if(commands[0]?.[0]==="EXISTS")return exists as unknown[];
   if(commands[0]?.[0]==="SREM")return [1];
   throw new Error("Synthetic stop before admission writes");
  };
  return createAgreement(store,draft);
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
 part("Admission requires exact numeric reservation and expiry receipts");
 const countAttempt=async (receipt:unknown) => {
  calls=[];
  redis.pipeline=async commands=>{
   calls.push(...commands);
   if(commands[0]?.[0]==="SMEMBERS")return [[]];
   if(commands[0]?.[0]==="ZREMRANGEBYSCORE")return receipt as unknown[];
   if(commands[0]?.[0]==="SET" && String(commands[0]?.[1]).startsWith("nl:agree:v:"))return ["OK","OK"];
   return original(commands);
  };
  try { return await createAgreement(store,draft); }
  finally { redis.pipeline=original; }
 };
 const admitted=[0,1,1,1,1,1,1];
 const unknownAdmissions:unknown[]=[null,undefined,[],admitted.slice(0,6),[...admitted,1],Array(7)];
 for(let i=0;i<admitted.length;i++)for(const bad of [null,undefined,"1",true,-1,0.5,Number.MAX_SAFE_INTEGER+1]) {
  const receipt:unknown[]=[...admitted];receipt[i]=bad;unknownAdmissions.push(receipt);
 }
 for(const i of [1,2,3,4,5,6]){const receipt=[...admitted];receipt[i]=0;unknownAdmissions.push(receipt);}
 for(const receipt of unknownAdmissions) {
  const result=await countAttempt(receipt);
  is("unknown admission refuses saving",result.ok?"accepted":result.reason,"unavailable");
  is("unknown admission never writes agreement records",calls.some(c=>c[0]==="SET" && String(c[1]).startsWith("nl:agree:")),false);
  is("unknown admission retains uncertain memberships",calls.some(c=>c[0]==="ZREM" || c[0]==="SREM" || c[0]==="DEL"),false);
 }
 const ordinary=await countAttempt(admitted);
 is("verified admission can save the agreement",ordinary.ok,true);
 const storeFull=await countAttempt([0,1,1,MAX_KEPT_AGREEMENTS+1,1,1,1]);
 is("known store cap keeps existing refusal",storeFull.ok?"accepted":storeFull.reason,"kept");
 is("known over-cap membership is compensated",calls.filter(c=>c[0]==="ZREM" || c[0]==="SREM").map(c=>c[0]),["ZREM","SREM"]);
 const personFull=await countAttempt([0,1,1,1,MAX_PER_PERSON+1,1,1]);
 is("known person cap keeps existing refusal",personFull.ok?"accepted":personFull.reason,"person");
 is("known person cap never writes a record",calls.some(c=>c[0]==="SET" && String(c[1]).startsWith("nl:agree:")),false);

 part("Both agreement records need explicit write acknowledgments");
 const writeAttempt=async (receipt:unknown) => {
  calls=[];
  redis.pipeline=async commands=>{
   calls.push(...commands);
   if(commands[0]?.[0]==="SMEMBERS")return [[]];
   if(commands[0]?.[0]==="ZREMRANGEBYSCORE")return [0,1,1,1,1,1,1];
   if(commands[0]?.[0]==="SET" && String(commands[0]?.[1]).startsWith("nl:agree:v:"))return receipt as unknown[];
   return original(commands);
  };
  try { return await createAgreement(store,draft); }
  finally { redis.pipeline=original; }
 };
 for(const receipt of [null,undefined,[],["OK"],["OK","OK","OK"],[null,"OK"],["OK",null],[undefined,"OK"],["OK",undefined],[true,"OK"],["OK",1],["ok","OK"],Array(2)]) {
  const result=await writeAttempt(receipt);
  is("unverified record receipt refuses success",result.ok?"accepted":result.reason,"unavailable");
  is("both existing writes attempted once",calls.filter(c=>c[0]==="SET" && String(c[1]).startsWith("nl:agree:")).length,2);
  is("uncertain persistence retains references",calls.some(c=>c[0]==="ZREM" || c[0]==="SREM" || c[0]==="DEL"),false);
 }
 const confirmed=await writeAttempt(["OK","OK"]);
 is("two confirmed records return saved agreement",confirmed.ok,true);
 is("confirmed agreement retains exact first-version fingerprint",confirmed.ok && confirmed.agreement.versions[0]?.sha256===confirmed.version.sha256,true);
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
