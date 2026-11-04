/** Real checkout/worker orchestration; synthetic provider/ACK boundary only. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCheckout} from '@/lib/store-checkout';
import {readConfirmationOrigin,runOrderConfirmationMail,openConfirmationOrigin,CONFIRMATION_ORIGIN_SCRIPT,confirmationOriginRowKey} from '@/lib/order-confirmation-outbox';
import {COMMIT_ORDER_CONFIRMATION} from '@/lib/orders';
import {originalPhysicalConfirmation} from '@/lib/purchase-email';
import {physicalPaidFixture,originId,confirmationLocalPipeline} from './order-confirmation-paid-fixture';

async function optionCheckout(priceCents=6500,shippingCents=500){
 const f=await physicalPaidFixture();
 const selected={id:'large_print',label:'Large print',priceCents,file:null,link:null,details:['Original edition'],best:false};
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
async function purchased(priceCents=6500,shippingCents=500){
 const f=await optionCheckout(priceCents,shippingCents);
 const checkout=await createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime);
 const session=f.sessions.get(checkout.id)!;assert.ok(session);
 const amount=priceCents+shippingCents;
 Object.assign(session,{customer_details:{email:'buyer@example.test'},status:'complete',payment_status:amount?'paid':'no_payment_required',amount_total:amount,
  ...(amount?{payment_intent:{object:'payment_intent',status:'succeeded',amount_received:amount,currency:'usd',
   latest_charge:{object:'charge',paid:true,amount,amount_refunded:0,currency:'usd',refunded:false}}}:{}),
  shipping_details:{name:'Original Buyer',address:{line1:'1 Original Street',city:'Test City',country:'US'}}});
 return{...f,checkout,session,id:originId()};
}
test('selected option is protected before the sole original-account checkout POST',async()=>{
 const f=await optionCheckout(),checkout=await createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime);
 assert.ok(checkout.url.startsWith('https://checkout.stripe.com/'));
 const found=await readConfirmationOrigin(originId(),f.runtime);assert.ok(found);assert.equal(found.row.session,checkout.id);
 const product=found.payload.snapshot.product as {priceCents:number;options:typeof f.selected[]};
 assert.equal(product.priceCents,3500);assert.deepEqual(product.options,[f.selected]);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.ok(f.calls.every(c=>c.account==='acct_TestOrigin01'));
});
test('active physical option with no express funding never reaches payment creation',async()=>{
 for(const coveredOrigins of [undefined,['single-digital-confirmation']] as const){
  const f=await optionCheckout();f.runtime.policy={...f.runtime.policy!,coveredOrigins:coveredOrigins?[...coveredOrigins]:undefined};
  await assert.rejects(createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime));
  assert.equal(f.calls.length,0);
 }
});
test('73-hour receipt and accounting retain the original option after catalog edits',async()=>{
 const f=await purchased();f.advance(73*3600000);
 const original=await readConfirmationOrigin(f.id,f.runtime);assert.ok(original);
 f.product.options[1].label='Changed option';f.product.options[1].priceCents=1;f.product.title='Changed title';f.store.name='Changed store';
 let sent=0;
 const result=await runOrderConfirmationMail(f.runtime.now!()+30000,async(message,beforePost)=>{
  assert.ok(message.text.includes('Original printed book (Large print)'));assert.ok(message.text.includes('Original printed store'));
  assert.equal(message.text.includes('Changed'),false);assert.match(message.text,/\$70(?:\.00)?\b/);assert.equal(await beforePost(),true);sent++;return'accepted';
 },f.runtime,f.id);
 assert.equal(result.accepted,1);assert.equal(sent,1);assert.equal(await readConfirmationOrigin(f.id,f.runtime),null);
 await runOrderConfirmationMail(f.runtime.now!()+30000,async()=>{sent++;return'accepted';},f.runtime,f.id);
 assert.equal(sent,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('selected zero with paid shipping is a paid total, while zero total invents no discount',async()=>{
 for(const shippingCents of [500,0]){
  const f=await purchased(0,shippingCents);f.advance(73*3600000);
  const found=await readConfirmationOrigin(f.id,f.runtime);assert.ok(found);
  const store=found.payload.snapshot.store as typeof f.store,product=found.payload.snapshot.product as typeof f.product;
  const letter=originalPhysicalConfirmation(store,f.session,product);assert.ok(letter);
  assert.match(letter.text,shippingCents?/\$5(?:\.00)?\b/:/\$0(?:\.00)?\b/);assert.equal(/discount|coupon/i.test(letter.text),false);
  let sent=0;await runOrderConfirmationMail(f.runtime.now!()+30000,async(message,beforePost)=>{
   assert.equal(message.text,letter.text);assert.equal(await beforePost(),true);sent++;return'accepted';
  },f.runtime,f.id);assert.equal(sent,1);
 }
});
test('unknown accounting keeps the accepted option source across73h without another send',async()=>{
 const f=await purchased();f.advance(61000);f.setAccounting('unknown');let sent=0;
 const send=async(_message:unknown,beforePost:()=>Promise<boolean>)=>{assert.equal(await beforePost(),true);sent++;return'accepted' as const;};
 await runOrderConfirmationMail(f.runtime.now!()+30000,send,f.runtime,f.id);
 assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.phase,'accepted');
 f.advance(73*3600000);await runOrderConfirmationMail(f.runtime.now!()+30000,send,f.runtime,f.id);assert.equal(sent,1);
 f.setAccounting('committed');f.advance(74*3600000);await runOrderConfirmationMail(f.runtime.now!()+30000,send,f.runtime,f.id);
 assert.equal(sent,1);assert.equal(await readConfirmationOrigin(f.id,f.runtime),null);
});
test('withdrawing express coverage holds the source and denies URL or email until covered again',async()=>{
 const f=await purchased(),policy=f.runtime.policy!;f.advance(73*3600000);
 f.runtime.policy={...policy,coveredOrigins:undefined};let sent=0;
 assert.equal(await openConfirmationOrigin(f.id,f.runtime),null);
 const before=(await readConfirmationOrigin(f.id,f.runtime))!.raw;
 await runOrderConfirmationMail(f.runtime.now!()+30000,async()=>{sent++;return'accepted';},f.runtime,f.id);
 assert.equal(sent,0);assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.raw,before);
 f.runtime.policy=policy;
 await runOrderConfirmationMail(f.runtime.now!()+30000,async(_m,barrier)=>{assert.equal(await barrier(),true);sent++;return'accepted';},f.runtime,f.id);assert.equal(sent,1);
});
test('a grant withdrawn inside dispatch cannot authorize its permanent send barrier',async()=>{
 const f=await purchased();f.advance(61000);let sent=0,attempts=0;
 await runOrderConfirmationMail(f.runtime.now!()+30000,async(_m,barrier)=>{
  attempts++;f.runtime.policy={...f.runtime.policy!,coveredOrigins:undefined};if(await barrier())sent++;return'not_accepted';
 },f.runtime,f.id);assert.equal(attempts,1);assert.equal(sent,0);assert.ok(await readConfirmationOrigin(f.id,f.runtime));
});

test('an open payment URL cannot be exposed through a later generic physical review',async()=>{
 const f=await optionCheckout();await createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime);
 const id=originId(),policy=f.runtime.policy!;f.runtime.policy={...policy,coveredOrigins:undefined};
 assert.equal(await openConfirmationOrigin(id,f.runtime),null);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 f.runtime.policy=policy;assert.ok(await openConfirmationOrigin(id,f.runtime));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('an option priced zero never turns unpaid shipping into a free settled purchase',async()=>{
 const f=await purchased(0,500);f.advance(73*3600000);
 f.session.payment_status='no_payment_required';delete f.session.payment_intent;let sent=0;
 await runOrderConfirmationMail(f.runtime.now!()+30000,async()=>{sent++;return'accepted';},f.runtime,f.id);
 assert.equal(sent,0);assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.phase,'awaiting_payment');
});
test('coverage withdrawn after the acknowledged creation claim denies the provider POST',async()=>{
 const f=await optionCheckout(),pipeline=f.runtime.pipeline!;
 f.runtime.pipeline=async commands=>{
  const reply=await pipeline(commands);
  if(commands.some(c=>c[0]==='EVAL'&&c[1]===CONFIRMATION_ORIGIN_SCRIPT&&c[13]==='create'))
   f.runtime.policy={...f.runtime.policy!,coveredOrigins:undefined};
  return reply;
 };
 await assert.rejects(createCheckout(f.store,f.product,'https://example.test','large_print',{},f.runtime));
 assert.equal(f.calls.length,0);assert.ok(await readConfirmationOrigin(originId(),f.runtime));
});
test('an unknown option email outcome retains its permanent barrier across73h',async()=>{
 const f=await purchased();f.advance(61000);let sent=0;
 const dispatch=async(_message:unknown,barrier:()=>Promise<boolean>)=>{assert.equal(await barrier(),true);sent++;return'unknown' as const;};
 await runOrderConfirmationMail(f.runtime.now!()+30000,dispatch,f.runtime,f.id);
 assert.equal(sent,1);f.advance(73*3600000);await runOrderConfirmationMail(f.runtime.now!()+30000,dispatch,f.runtime,f.id);
 assert.equal(sent,1);assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.row.state,'dispatching');
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('actual Lua and accounting settle paid option, paid shipping and zero total once after73h',{
 skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT,
},async()=>{
 for(const [priceCents,shippingCents] of [[6500,500],[0,500],[0,0]]){
  const realTime=Date.now,originalTime=realTime()-73*3600000;
  let f:Awaited<ReturnType<typeof purchased>>;
  try{Date.now=()=>originalTime;f=await purchased(priceCents,shippingCents);}finally{Date.now=realTime;}
  f.advance(0);const source=await readConfirmationOrigin(f.id,f.runtime);assert.ok(source);
  assert.ok(realTime()-source.row.created>=73*3600000);
  const row=source.row,person=createHash('sha256').update('buyer@example.test').digest('hex');
  const keys=[confirmationOriginRowKey(f.id),`nl:order-confirmation:source:${f.id}`,'nl:order-confirmation:due',
   `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,
   'nl:ship:mail:pool',`nl:ship:mail:pool:${row.statsId}`,'nl:ship:mail:all',`nl:order-confirmation:closed:${row.statsId}`,
   `nl:order-confirmation:erased:${row.statsId}:${row.person}`,`nl:order-confirmation:person:${row.statsId}:${person}`,
   `nl:order-confirmation:erased:${row.statsId}:${person}`];
  const made=new Set(keys);let settlement:(string|number)[]|undefined,sent=0;
  assert.ok((await confirmationLocalPipeline(keys.map(key=>['TYPE',key]))).every(t=>t==='none'));
  try{
   // Authentic source from actual checkout + synthetic provider/ACK fixture.
   // Separate native reservation tests cover construction; this proves the
   // unchanged worker and exact Lua/accounting against real disposable Redis.
   await confirmationLocalPipeline([['SET',keys[0],source.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,row.id],
    ...[3,4,7].map(i=>['SADD',keys[i],row.id]),['HSET',keys[5],'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
   const runtime={...f.runtime,now:realTime,pipeline:async(commands:(string|number)[][])=>{
    for(const c of commands)if(c[0]==='EVAL'&&c[1]===COMMIT_ORDER_CONFIRMATION&&!settlement){
     settlement=c;c.slice(3,9).forEach(k=>made.add(String(k)));
     assert.ok((await confirmationLocalPipeline(c.slice(3,9).map(key=>['TYPE',String(key)]))).every(t=>t==='none'));
     await confirmationLocalPipeline([['HSET',String(c[5]),String(c[10]),2],['HSET',String(c[6]),String(c[10]),2*Number(c[11])]]);
    }
    return confirmationLocalPipeline(commands);
   }};
   const result=await runOrderConfirmationMail(realTime()+30000,async(message,barrier)=>{
    assert.ok(message.text.includes('Original printed book (Large print)'));assert.equal(/discount|coupon/i.test(message.text),false);
    assert.equal(await barrier(),true);assert.equal(await barrier(),false);sent++;return'accepted';
   },runtime,f.id);
   assert.deepEqual(result,{accepted:1,waiting:0,unknown:0});assert.equal(sent,1);assert.ok(settlement);
   assert.equal(String(settlement[10]),String(Math.floor(originalTime/3600000)));
   assert.deepEqual(await confirmationLocalPipeline([['GET',String(settlement[4])],['HGET',String(settlement[5]),String(settlement[10])],
    ['HGET',String(settlement[6]),String(settlement[10])],['HGET',keys[5],'items'],['EXISTS',keys[0]]]),['1','1',String(settlement[11]),'0',0]);
   assert.match(String((await confirmationLocalPipeline([['GET',String(settlement[3])]]))[0]),/^oc1:/);
   assert.ok(Number((await confirmationLocalPipeline([['TTL',keys[1]]]))[0])>399*86400);
   await runOrderConfirmationMail(realTime()+30000,async()=>{sent++;return'accepted';},runtime,f.id);assert.equal(sent,1);
   assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  }finally{await confirmationLocalPipeline([['DEL',...made]]);}
 }
});
