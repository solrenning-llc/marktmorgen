import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryReport} from '@/lib/payment-recovery-report';
import type {Store} from '@/lib/store';
import {store as redis} from './redis-stub';

process.env.STRIPE_SECRET_KEY='sk_test_x8_synthetic_only';
const now=Date.UTC(2026,10,20,12);
const shop={sid:'c'.repeat(32),statsId:'d'.repeat(32),email:'recovery-owner@example.test',handle:'recovery-proof',previousHandles:[],releasedHandles:[],stripeAccountId:'acct_test_recovery_evidence',currency:'usd'} as unknown as Store;
const good={id:'in_syntheticproof',object:'invoice',status:'paid',currency:'usd',amount_paid:1234,attempt_count:2,paid_out_of_band:false,billing_reason:'subscription_cycle',status_transitions:{paid_at:now/1000-60},parent:{subscription_details:{metadata:{store:shop.handle}}}};
let current:unknown=good,reads=0;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(String(input));
 assert.equal(url.hostname,'api.stripe.com');assert.equal(url.pathname,'/v1/invoices');
 assert.equal(init?.method??'GET','GET');assert.equal(url.searchParams.get('status'),'paid');
 reads++;return Response.json({object:'list',data:[current],has_more:false});
}) as typeof fetch;
function reset(row:unknown){redis.clear();redis.run(['SET',`nl:store:id:${shop.sid}`,shop.email]);current=row;reads=0;}
for(const [name,patch] of [
 ['missing object',{object:undefined}],['null object',{object:null}],['another object',{object:'charge'}],
 ['missing status',{status:undefined}],['null status',{status:null}],['open status',{status:'open'}],
 ['void status',{status:'void'}],['uncollectible status',{status:'uncollectible'}],['draft status',{status:'draft'}],
] as const)test(`a ${name} row cannot count or persist as recovered money`,async()=>{
 reset({...good,...patch});
 let firstRejected=false,money:number|null=null;try{money=(await recoveryReport(shop,true,now))?.cents??null;}catch{firstRejected=true;}
 const cached=Number(redis.run(['EXISTS',`nl:dun:report:${shop.statsId}:v2`]));
 let secondRejected=false;try{await recoveryReport(shop,false,now);}catch{secondRejected=true;}
 assert.deepEqual({firstRejected,secondRejected,cached,money},{firstRejected:true,secondRejected:true,cached:0,money:null});
});
test('an exact paid invoice still counts and reuses its confirmed cache',async()=>{
 reset(good);const first=await recoveryReport(shop,true,now);
 assert.deepEqual([first?.recovered,first?.cents,first?.complete],[1,1234,true]);
 assert.deepEqual(await recoveryReport(shop,false,now),first);assert.equal(reads,1);
});
test('aggregates cached before invoice identity was checked cannot survive the fix',async()=>{
 reset(good);
 redis.run(['SET',`nl:dun:report:${shop.statsId}:v2`,JSON.stringify({at:now/1000,currency:'usd',recovered:99,cents:999999,afterEmail:0,afterEmailCents:0,elsewhere:0,month:{failed:0,cards:0},complete:true})]);
 const result=await recoveryReport(shop,false,now);
 assert.deepEqual([result?.recovered,result?.cents,reads],[1,1234,1]);
});
