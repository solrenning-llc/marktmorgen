/** Identified fixture-only variant of 828de14f: explicit default recurring fields required by strict TS. All assertions unchanged. */
/** Independent G: a real writer creates the off-head products; only the Redis transport reply is altered. */
import { addProduct, claimHandle, ensureStatsId, moveProduct, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { visibleIds } from "@/lib/catalog";
import { policyInput } from "@/lib/store-policy-input";
import { policyFacts } from "@/lib/store-policy-facts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main() {
 redis.clear();
 const owner="g-policy@example.test";
 await claimHandle(owner,"gpolicy","G Policy Shop","");
 await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_GPolicy001",subscriptionId:"sub_GPolicy001",active:true,period:paidPeriod()});
 for(let i=0;i<25;i++) {const p=await addProduct(owner,`Free ${i}`,"","0",null);if(!p.ok)throw Error("fixture free product failed");}
 const ebook=await addProduct(owner,"A paid ebook","","19",null);
 const member=await addProduct(owner,"A paid membership","","9",{interval:"month",trialDays:0,payments:0});
 if(!ebook.ok||!member.ok)throw Error("fixture paid products failed");
 await setProductLink(owner,ebook.product.id,"https://example.test/ebook");
 await moveProduct(owner,ebook.product.id,"bottom");
 await moveProduct(owner,member.product.id,"bottom");
 const store=(await storeForEmail(owner))!;
 is("real writer left both paid listings outside the 24-item head",[visibleIds(store).length,store.catalog.head.some(p=>p.id===ebook.product.id),store.catalog.head.some(p=>p.id===member.product.id)],[27,false,false]);
 const healthy=await policyInput(store);
 is("healthy real read identifies both paid kinds",[healthy.sellsDigital,healthy.sellsMemberships],[true,true]);
 for(const mode of ["recurring-interval","recurring-array","recurring-boolean"]){
  part(mode);
  const real=redis.pipeline.bind(redis);let hits=0;
  redis.pipeline=async(commands:(string|number)[][])=>{
   if(commands.length && commands.every(c=>c[0]==="GET"&&String(c[1]).startsWith("nl:catalog:")&&String(c[1]).includes(":l:"))){
    hits++;
    const out=await real(commands);
    return out.map(raw=>{
      const value=JSON.parse(String(raw));
      if(value.id===member.product.id)value.recurring=mode==="recurring-array"?[]:mode==="recurring-boolean"?true:{...value.recurring,interval:"unknown"};
      return JSON.stringify(value);
    });
   }
   return real(commands);
  };
  let result="unknown";
  try {const input=await policyInput(store);result=JSON.stringify({digital:input.sellsDigital,memberships:input.sellsMemberships,sections:policyFacts(input).map(s=>s.id)});}
  catch { /* The proposed contract is to fail, rather than generate an incomplete policy. */ }
  finally {redis.pipeline=real;}
  console.log("G_POLICY_RESULT",JSON.stringify({mode,hits,result}));
  is(`${mode}: intended real catalog read reached`,hits,1);
  is(`${mode}: unknown catalog never generates incomplete policy`,result,"unknown");
 }
 is("healthy retry still reads the original paid catalog",[(await policyInput(store)).sellsDigital,(await policyInput(store)).sellsMemberships],[true,true]);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
