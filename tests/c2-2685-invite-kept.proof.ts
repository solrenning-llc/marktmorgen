/** Opt-in delta proof: an unreadable kept state must not reopen an off-sale invitation price. */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, noteKept, openMove, readInvite, readMove } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

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

function markOffSale(id:string){
 const visit=(v:unknown):unknown=>{
  if(Array.isArray(v))return v.map(visit);
  if(!v||typeof v!=="object")return v;
  const out=Object.fromEntries(Object.entries(v).map(([key,value])=>[key,visit(value)]));
  if(out.id===id&&typeof out.priceCents==="number"&&"label"in out)out.offSale=true;
  return out;
 };
 for(const key of redis.keys()){
  if(redis.run(["TYPE",key])!=="string")continue;
  const raw=redis.run(["GET",key]);
  if(typeof raw!=="string"||!raw.includes(id))continue;
  try{redis.run(["SET",key,JSON.stringify(visit(JSON.parse(raw)))]);}catch{}
 }
}

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
 const invite=(await readInvite(store.statsId!,field))!,fresh=(await readInvite(store.statsId!,freshField))!;
 await noteKept(store,"kept@example.com",club.product.id);
 markOffSale(basic);store=(await storeForEmail(email))!;
 is("actual stored Basic is off sale",(await readProduct(store,club.product.id))?.options.find(o=>o.id===basic)?.offSale,true);
 is("valid kept control was recorded",(await readInvite(store.statsId!,field))!.kept>0,true);
 is("same token still identifies the store/product invitation",(await readMove(store,club.product.id,invite.t))?.field,field);
 let before=checkouts;const publicControl=await openMove(store,club.product.id,fresh.t,"https://marktmorgen.com",Date.now(),TEST_CONSENT);
 is("unkept on-sale invitation still opens exactly once",[publicControl.ok,checkouts-before],[true,1]);
 before=checkouts;const used=await openMove(store,club.product.id,invite.t,"https://marktmorgen.com",Date.now(),TEST_CONSENT);
 is("valid used invitation cannot reopen the off-sale price",[used.ok,checkouts-before],[false,0]);
 const key=`nl:mv:${store.statsId}`;
 const [raw]=await redis.pipeline([["HGET",key,field]]);if(typeof raw!=="string")throw Error("record fixture missing");
 const original=JSON.parse(raw) as Record<string,unknown>;
 part("Unknown kept state is not an unused entitlement");
 try{
  for(const [label,kept] of [["null",null],["false",false],["empty text",""],["unreadable text","not-a-count"],["array",[]],["object",{}]] as const){
   await redis.pipeline([["HSET",key,field,JSON.stringify({...original,kept})]]);
   before=checkouts;
   const result=await openMove(store,club.product.id,invite.t,"https://marktmorgen.com",Date.now(),TEST_CONSENT);
   is("unreadable state refuses reopening: "+label,result.ok,false);
   is("no provider checkout from unknown eligibility: "+label,checkouts-before,0);
  }
 }finally{await redis.pipeline([["HSET",key,field,raw]]);}
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
