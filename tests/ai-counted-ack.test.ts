/** Opt-in callback-only proof. No external service, credential or real customer. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { counted } from '@/lib/ai';
import type { Store } from '@/lib/store';
import { calls, reset, store } from './z-counted-ack-world';
import { paidPeriod } from './billing-period-fixture';
process.env.ANTHROPIC_API_KEY='sk-ant-'+'synthetic'.repeat(5);
const now=Date.UTC(2026,10,6,9);
const fixture={statsId:'writing-counter-proof',tier:'pro',period:paidPeriod(now)} as Store;
for(const [name,reply] of [
 ['missing expiry',[1]],['extra result',[1,1,99]],['null expiry',[1,null]],
 ['text expiry',[1,'1']],['expiry not applied',[1,0]],['text increment',['1',1]],
] as const){
 test(name,async()=>{
  reset([...reply]);let work=0;
  const result=await counted(fixture,now,async()=>{work++;return 'synthetic writing work';});
  assert.equal(calls.length,2);assert.equal(calls[0][0],'INCRBY');assert.equal(calls[1][0],'EXPIRE');
  assert.deepEqual(await store.pipeline([['GET',calls[0][1]]]),[null],'fixture confirms no monthly increment applied; verification read is outside application IO');
  assert.equal(work,0,'unconfirmed reservation must stop before the writing callback');
  assert.equal(result.ok,false);
 });
}
for(const [name,reply] of [['empty',[]],['unknown increment',[null,1]]] as const){
 test(name+' already refuses',async()=>{
  reset([...reply]);let work=0;
  const result=await counted(fixture,now,async()=>{work++;return 'synthetic writing work';});
  assert.equal(work,0);assert.equal(result.ok,false);assert.equal(calls.length,2);
 });
}
test('healthy MemoryRedis reservation runs once',async()=>{
 reset();let work=0;const result=await counted(fixture,now,async()=>{work++;return 'synthetic writing work';});
 assert.equal(result.ok,true);assert.equal(work,1);assert.equal(calls.length,2);
});
test('invalid job count refuses before Redis',async()=>{
 reset();let work=0;const result=await counted(fixture,now,async()=>{work++;return 'synthetic writing work';},0);
 assert.equal(result.ok,false);assert.equal(work,0);assert.equal(calls.length,0);
});
