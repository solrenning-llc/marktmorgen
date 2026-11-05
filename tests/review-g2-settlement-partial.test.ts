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
type Diagnostic={unknownDisputes:number;unknownDisputeFees:string[];unknownAmounts:number;unknownAmountFees:string[]};
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
 const chargeReply={id:fee.charge,currency:'usd',amount:10000,amount_refunded:0,disputed:true,payment_intent:{id:'pi_UnknownState0001',metadata:{share_bps:'625',share_base:'10000',buyer_email:'synthetic-buyer@example.test',...options.metadataPatch}},...options.chargePatch};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,url});
  assert.equal(url.origin,'https://api.stripe.com');
  if(url.pathname==='/v1/application_fees')return Response.json(options.feeListReply === undefined ? {object:'list',has_more:false,data:options.recent===false?[]:[feeReply]} : options.feeListReply);
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

test('G2: confirmed empty fee ledger is a complete zero control',async()=>{
 const {counts,calls}=await world({feeListReply:{object:'list',has_more:false,data:[]}});
 assert.equal(counts.complete,true);assert.equal(counts.fees,0);assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
for(const [label,feeListReply] of [['missing data',{}],['null data',{object:'list',has_more:false,data:null}],['missing has_more',{object:'list',data:[]}],['more pages without cursor',{object:'list',has_more:true,data:[]}],['malformed fee row',{object:'list',has_more:false,data:[{}]}]] as const){
 test('G2: unconfirmed fee list cannot mean complete zero: '+label,async()=>{
  const {counts,calls}=await world({feeListReply});
  console.log('G2 observation',label,JSON.stringify(counts));
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal(counts.complete,false,'incomplete evidence must stay unknown');
 });
}
