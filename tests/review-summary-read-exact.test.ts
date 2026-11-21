/** Evidence only: real readers and MemoryRedis, no provider or authorization claim. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readReviewSummary,lastReviewSummaryAt,readReviewSummaries} from '@/lib/review-ai-summary';
import {store as redis} from './redis-stub';

const real=redis.pipeline.bind(redis);
const stats='summary_read_fixture',id='lesson',at=1793952000;
const token='0123456789abcdef01234567';
const head=JSON.stringify({v:3,g:token,at,read:5});
const entry=JSON.stringify({g:token,themes:[{title:'Clear lessons',reviews:3}]});
let response:unknown='healthy',commands=0;
redis.pipeline=(async(batch:(string|number)[][])=>{
 commands+=batch.length;
 return response==='healthy'?real(batch):response;
}) as typeof redis.pipeline;
async function seed(){
 redis.clear();response='healthy';
 await real([['SET',`nl:rsum:${stats}:${id}`,head],['ZADD',`nl:rsum:${stats}:${id}:themes`,1,entry],['SET',`nl:rsum:last:${stats}:${id}`,String(at)]]);
 commands=0;
}
const readers=[
 ['single',()=>readReviewSummary(stats,id)],
 ['last-week',()=>lastReviewSummaryAt(stats,id)],
 ['studio-map',()=>readReviewSummaries(stats,[id])],
] as const;
for(const [label,reply] of [
 ['empty',[]],['partial',[head]],['malformed',[head,{},{}]],['extra',[head,[entry],String(at),0]],
] as const){
 for(const [name,read] of readers){
  test(`${name}: ${label} envelope must remain unknown`,async()=>{
   await seed();response=reply;
   let result:unknown,thrown=false;
   try{result=await read();}catch{thrown=true;}
   const paidReadCommands=commands;
   const stored=await real([['GET',`nl:rsum:${stats}:${id}`],['GET',`nl:rsum:last:${stats}:${id}`]]);
   assert.deepEqual(stored,[head,String(at)],'real stored summary and weekly mark survive; not genuinely absent');
   assert.equal(paidReadCommands,3,'same three reader commands, no readback or provider call');
   console.log('EVIDENCE',JSON.stringify({reader:name,envelope:label,appCommands:paidReadCommands,reported:result instanceof Map?[...result]:result,rejected:thrown,storedSummaryPresent:true,storedWeeklyMark:at}));
   assert.equal(thrown,true,'unknown storage evidence must not certify an absent summary, zero week, or confirmed summary');
  });
 }
}
test('healthy readers retain the exact summary and weekly mark',async()=>{
 await seed();
 const expected={at,read:5,themes:[{title:'Clear lessons',reviews:3}]};
 assert.deepEqual(await readReviewSummary(stats,id),expected);
 assert.equal(await lastReviewSummaryAt(stats,id),at);
 assert.deepEqual([...(await readReviewSummaries(stats,[id]))],[[id,{summary:expected,lastAt:at}]]);
 assert.equal(commands,9);
});
test('confirmed absence remains absence and zero',async()=>{
 redis.clear();response='healthy';commands=0;
 assert.equal(await readReviewSummary(stats,id),null);
 assert.equal(await lastReviewSummaryAt(stats,id),0);
 assert.deepEqual([...(await readReviewSummaries(stats,[id]))],[[id,{summary:null,lastAt:0}]]);
 assert.equal(commands,9);
});
test('invalid identity does not spend a reader command',async()=>{
 response='healthy';commands=0;
 assert.equal(await readReviewSummary(stats,'../bad'),null);
 assert.equal(await lastReviewSummaryAt(stats,'../bad'),0);
 assert.equal((await readReviewSummaries(stats,['../bad'])).size,0);
 assert.equal(commands,0);
});
