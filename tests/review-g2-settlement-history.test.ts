import assert from 'node:assert/strict';
import {test} from 'node:test';
import {settleShares} from '@/lib/share-settle';
import {SHARING_INDEX} from '@/lib/platform-share';
import {claimHandle,setStripeAccount,storeForEmail,storeRef} from '@/lib/store';
import {store as redis} from './redis-stub';
const now=1_800_000_000,old=now-172800;

async function world(events:unknown,subscriptions?:unknown){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_synthetic_settlement_only';
 const email='g2-settlement-history@example.test';
 assert.equal((await claimHandle(email,'g2-settlement-history','Synthetic history','')).ok,true);
 assert.equal((await setStripeAccount(email,'acct_G2Settlement',true)).ok,true);
 const shop=(await storeForEmail(email))!,ref=storeRef(shop);
 await redis.pipeline([['SADD',SHARING_INDEX,ref],['HSET','nl:share:read-until',ref,String(old)]]);
 if(subscriptions!==undefined)await redis.pipeline([['HSET','nl:share:applied',ref,'625']]);
 const calls:string[]=[];const realFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push(`${init?.method??'GET'} ${url.pathname}`);
  assert.equal(url.origin,'https://api.stripe.com');assert.notEqual(init?.method,'POST');
  if(url.pathname==='/v1/application_fees')return Response.json({object:'list',data:[],has_more:false});
  if(url.pathname==='/v1/events')return Response.json(events);
  if(url.pathname==='/v1/subscriptions/search')return Response.json(subscriptions);
  throw Error('Unexpected synthetic call');
 };
 try{
  const counts=await settleShares(Date.now()+60000,now,false);
  const [cursor,applied]=await redis.pipeline([['HGET','nl:share:read-until',ref],['HGET','nl:share:applied',ref]]);
  return {counts,cursor,applied,calls};
 }finally{globalThis.fetch=realFetch;}
}

test('confirmed empty historical event page may advance its cursor',async()=>{
 const r=await world({object:'list',data:[],has_more:false});
 assert.equal(r.counts.complete,true);assert.equal(r.counts.failed,0);assert.equal(r.cursor,String(now));
});
for(const [label,events] of [
 ['missing data',{}],['null data',{object:'list',data:null,has_more:false}],
 ['missing has_more',{object:'list',data:[]}],['no next cursor',{object:'list',data:[],has_more:true}],
] as const)test(`unknown historical events cannot advance the watermark: ${label}`,async()=>{
 const r=await world(events);console.log({label,...r});
 assert.equal(r.counts.complete,false);assert.equal(r.cursor,String(old));
});
test('a confirmed empty subscription search may clear the old applied percentage',async()=>{
 const r=await world({object:'list',data:[],has_more:false},{object:'search_result',data:[],has_more:false});
 assert.equal(r.counts.complete,true);assert.equal(r.applied,null);
});
test('an unconfirmed subscription search cannot mark all membership percentages synchronized',async()=>{
 const r=await world({object:'list',data:[],has_more:false},{});console.log(r);
 assert.equal(r.counts.complete,false);assert.equal(r.applied,'625');
});
