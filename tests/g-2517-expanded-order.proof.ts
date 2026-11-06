/** Independent opt-in: real readOrder and product, intercepted Stripe JSON only. */
import { addProduct,claimHandle,ensureStatsId,setStripeAccount,setSubscription,storeForEmail } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { paidPeriod } from "./billing-period-fixture";
import { done,is,part } from "./check";
process.env.STRIPE_SECRET_KEY="sk_test_Gmemberproof_only";
const sessionId="cs_test_G2517ExpandedOrder01",subId="sub_G2517Expanded001";
let supplied:unknown={id:subId,status:"active",pause_collection:null};let session:Record<string,unknown>={};let reads=0;
globalThis.fetch=(async (input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input instanceof Request?input.url:input));
 if(u.hostname!=="api.stripe.com"||u.pathname!==`/v1/checkout/sessions/${sessionId}`||(init?.method??"GET")!=="GET")throw Error("unexpected provider operation");
 reads++;return Response.json({...session,subscription:supplied});
}) as typeof fetch;
async function main(){
 const owner="g2517-expanded@example.com";
 await claimHandle(owner,"g2517-expanded","Synthetic access","");await ensureStatsId(owner);await setStripeAccount(owner,"acct_G2517Expanded",true);
 await setSubscription(owner,{customerId:"cus_G2517Expanded",subscriptionId:"sub_G2517Plan001",active:true,tier:"pro",period:paidPeriod()});
 const added=await addProduct(owner,"A paid membership","","29",{interval:"month",trialDays:0,payments:0});if(!added.ok)throw Error("product fixture");
 const store=(await storeForEmail(owner))!;
 session={id:sessionId,status:"complete",payment_status:"paid",mode:"subscription",created:Math.floor(Date.now()/1000),metadata:{store:store.handle,product:added.product.id},customer_details:{email:"g2517-buyer@example.com"},payment_intent:null,currency:"usd"};
 const read=async()=>{reads=0;const result=await readOrder(store,sessionId);is("one real checkout GET, no hidden extra lookup",reads,1);return result;};
 part("Real readOrder denies unidentifiable expanded membership");
 for(const [name,value] of [["missing id",{status:"active",pause_collection:null}],["null id",{id:null,status:"active",pause_collection:null}],["empty id",{id:"",status:"active",pause_collection:null}],["malformed id",{id:"not-a-subscription",status:"active",pause_collection:null}]] as [string,unknown][]){
  supplied=value;const r=await read();is(`${name}: unknown does not become live`,r.state==="paid"?r.membership:"unavailable","ended");console.log("OBSERVED",name,JSON.stringify({state:r.state,membership:r.state==="paid"?r.membership:null}));
 }
 for(const [state,want] of [["active","live"],["past_due","live"],["canceled","ended"]] as const){supplied={id:subId,status:state,pause_collection:null};const r=await read();is(`known ${state} preserves existing access policy`,r.state==="paid"?r.membership:null,want);}
 done();
}
void main();
