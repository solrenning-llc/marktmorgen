/** Captures the actual existing checkout wire contract, NOT durable delivery. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {addOption,addProduct,claimHandle,ensureStatsId,setProductFile,setStripeAccount,setSubscription,storeForEmail,storeFolder} from "@/lib/store";
import {readProduct} from "@/lib/catalog";
import {createCheckout} from "@/lib/store-checkout";
import {selectedDigitalOptionFromOriginal} from "@/lib/digital-option-confirmation";
import {admitOrders} from "@/lib/order-admission";
import {prepareDigitalOptionPreintent,readDigitalOptionPreintent} from "@/lib/digital-option-preintent";
import {confirmationBodyDigest} from "@/lib/order-confirmation-outbox";
import {digitalOptionBodyMatches,captureDigitalOptionRequestSnapshot} from "@/lib/digital-option-body";
import {store as redis} from "./redis-stub";
import {paidPeriod} from "./billing-period-fixture";
import {TEST_CONSENT} from "./digital-consent-fixture";

test("both explicit paid-file choices match the actual original checkout body without another entitlement",async()=>{
 redis.clear();process.env.STRIPE_SECRET_KEY="sk_test_plan_options_stand_in";
 const owner="option-contract@example.test",account="acct_1TestLoom00001";
 await claimHandle(owner,"option-contract","Option contract","");await ensureStatsId(owner);
 await setStripeAccount(owner,account,true);await setSubscription(owner,{customerId:"cus_OptionContract01",subscriptionId:"sub_OptionContract01",active:true,period:paidPeriod()});
 const added=await addProduct(owner,"Original book","Original description","10");assert.ok(added.ok);
 for(const [label,price] of [["Short PDF","27"],["Full PDF","65"]])assert.ok((await addOption(owner,added.product.id,label,price)).ok);
 let store=(await storeForEmail(owner))!,product=(await readProduct(store,added.product.id))!;
 const folder=await storeFolder(owner);
 for(const option of product.options)assert.ok((await setProductFile(owner,option.id,{pathname:`stores/${folder}/${option.id}/book.pdf`,name:"Book.pdf",bytes:1200,contentType:"application/pdf",addedAt:"2026-11-01T00:00:00.000Z"})).ok);
 store=(await storeForEmail(owner))!;product=(await readProduct(store,added.product.id))!;
 const originalFetch=globalThis.fetch;const posted:{body:string;headers:Headers}[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.hostname,"api.stripe.com");
  if(init?.method==="POST"){
   assert.equal(url.pathname,"/v1/checkout/sessions");posted.push({body:String(init.body),headers:new Headers(init.headers)});
   return Response.json({id:"cs_test_OptionContract00000001",url:"https://checkout.stripe.com/c/pay/synthetic-option"});
  }
  return Response.json({object:"list",data:[],has_more:false});
 };
 try{
  for(const option of product.options){
   const selected=selectedDigitalOptionFromOriginal(product,option.id,folder);assert.ok(selected);
   const before=JSON.stringify(product);
   await createCheckout(store,product,"https://example.test",option.id,{digitalConsent:TEST_CONSENT});
   const last=posted.at(-1)!;assert.equal(last.headers.get("Stripe-Account"),account);
   const form=new URLSearchParams(last.body),consent=form.get("metadata[dc]");assert.ok(consent);
   assert.equal(form.get("metadata[option]"),option.id);assert.equal(form.get("line_items[0][price_data][unit_amount]"),String(option.priceCents));
   assert.equal(digitalOptionBodyMatches(last.body,{options:[selected]},option.id,folder,{storeHandle:store.handle,productId:product.id,title:product.title,currency:store.currency,consent,summary:product.summary},60000),true,"actual Checkout wire matches only the selected original option and summary");
   const prepared=new URLSearchParams(last.body),nonce="a".repeat(64);
   prepared.set("metadata[mm_order_origin]","digital-option-v1");prepared.set("metadata[mm_order_intent]",nonce);prepared.set("metadata[mm_order_hash]",confirmationBodyDigest(prepared.toString()));
   const snapshot=captureDigitalOptionRequestSnapshot({store,product,optionId:option.id,folder,body:prepared.toString(),nonce,consent,maximumBytes:60000});
   assert.ok(snapshot,"the original real wire, with explicit future-private markers, fits the closed snapshot");
   assert.equal(snapshot.selected.id,option.id);assert.equal(snapshot.selected.priceCents,option.priceCents);assert.equal(snapshot.permitsCheckout,false);assert.equal(snapshot.grantsAccess,false);
   const admission=await admitOrders(store,1);assert.ok(admission.ok);
   const request={store,product,optionId:option.id,folder,body:prepared.toString(),nonce,consent,maximumBytes:60000,admission};
   assert.equal(await prepareDigitalOptionPreintent({...request,admission:JSON.parse(JSON.stringify(admission))}),null,"cloned admission is not authority");
   const forgedProduct=structuredClone(product);forgedProduct.options.find(o=>o.id===option.id)!.file!.pathname=`stores/forged-folder/${option.id}/book.pdf`;
   assert.equal(await prepareDigitalOptionPreintent({...request,product:forgedProduct,folder:"forged-folder"}),null,"caller file prefix cannot replace the actual admission folder");
   const receipt=await prepareDigitalOptionPreintent(request);assert.ok(receipt,"actual private admission binds the selected original request");
   const retained=readDigitalOptionPreintent(receipt);assert.ok(retained);assert.equal(retained.snapshot.selected.id,option.id);assert.equal(retained.snapshot.body,prepared.toString());
   assert.equal(readDigitalOptionPreintent(JSON.parse(JSON.stringify(receipt))),null,"a reconstructed receipt cannot supply original file authority");
   assert.deepEqual([receipt.admitted,receipt.permitsCheckout,receipt.grantsAccess],[false,false,false]);
   const realNow=Date.now;
   try{const attempt=prepareDigitalOptionPreintent(request);Date.now=()=>NaN;assert.equal(await attempt,null,"an unknown clock after asynchronous preparation cannot authorize a receipt");}
   finally{Date.now=realNow;}

   assert.equal(JSON.stringify(product),before);
   for(const other of product.options.filter(o=>o.id!==option.id))assert.equal(digitalOptionBodyMatches(last.body,{options:[selected]},other.id,folder,{storeHandle:store.handle,productId:product.id,title:product.title,currency:store.currency,consent,summary:product.summary},60000),false);
  }
  assert.equal(posted.length,2,"one existing synthetic Checkout POST for each explicit option");
 }finally{globalThis.fetch=originalFetch;}
});
