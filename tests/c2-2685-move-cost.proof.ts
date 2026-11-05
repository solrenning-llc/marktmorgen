import { POST } from "@/app/api/store/move/open/route";
import { NextRequest } from "next/server";
import { AFFILIATE_STRIPE_PAGES_PER_UNIT } from "@/lib/public-read-rules";
/** Opt-in delta proof: an unreadable kept state must not reopen an off-sale invitation price. */
import { withConsent } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, readInvite } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

let checkouts=0;
globalThis.fetch=(async(input,init)=>{
 const url=new URL(String(input instanceof Request?input.url:input));
 if(url.hostname!=="api.stripe.com")return new Response(null,{status:404});
 if(url.pathname.endsWith("/checkout/sessions")&&(init?.method??"GET")==="POST"){
  checkouts++;
  return new Response(JSON.stringify({id:`cs_test_${"k".repeat(20)}${checkouts}`,url:"https://checkout.stripe.com/c/pay/synthetic"}));
 }
 if((init?.method??"GET")==="GET")return new Response(JSON.stringify({object:"list",data:[],has_more:false}));
 return new Response(null,{status:404});
}) as typeof fetch;

async function main(){
 redis.clear();process.env.STRIPE_SECRET_KEY="sk_test_c2_move_kept_only";
 const email="kept-evidence@example.com";
 const made=await claimHandle(email,"kepteevidence","Synthetic invitation","");if(!made.ok)throw Error("store fixture failed");
 await ensureStatsId(email);await setStripeAccount(email,"acct_TestMove0001",true);
 await setSubscription(email,{customerId:"cus_TestMove0001",subscriptionId:"sub_TestMove0001",active:true,period:paidPeriod()});
 const club=await addProduct(email,"Synthetic membership","","29",{interval:"month",trialDays:0,payments:0});if(!club.ok)throw Error("product fixture failed");
 await addOption(email,club.product.id,"Basic","19");await addOption(email,club.product.id,"Plus","39");
 let store=(await storeForEmail(email))!;
 const [basic,plus]=(await readProduct(store,club.product.id))!.options.map(o=>o.id);
 await setProductLink(email,basic,"https://example.com/basic");await setProductLink(email,plus,"https://example.com/plus");
 store=(await storeForEmail(email))!;
 const fields=await inviteMembers(store,"job_c2_kept",[
  {email:"kept@example.com",productId:club.product.id,option:basic,renews:Math.floor(Date.now()/1000)+20*86400},
  {email:"fresh@example.com",productId:club.product.id,option:plus,renews:Math.floor(Date.now()/1000)+20*86400},
 ]);
 const [field,freshField]=fields;if(!field||!freshField)throw Error("invite fixture failed");
 const fresh=(await readInvite(store.statsId!,freshField))!;
 const originalFetch=globalThis.fetch;
 let gets=0,bytes=0,paidBefore=-1;
 const units=()=>redis.keys().filter(key=>key.startsWith("nl:traffic:r:")).reduce((sum,key)=>sum+Number(redis.run(["GET",key])),0);
 globalThis.fetch=(async(input,init)=>{
  const url=new URL(String(input instanceof Request?input.url:input));
  if(url.hostname==="api.stripe.com"&&(init?.method??"GET")==="GET"){
   if(paidBefore<0)paidBefore=units();gets++;
   const data=url.pathname.endsWith("/customers")?Array.from({length:100},(_,i)=>({id:"cus_Cost"+i})):url.pathname.endsWith("/subscriptions")?Array.from({length:100},(_,i)=>({id:"sub_Cost"+i,status:"canceled",metadata:{product:club.product.id}})):null;
   const text=JSON.stringify(data?{object:"list",data,has_more:false}:{object:"checkout.session",expires_at:Math.floor(Date.now()/1000)+3600});bytes+=Buffer.byteLength(text);return new Response(text);
  }
  return originalFetch(input,init);
 }) as typeof fetch;
 const form=withConsent(new URLSearchParams({handle:store.handle,product:club.product.id,k:fresh.t}));
 const before=checkouts;
 const response=await POST(new NextRequest("https://marktmorgen.com/api/store/move/open",{method:"POST",headers:{host:"marktmorgen.com",origin:"https://marktmorgen.com","content-type":"application/x-www-form-urlencoded"},body:form.toString()}));
 is("real route opens the valid synthetic invitation",[response.status,response.headers.get("location")?.startsWith("https://checkout.stripe.com/")],[303,true]);
 is("fixture reaches one customer page,100 subscription pages and session closing read",gets,102);
 is("one synthetic checkout only",checkouts-before,1);
 console.log(JSON.stringify({paidBefore,paidAfter:units(),stripeGetPages:gets,transferredBytes:bytes,existingPublicStripePagesPerUnit:AFFILIATE_STRIPE_PAGES_PER_UNIT}));
 // Existing public-request Stripe-page cost uses one page per unit. A dynamic fanout must be covered before IO.
 is("existing public Stripe-page work is counted before its first read",paidBefore>=Math.ceil(gets/AFFILIATE_STRIPE_PAGES_PER_UNIT),true);
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
