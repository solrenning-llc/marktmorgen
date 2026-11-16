/** Real settlement and store readers; synthetic Stripe/Redis evidence only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {settleShares} from '@/lib/share-settle';
import {claimHandle,setStripeAccount,storeForEmail,storeRef} from '@/lib/store';
import {SHARING_INDEX} from '@/lib/platform-share';
import {store as redis} from './redis-stub';

const now=1800000000;
const fee={object:'application_fee',id:'fee_HistoryRead0001',account:'acct_Receipt0001',charge:'ch_HistoryRead0001',amount:625,amount_refunded:0,currency:'usd'};
const event={id:'evt_HistoryRead0001',data:{object:{application_fee:fee.id}}};
const page=(data:unknown[]=[],has_more=false)=>({object:'list',has_more,data});
async function world(options:{events?:unknown;pages?:(number:number)=>unknown;indexes?:unknown[];cursor?:unknown[];cursorWrite?:unknown[];feePatch?:Record<string,unknown>;feeReply?:unknown;chargePatch?:Record<string,unknown>;chargeFails?:boolean}={}){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_fee_refund_only_a_stand_in';
 const owner='historical-read-owner@example.test';
 assert.equal((await claimHandle(owner,'historyread','Synthetic shop','')).ok,true);
 assert.equal((await setStripeAccount(owner,fee.account,true)).ok,true);
 const shop=(await storeForEmail(owner))!,ref=storeRef(shop);
 await redis.pipeline([['SADD',SHARING_INDEX,ref]]);
 const base=redis.pipeline.bind(redis),fetchBefore=globalThis.fetch;
 const calls:{method:string;path:string}[]=[];let eventPages=0;
 const feeReply={...fee,...options.feePatch};
 try{
  redis.pipeline=async commands=>{
   if(options.indexes!==undefined&&commands.length===2&&commands[0][0]==='SMEMBERS'&&commands[0][1]===SHARING_INDEX)return options.indexes;
   if(options.cursor!==undefined&&commands.length===1&&commands[0][0]==='HGET'&&commands[0][1]==='nl:share:read-until')return options.cursor;
   if(options.cursorWrite!==undefined&&commands.length===1&&commands[0][0]==='HSET'&&commands[0][1]==='nl:share:read-until')return options.cursorWrite;
   return base(commands);
  };
  globalThis.fetch=async(input,init)=>{
   const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,path:url.pathname});assert.equal(url.origin,'https://api.stripe.com');
   if(url.pathname==='/v1/application_fees')return Response.json(page());
   if(url.pathname==='/v1/events'){eventPages++;return Response.json(options.pages?options.pages(eventPages):options.events===undefined?page([event]):options.events);}
   if(url.pathname==='/v1/application_fees/'+fee.id)return Response.json(Object.hasOwn(options,'feeReply')?options.feeReply:feeReply);
   if(url.pathname==='/v1/charges/'+fee.charge)return options.chargeFails?Response.json({error:{message:'Synthetic outage'}},{status:500}):Response.json({object:'charge',id:fee.charge,application_fee:fee.id,currency:'usd',amount:10000,amount_refunded:10000,disputed:false,invoice:null,payment_intent:{object:'payment_intent',id:'pi_HistoryRead0001',currency:'usd',amount:10000,latest_charge:fee.charge,metadata:{share_bps:'625',share_base:'10000'}},...options.chargePatch});
   if(method==='POST'&&url.pathname==='/v1/application_fees/'+fee.id+'/refunds'){
    const amount=Number(new URLSearchParams(String(init?.body)).get('amount'));feeReply.amount_refunded=Number(feeReply.amount_refunded)+amount;
    return Response.json({object:'fee_refund',id:'fr_HistoryRead0001',fee:fee.id,amount,currency:'usd'});
   }
   throw Error('Unexpected synthetic historical settlement request');
  };
  const counts=await settleShares(Date.now()+60000,now,false);
  const [saved]=await base([['HGET','nl:share:read-until',ref]]);
  return{counts,calls,saved,eventPages};
 }finally{redis.pipeline=base;globalThis.fetch=fetchBefore;}
}

function unconfirmed(result:Awaited<ReturnType<typeof world>>){
 assert.equal(result.counts.complete,false);assert.equal(result.counts.failed,1);assert.equal(result.counts.listUnknown,1);
 assert.equal(result.saved,null,'unknown historical evidence must not advance the persistent cursor');
 assert.equal(result.calls.filter(c=>c.method==='POST').length,0);
}
test('confirmed empty history is a complete zero and may advance the cursor',async()=>{
 const r=await world({events:page()});assert.equal(r.counts.complete,true);assert.equal(r.counts.failed,0);assert.equal(r.counts.listUnknown,0);assert.equal(r.saved,String(now));assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
for(const[label,events]of [
 ['missing envelope',{}],['null data',{object:'list',data:null,has_more:false}],['missing more',{object:'list',data:[]}],['text more',{object:'list',data:[],has_more:'false'}],['more without cursor',page([],true)],['malformed row',page([{}])],['missing event id',page([{data:event.data}])],['missing fee and charge',page([{id:event.id,data:{object:{}}}])],['malformed row after a refundable fee',page([event,{}])],['duplicate event id',page([event,event])],
]as const)test('unconfirmed historical event page: '+label,async()=>unconfirmed(await world({events})));
for(const indexes of [[],[undefined],[[],undefined],[null,[]],[[],[],[]],[[123],[]],Array(2)])test('unconfirmed historical store index '+JSON.stringify(indexes),async()=>{
 const r=await world({indexes});unconfirmed(r);assert.equal(r.eventPages,0,'do not read stores from an unconfirmed index');
});
for(const cursor of [[],[undefined],[''],['-1'],['1.5'],[0]])test('unconfirmed saved history cursor '+JSON.stringify(cursor),async()=>{
 const r=await world({cursor});unconfirmed(r);assert.equal(r.eventPages,0,'do not turn an unconfirmed cursor into an initial scan');
});
test('confirmed refund survives valid pagination and is applied only once',async()=>{
 const r=await world({pages:n=>n===1?page([event],true):page()});
 assert.equal(r.counts.complete,true);assert.equal(r.counts.failed,0);assert.equal(r.counts.gaveBack,1);assert.equal(r.counts.cents,625);assert.equal(r.eventPages,2);assert.equal(r.saved,String(now));assert.equal(r.calls.filter(c=>c.method==='POST').length,1);
});
test('repeated event cursor is incomplete and does not advance the saved cursor',async()=>{
 const r=await world({events:page([event],true)});assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.counts.listUnknown,1);assert.equal(r.eventPages,2);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,1,'only the first confirmed page authorized a refund');
});
test('the existing twenty-page bound never turns an unfinished history into a complete read',async()=>{
 const r=await world({pages:n=>page([{...event,id:'evt_HistoryRead'+n}],true)});assert.equal(r.eventPages,20);assert.equal(r.counts.complete,false);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,1);
});
test('unknown fee amounts remain retryable without advancing the history cursor',async()=>{
 const r=await world({feePatch:{amount:undefined}});assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.counts.unknownAmounts,1);assert.deepEqual(r.counts.unknownAmountFees,[fee.id]);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
test('a charge lookup without a confirmed fee reference is not an empty history',async()=>{
 const r=await world({events:page([{...event,data:{object:{charge:fee.charge}}}]),chargePatch:{application_fee:undefined}});unconfirmed(r);
});
test('an application fee from a different account is refused and stays retryable',async()=>{
 const r=await world({feePatch:{account:'acct_Receipt0002'}});assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.counts.unknownAmounts,1);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
test('an event with an explicitly absent application fee is an ordinary zero',async()=>{
 const r=await world({events:page([{...event,data:{object:{application_fee:null}}}])});assert.equal(r.counts.complete,true);assert.equal(r.counts.failed,0);assert.equal(r.saved,String(now));assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
test('C4: failed charge evidence stays incomplete without advancing the historical cursor',async()=>{
 const r=await world({events:page([{...event,data:{object:{charge:fee.charge}}}]),chargeFails:true});
 assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
test('C4: malformed application fee evidence cannot advance the historical cursor',async()=>{
 const r=await world({feeReply:{}});assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.counts.unknownAmounts,1);assert.equal(r.saved,null);assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
});
for(const cursorWrite of [[],[undefined],[null],['OK'],[2],[1,0]])test('unconfirmed historical marker write remains incomplete: '+JSON.stringify(cursorWrite),async()=>{
 const r=await world({events:page(),cursorWrite});unconfirmed(r);
});
for(const id of [undefined,null,'ch_OtherHistory0001'])test('historical charge lookup must confirm its identity before declaring no fee: '+String(id),async()=>{
 const r=await world({events:page([{...event,data:{object:{charge:fee.charge}}}]),chargePatch:{id,application_fee:null}});unconfirmed(r);
});
test('historical fee must belong to the charge named by its event',async()=>{
 const r=await world({events:page([{...event,data:{object:{charge:fee.charge}}}]),feePatch:{charge:'ch_OtherHistory0001'}});
 assert.equal(r.counts.complete,false);assert.equal(r.counts.failed,1);assert.equal(r.counts.unknownAmounts,1);assert.equal(r.saved,null);
 assert.equal(r.calls.filter(c=>c.method==='POST').length,0);assert.equal(r.calls.filter(c=>c.path==='/v1/charges/ch_OtherHistory0001').length,0,'a mismatched identity must stop before reading unrelated charge data');
});
for(const object of [undefined,null,'invoice'])test('historical lookup must confirm the charge kind before declaring no fee: '+String(object),async()=>{
 const r=await world({events:page([{...event,data:{object:{charge:fee.charge}}}]),chargePatch:{object,application_fee:null}});unconfirmed(r);
});
