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
test('G2: confirmed empty fee ledger is a complete zero control',async()=>{
 const {counts,calls}=await world({feeListReply:{object:'list',has_more:false,data:[]}});
 assert.equal(counts.complete,true);assert.equal(counts.failed,0);assert.equal(counts.fees,0);assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
for(const [label,feeListReply] of [['missing data',{}],['null data',{object:'list',has_more:false,data:null}],['missing has_more',{object:'list',data:[]}],['more pages without cursor',{object:'list',has_more:true,data:[]}],['malformed fee row',{object:'list',has_more:false,data:[{}]}]] as const){
 test('G2: unconfirmed fee list cannot mean complete zero: '+label,async()=>{
  const {counts,calls}=await world({feeListReply});
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal(counts.complete,false,'incomplete evidence must stay unknown');assert.equal(counts.failed,1);
  assert.equal(counts.fees,0);assert.equal(counts.unknownAmounts,0);assert.deepEqual(counts.unknownAmountFees,[]);
 });
}
test('G2: validate every fee row before authorizing a refund from that page',async()=>{
 const {counts,calls}=await world({feeListReply:{object:'list',has_more:false,data:[fee,{}]},chargePatch:{disputed:false},metadataPatch:{share_bps:'0'}});
 assert.equal(calls.filter(c=>c.method==='POST').length,0);assert.equal(counts.complete,false);assert.equal(counts.failed,1);assert.equal(counts.fees,0);
});
test('G2: repeated pagination cursor is an incomplete read, not fifty paid repeats',async()=>{
 const {counts,calls}=await world({feeListReply:{object:'list',has_more:true,data:[fee]},chargePatch:{disputed:false}});
 assert.equal(counts.complete,false);assert.equal(counts.failed,1);assert.equal(calls.filter(c=>c.url.pathname==='/v1/application_fees').length,2);
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
});

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
test('a known lost row cannot override a later unknown dispute status',async()=>{
 const {counts,calls}=await world({reply:{object:'list',has_more:false,data:[{...row,id:'du_KnownLost0001',status:'lost'},row]}}),diagnostic=counts as unknown as Diagnostic;
 assert.equal(counts.failed,1);assert.equal(counts.complete,false);
 assert.equal(counts.gaveBack,0);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 assert.equal(diagnostic.unknownDisputes,1);assert.deepEqual(diagnostic.unknownDisputeFees,[fee.id]);
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

for(const location of ['fee amount','fee refunded','charge amount','charge refunded'] as const){
 test('CX-110: '+location+' must be explicitly known before any money mutation',async()=>{
  for(const bad of [undefined,null,'100',NaN,-1,0.5,Number.MAX_SAFE_INTEGER+1]){
   const patch=location.startsWith('fee')?{feePatch:{[location.endsWith('refunded')?'amount_refunded':'amount']:bad}}:{chargePatch:{[location.endsWith('refunded')?'amount_refunded':'amount']:bad}};
   const {counts,calls}=await world({...patch,chargePatch:{disputed:false,...patch.chargePatch}}),diagnostic=counts as unknown as Diagnostic;
   assert.equal(calls.filter(c=>c.method==='POST').length,0,location+' '+String(bad));
   assert.equal(counts.failed,1);assert.equal(counts.complete,false);assert.equal(counts.gaveBack,0);assert.equal(counts.cents,0);
   assert.equal(diagnostic.unknownAmounts,1);assert.deepEqual(diagnostic.unknownAmountFees,[fee.id]);
   assert.equal(diagnostic.unknownDisputes,0);
  }
 });
}
test('CX-110: missing or invalid basis points cannot mean a zero rate',async()=>{
 for(const bad of [undefined,null,'',NaN,-1,'-1','1.5','10001','1e3','invalid']){
  const {counts,calls}=await world({chargePatch:{disputed:false},metadataPatch:{share_bps:bad}}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(calls.filter(c=>c.method==='POST').length,0,'share_bps '+String(bad));
  assert.equal(counts.failed,1);assert.equal(counts.complete,false);
  assert.equal(diagnostic.unknownAmounts,1);assert.deepEqual(diagnostic.unknownAmountFees,[fee.id]);
 }
});
test('CX-110: missing, invalid or mismatched currency remains unknown in both paths',async()=>{
 for(const side of ['feePatch','chargePatch'])for(const bad of [undefined,null,'','US','unknown',100,...(side==='chargePatch'?['eur']:[])]){
  const {counts,calls}=await world({[side]:{currency:bad},historical:true,chargePatch:{disputed:false,...(side==='chargePatch'?{currency:bad}:{})}}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  assert.equal(counts.failed,2);assert.equal(counts.complete,false);
  assert.equal(diagnostic.unknownAmounts,2);assert.deepEqual(diagnostic.unknownAmountFees,[fee.id]);
 }
});
test('CX-110: explicit zero rate or goods base may authorize a known refund',async()=>{
 for(const patch of [{share_bps:'0'},{share_base:'0'}]){
  const {counts,calls}=await world({chargePatch:{disputed:false},metadataPatch:patch}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(counts.failed,0);assert.equal(counts.complete,true);assert.equal(counts.gaveBack,1);assert.equal(counts.cents,625);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.equal(diagnostic.unknownAmounts,0);assert.deepEqual(diagnostic.unknownAmountFees,[]);
 }
});
test('CX-110: a legacy session needs known amounts, matching currency and a complete result',async()=>{
 const base={chargePatch:{disputed:false},metadataPatch:{share_bps:'0',share_base:undefined}};
 for(const sessionPatch of [{amount_total:undefined},{amount_total:null},{amount_total:'10000'},{amount_total:-1},{total_details:{amount_tax:undefined,amount_shipping:0}},{total_details:{amount_tax:0,amount_shipping:null}},{currency:undefined},{currency:null},{currency:'eur'}]){
  const {counts,calls}=await world({...base,sessionPatch}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(calls.filter(c=>c.method==='POST').length,0,'session '+JSON.stringify(sessionPatch));
  assert.equal(counts.failed,1);assert.equal(counts.complete,false);assert.equal(diagnostic.unknownAmounts,1);assert.deepEqual(diagnostic.unknownAmountFees,[fee.id]);
 }
 for(const sessionListPatch of [{has_more:true},{has_more:undefined},{object:'other'}, {data:[]}]){
  const {counts,calls}=await world({...base,sessionListPatch}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(calls.filter(c=>c.method==='POST').length,0);assert.equal(counts.failed,1);assert.equal(diagnostic.unknownAmounts,1);
 }
 const {counts,calls}=await world(base),diagnostic=counts as unknown as Diagnostic;
 assert.equal(counts.failed,0);assert.equal(counts.complete,true);assert.equal(counts.gaveBack,1);assert.equal(diagnostic.unknownAmounts,0);assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('CX-110: invoice totals, basis points, date and currency must be known',async()=>{
 const invoice={currency:'usd',created:now-3600,total_excluding_tax:10000,subscription_details:{metadata:{store:'unknown-dispute-owner',share_bps:'625'}}};
 for(const patch of [{total_excluding_tax:undefined},{total_excluding_tax:null},{total_excluding_tax:'10000'},{total_excluding_tax:-1},{created:undefined},{created:NaN},{created:-1},{currency:undefined},{currency:'eur'},{subscription_details:{metadata:{store:'unknown-dispute-owner'}}}]){
  const {counts,calls}=await world({historical:true,chargePatch:{disputed:false,invoice:{...invoice,...patch}}}),diagnostic=counts as unknown as Diagnostic;
  assert.equal(calls.filter(c=>c.method==='POST').length,0,'invoice '+JSON.stringify(patch));
  assert.equal(counts.failed,2);assert.equal(counts.complete,false);assert.equal(diagnostic.unknownAmounts,2);assert.deepEqual(diagnostic.unknownAmountFees,[fee.id]);
 }
 const {counts,calls}=await world({historical:true,chargePatch:{disputed:false,invoice}}),diagnostic=counts as unknown as Diagnostic;
 assert.equal(counts.failed,0);assert.equal(counts.complete,true);assert.equal(diagnostic.unknownAmounts,0);assert.equal(calls.filter(c=>c.method==='POST').length,2);
});
