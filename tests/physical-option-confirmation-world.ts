/** Synthetic provider/ACK boundary for original physical-option checkout. */
import assert from 'node:assert/strict';
import {createCheckout} from '@/lib/store-checkout';
import {readConfirmationOrigin} from '@/lib/order-confirmation-outbox';
import {physicalPaidFixture,originId} from './order-confirmation-paid-fixture';
export async function optionCheckout(priceCents=6500,shippingCents=500,sku?:string){
 const f=await physicalPaidFixture();
 const selected={id:'large_print',label:'Large print',priceCents,file:null,link:null,details:['Original edition'],best:false,...(sku===undefined?{}:{sku})};
 f.product.options=[{...selected,id:'standard',label:'Standard',priceCents:3500},selected];
 f.product.shipping={...f.product.shipping!,cents:shippingCents};
 f.runtime.policy={...f.runtime.policy!,coveredOrigins:['physical-option-confirmation']};
 const provider=f.runtime.provider!;
 f.runtime.provider=async(method,account,path,body,version,key)=>{
  if(method==='POST'){
   const origin=await readConfirmationOrigin(originId(),f.runtime);assert.ok(origin);
   const product=origin.payload.snapshot.product as {options:typeof selected[]};
   assert.deepEqual(product.options,[selected],'only the exact selected choice precedes the payment POST');
   assert.equal(new URLSearchParams(origin.payload.body).get('line_items[0][price_data][unit_amount]'),String(priceCents));
  }
  const result=await provider(method,account,path,body,version,key);
  if(method==='POST'){
   const row=result as Record<string,unknown>;
   row.line_items={object:'list',has_more:false,data:[{quantity:1,price:{unit_amount:priceCents,currency:'usd'}}]};
  }
  return result;
 };
 return{...f,selected};
}
export async function purchased(priceCents=6500,shippingCents=500,sku?:string){
 const f=await optionCheckout(priceCents,shippingCents,sku);
 const checkout=await createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime);
 const session=f.sessions.get(checkout.id)!;assert.ok(session);
 const amount=priceCents+shippingCents;
 Object.assign(session,{customer_details:{email:'buyer@example.test'},status:'complete',payment_status:amount?'paid':'no_payment_required',amount_total:amount,
  ...(amount?{payment_intent:{object:'payment_intent',status:'succeeded',amount_received:amount,currency:'usd',
   latest_charge:{object:'charge',paid:true,amount,amount_refunded:0,currency:'usd',refunded:false}}}:{}),
  shipping_details:{name:'Original Buyer',address:{line1:'1 Original Street',city:'Test City',country:'US'}}});
 return{...f,checkout,session,id:originId()};
}
