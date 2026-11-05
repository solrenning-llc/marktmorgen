/** Real settlement and Stripe reader, synthetic provider replies only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {settleShares} from '@/lib/share-settle';
import {COMMISSION_LIVE} from '@/lib/plan';
import {SHARING_INDEX} from '@/lib/platform-share';
import {claimHandle,setStripeAccount,storeForEmail,storeRef} from '@/lib/store';
import {store as redis} from './redis-stub';
const fee={id:'fee_UnknownState0001',account:'acct_Receipt0001',charge:'ch_UnknownState0001',amount:625,amount_refunded:0,currency:'usd'};
const row={id:'du_UnknownState0001',object:'dispute',charge:fee.charge,currency:'usd',status:'future_status'};
const now=1800000000;
type Diagnostic={unknownDisputes:number;unknownDisputeFees:string[];unknownAmounts:number;unknownAmountFees:string[];listUnknown:number};
async function world(options:{feeListReply?:unknown;recent?:boolean;historical?:boolean;reply?:unknown;unavailable?:boolean;feePatch?:Record<string,unknown>;chargePatch?:Record<string,unknown>;metadataPatch?:Record<string,unknown>;sessionPatch?:Record<string,unknown>;sessionListPatch?:Record<string,unknown>}={}){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_fee_refund_only_a_stand_in';
 const calls:{method:string;url:URL}[]=[];
 if(options.historical){
  const owner='unknown-dispute-owner@example.test';
  assert.equal((await claimHandle(owner,'unknown-dispute-owner','Synthetic shop','')).ok,true);
  assert.equal((await setStripeAccount(owner,fee.account,true)).ok,true);
  const shop=(await storeForEmail(owner))!;
  await redis.pipeline([['SADD',SHARING_INDEX,storeRef(shop)]]);
 }
 const oldFetch=globalThis.fetch;
 const feeReply={...fee,...options.feePatch};
 const chargeReply={object:'charge',id:fee.charge,currency:'usd',amount:10000,amount_refunded:0,disputed:true,payment_intent:{id:'pi_UnknownState0001',metadata:{share_bps:'625',share_base:'10000',buyer_email:'synthetic-buyer@example.test',...options.metadataPatch}},...options.chargePatch};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,url});
  assert.equal(url.origin,'https://api.stripe.com');
  if(url.pathname==='/v1/application_fees')return Response.json(options.feeListReply===undefined?{object:'list',has_more:false,data:options.recent===false?[]:[feeReply]}:options.feeListReply);
  if(url.pathname==='/v1/events')return Response.json({object:'list',has_more:false,data:[{id:'evt_UnknownState0001',data:{object:{application_fee:fee.id}}}]});
  if(url.pathname==='/v1/application_fees/'+fee.id)return Response.json(feeReply);
  if(url.pathname==='/v1/charges/'+fee.charge)return Response.json(chargeReply);
  if(url.pathname==='/v1/checkout/sessions')return Response.json({object:'list',has_more:false,data:[{amount_total:10000,currency:'usd',total_details:{amount_tax:0,amount_shipping:0},...options.sessionPatch}],...options.sessionListPatch});
  if(url.pathname==='/v1/disputes'){
   if(options.unavailable)throw Error('Synthetic dispute read unavailable');
   return Response.json(options.reply===undefined?{object:'list',has_more:false,data:[row]}:options.reply);
  }
  if(method==='POST'&&url.pathname==='/v1/application_fees/'+fee.id+'/refunds')return Response.json({object:'fee_refund',id:'fr_UnknownState0001',fee:fee.id,amount:625,currency:'usd'});
  throw Error('Unexpected synthetic settlement operation');
 };
 try{return {counts:await settleShares(Date.now()+60000,now,false),calls};}finally{globalThis.fetch=oldFetch;}
}

for (const historical of [false, true]) {
  const path = historical ? 'historical only' : 'recent';
  const options = { historical, recent: !historical, metadataPatch: { share_bps: '0' } };
  test('G2 control: explicit false with matching charge permits known refund: '+path, async()=>{
    const r=await world({...options,chargePatch:{disputed:false}});
    assert.equal(r.counts.complete,true); assert.equal(r.counts.failed,0);
    assert.equal(r.calls.filter(c=>c.method==='POST').length,1); assert.equal(r.counts.cents,625);
  });
  for (const bad of [undefined,null,'false',0,{},[]]) test('G2 unknown disputed flag must not authorize a fee refund '+path+': '+String(bad),async()=>{
    const r=await world({...options,chargePatch:{disputed:bad}});
    assert.equal(r.calls.filter(c=>c.method==='POST').length,0,'unknown disputed flag authorized refund');
    assert.equal(r.counts.complete,false); assert.equal(r.counts.cents,0); assert.equal(r.counts.failed,1);
  });
  for (const bad of [undefined,null,'ch_AnotherCharge0001']) test('G2 missing or foreign charge identity must not authorize a fee refund '+path+': '+String(bad),async()=>{
    const r=await world({...options,chargePatch:{id:bad,disputed:false}});
    assert.equal(r.calls.filter(c=>c.method==='POST').length,0,'unconfirmed charge identity authorized refund');
    assert.equal(r.counts.complete,false); assert.equal(r.counts.cents,0); assert.equal(r.counts.failed,1);
  });
}
