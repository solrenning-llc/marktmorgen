/** Reservation construction only: no checkout/payment/email permission. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {admitOrders} from '@/lib/order-admission';
import {prepareOrderConfirmationPreintent} from '@/lib/orders';
import {confirmationBodyDigest,confirmationOriginRowKey,readConfirmationOrigin,reserveConfirmationOrigin} from '@/lib/order-confirmation-outbox';
import {SHIPMENT_MAIL_SCRIPT} from '@/lib/shipment-mail-outbox';
import {physicalPaidFixture,confirmationLocalPipeline} from './order-confirmation-paid-fixture';
import {store as redis} from './redis-stub';

async function selected(){
 const f=await physicalPaidFixture();
 const option={id:'large_print',label:'Large print',priceCents:6500,file:null,link:null,details:['Printed edition'],best:false};
 f.product.options=[option];f.runtime.policy={...f.runtime.policy!,coveredOrigins:['physical-option-confirmation']};
 const nonce=randomBytes(32).toString('hex'),accountId=f.store.stripeAccountId!,name=`${f.product.title} (${option.label})`;
 const body=new URLSearchParams({mode:'payment','metadata[store]':f.store.handle,'metadata[product]':f.product.id,
  'metadata[option]':option.id,'metadata[title]':name,'metadata[mm_order_origin]':'physical-v1','metadata[mm_order_intent]':nonce,
  'line_items[0][quantity]':'1','line_items[0][price_data][unit_amount]':String(option.priceCents),
  'line_items[0][price_data][currency]':f.store.currency,'line_items[0][price_data][product_data][name]':name});
 const bodyDigest=confirmationBodyDigest(body.toString());body.set('metadata[mm_order_hash]',bodyDigest);
 const admission=await admitOrders(f.store,1,f.created,1);assert.ok(admission.ok);
 const preintent=await prepareOrderConfirmationPreintent(f.store,admission,{nonce,accountId,bodyDigest},{now:f.runtime.now});assert.ok(preintent);
 const input={statsId:f.store.statsId,nonce,accountId,body:body.toString(),preintent,
  snapshot:{store:{handle:f.store.handle,name:f.store.name,email:f.store.email,sid:f.store.sid,extra:f.store.extra,
   statsId:f.store.statsId,stripeAccountId:accountId,currency:f.store.currency},product:{...f.product,options:[{...option,details:[...option.details]}]}}};
 return{...f,input,body};
}
test('a physical option cannot reserve through legacy or digital funding',async()=>{
 for(const coveredOrigins of [undefined,['single-digital-confirmation']] as const){
  const f=await selected();f.runtime.policy={...f.runtime.policy!,coveredOrigins:coveredOrigins?[...coveredOrigins]:undefined};
  assert.deepEqual(await reserveConfirmationOrigin(f.input,f.runtime),{ok:false});
  assert.equal(f.commands.filter(c=>c[0]==='EVAL'&&c[1]===SHIPMENT_MAIL_SCRIPT).length,0);
  assert.equal(f.calls.length,0);
 }
});
test('both body selection and snapshot selection must match before reserving',async()=>{
 for(const kind of ['body','snapshot','missing-body-option','missing-snapshot-option']){
  const f=await selected();
  if(kind==='body')f.body.set('line_items[0][price_data][unit_amount]','3500');
  if(kind==='snapshot')f.input.snapshot.product.options[0].priceCents=1;
  if(kind==='missing-body-option')f.body.delete('metadata[option]');
  if(kind==='missing-snapshot-option')f.input.snapshot.product.options=[];
  f.input.body=f.body.toString();
  assert.deepEqual(await reserveConfirmationOrigin(f.input,f.runtime),{ok:false});
  assert.equal(f.commands.filter(c=>c[0]==='EVAL'&&c[1]===SHIPMENT_MAIL_SCRIPT).length,0);
 }
});
test('the authenticated selected snapshot is sealed once before any provider call',async()=>{
 const f=await selected(),result=await reserveConfirmationOrigin(f.input,f.runtime);assert.ok(result.ok);
 const first=await readConfirmationOrigin(result.id,f.runtime);assert.ok(first);
 assert.equal(first.row.phase,'awaiting_creation');assert.equal(first.row.session,'');assert.equal(first.row.originKind,undefined);
 assert.equal(first.payload.body,f.input.body);assert.deepEqual(first.payload.snapshot,f.input.snapshot);
 assert.equal(first.raw.includes('Large print'),false);assert.equal(redis.run(['TTL',confirmationOriginRowKey(result.id)]),-1);
 assert.deepEqual(await reserveConfirmationOrigin(f.input,f.runtime),result);
 assert.equal((await readConfirmationOrigin(result.id,f.runtime))?.raw,first.raw);
 assert.equal(f.calls.length,0);assert.equal(Object.hasOwn(result,'permitsCheckout'),false);
});
test('forged admission still fails even with exact option coverage and matching body',async()=>{
 const f=await selected();f.input.preintent={...f.input.preintent,token:'s1.forged'};
 assert.deepEqual(await reserveConfirmationOrigin(f.input,f.runtime),{ok:false});assert.equal(f.calls.length,0);
});
test('actual Lua retains the original selected snapshot and charges the shared pool only once',{
 skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT,
},async()=>{
 const f=await selected(),commands:(string|number)[][]=[];
 f.runtime.pipeline=async batch=>{commands.push(...batch);return confirmationLocalPipeline(batch);};
 let keys:string[]=[];
 try{
  const result=await reserveConfirmationOrigin(f.input,f.runtime);assert.ok(result.ok);
  const enqueue=commands.find(c=>c[0]==='EVAL'&&c[1]===SHIPMENT_MAIL_SCRIPT&&c[13]==='enqueue');assert.ok(enqueue);keys=enqueue.slice(3,13).map(String);
  const first=await readConfirmationOrigin(result.id,f.runtime);assert.ok(first);assert.deepEqual(first.payload.snapshot,f.input.snapshot);
  assert.deepEqual(await confirmationLocalPipeline([['TTL',keys[0]],['TTL',keys[1]],['HGET',keys[5],'items']]),[-1,-1,'1']);
  assert.deepEqual(await reserveConfirmationOrigin(f.input,f.runtime),result);
  assert.equal((await readConfirmationOrigin(result.id,f.runtime))?.raw,first.raw);
  assert.deepEqual(await confirmationLocalPipeline([['HGET',keys[5],'items'],['HGET',keys[6],'items']]),['1','1']);assert.equal(f.calls.length,0);
 }finally{if(keys.length)await confirmationLocalPipeline([['DEL',...keys]]);}
});
