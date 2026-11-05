import assert from 'node:assert/strict';
import {test} from 'node:test';
import {earnedCourses} from '@/lib/community-points';
import {store as redis} from './redis-stub';
const id='a'.repeat(32),member='b'.repeat(32),now=1_800_000_000_000;
const configuration=JSON.stringify([{level:2,product:'newcourse'}]);
const active=JSON.stringify({k:member,removed:false});
async function check(read:unknown[],ack:unknown[]=[1],grant=true){
 const original=redis.pipeline;let writes=0;
 try{
  redis.pipeline=async commands=>{
   if(commands.length===4&&commands[1][0]==='ZSCORE')return read as never;
   writes+=commands.length;return ack as never;
  };
  return {result:await earnedCourses(id,member,now,grant),get writes(){return writes;}};
 }finally{redis.pipeline=original;}
}
test('unknown new-grant acknowledgments retain an independently confirmed old course',async()=>{
 for(const ack of [[],[null],[true],['1'],[1,1]]){
  const got=await check([configuration,'5',active,['oldcourse','123']],ack);
  assert.deepEqual([...got.result],[['oldcourse',123]]);assert.equal(got.writes,1);
 }
});
test('an inactive community and removed membership cannot create new course grants',async()=>{
 const off=await check([configuration,'5',active,['oldcourse','123']],[1],false);
 assert.deepEqual([...off.result],[['oldcourse',123]]);assert.equal(off.writes,0);
 const removed=await check([configuration,'5',JSON.stringify({k:member,removed:true}),['oldcourse','123']]);
 assert.equal(removed.result.size,0);assert.equal(removed.writes,0);
});
test('noncanonical numeric evidence is not normalized into a new grant',async()=>{
 for(const points of ['05','+5','5e0',' 5','5 ','5.0',false]){
  const got=await check([configuration,points,active,[]]);
  assert.equal(got.result.size,0);assert.equal(got.writes,0);
 }
});
