/** Real settlement and Stripe reader, synthetic provider replies only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {settleShares} from '@/lib/share-settle';
import {COMMISSION_LIVE} from '@/lib/plan';
import {SHARING_INDEX} from '@/lib/platform-share';
import {claimHandle,setStripeAccount,storeForEmail,storeRef} from '@/lib/store';
import {store as redis} from './redis-stub';
const fee={id:'fee_UnknownState0001',account:'acct_UnknownState0001',charge:'ch_UnknownState0001',amount:625,amount_refunded:0,currency:'usd'};
const row={id:'du_UnknownState0001',object:'dispute',charge:fee.charge,currency:'usd',status:'future_status'};
const now=1800000000;
type Diagnostic={unknownDisputes:number;unknownDisputeFees:string[]};
async function world(options:{recent?:boolean;historical?:boolean;reply?:unknown;unavailable?:boolean}={}){
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
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,url});
  assert.equal(url.origin,'https://api.stripe.com');
  if(url.pathname==='/v1/application_fees')return Response.json({object:'list',has_more:false,data:options.recent===false?[]:[fee]});
  if(url.pathname==='/v1/events')return Response.json({object:'list',has_more:false,data:[{id:'evt_UnknownState0001',data:{object:{application_fee:fee.id}}}]});
  if(url.pathname==='/v1/application_fees/'+fee.id)return Response.json(fee);
  if(url.pathname==='/v1/charges/'+fee.charge)return Response.json({id:fee.charge,currency:'usd',amount:10000,amount_refunded:0,disputed:true,payment_intent:{id:'pi_UnknownState0001',metadata:{share_bps:'625',share_base:'10000',buyer_email:'synthetic-buyer@example.test'}}});
  if(url.pathname==='/v1/disputes'){
   if(options.unavailable)throw Error('Synthetic dispute read unavailable');
   return Response.json(options.reply===undefined?{object:'list',has_more:false,data:[row]}:options.reply);
  }
  if(method==='POST'&&url.pathname==='/v1/application_fees/'+fee.id+'/refunds')return Response.json({object:'fee_refund',id:'fr_UnknownState0001',fee:fee.id,amount:625,currency:'usd'});
  throw Error('Unexpected synthetic settlement operation');
 };
 try{return {counts:await settleShares(Date.now()+60000,now,false),calls};}finally{globalThis.fetch=oldFetch;}
}
for(const [label,options,expected] of [
 ['recent',{},1],['historical',{recent:false,historical:true},1],['both paths',{historical:true},2],
] as const){
 test('unknown dispute status is separately reported with its fee in '+label,async()=>{
  const {counts,calls}=await world(options),diagnostic=counts as unknown as Diagnostic;
  assert.equal(counts.failed,expected);assert.equal(counts.complete,false);
  assert.equal(counts.gaveBack,0);assert.equal(counts.cents,0);
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal(diagnostic.unknownDisputes,expected);
  assert.deepEqual(diagnostic.unknownDisputeFees,[fee.id],'fee ids are deduplicated across the same run');
  const output=JSON.stringify(counts);
  for(const privateValue of [fee.account,fee.charge,'synthetic-buyer@example.test','unknown-dispute-owner@example.test'])assert.equal(output.includes(privateValue),false);
 });
}
test('unknown-status diagnostics do not swallow other missing or foreign evidence',async()=>{
 for(const reply of [null,{object:'list',has_more:true,data:[row]},{object:'list',has_more:false,data:[]},{object:'list',has_more:false,data:[{...row,charge:'ch_Different0001'}]},{object:'list',has_more:false,data:[{...row,currency:'eur'}]}]){
  const {counts,calls}=await world({reply}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(counts.failed,1);assert.equal(counts.complete,false);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal(diagnostic.unknownDisputes,0);assert.deepEqual(diagnostic.unknownDisputeFees,[]);
 }
});
test('a transport failure is still failed without inventing an unknown status',async()=>{
 const {counts,calls}=await world({unavailable:true}),diagnostic=counts as unknown as Diagnostic;
 assert.equal(counts.failed,1);assert.equal(counts.complete,false);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 assert.equal(diagnostic.unknownDisputes,0);assert.deepEqual(diagnostic.unknownDisputeFees,[]);
});
test('known states remain ordinary, including the confirmed lost-dispute refund',async()=>{
 for(const status of ['won','needs_response','under_review','warning_needs_response','warning_under_review','warning_closed','lost']){
  const {counts,calls}=await world({reply:{object:'list',has_more:false,data:[{...row,status}]}}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(counts.failed,0);assert.equal(counts.complete,true);
  assert.equal(calls.filter(c=>c.method==='POST').length,status==='lost'?1:0);
  assert.equal(diagnostic.unknownDisputes,0);assert.deepEqual(diagnostic.unknownDisputeFees,[]);
 }
 assert.equal(COMMISSION_LIVE,false,'the live commission switch remains off');
});
