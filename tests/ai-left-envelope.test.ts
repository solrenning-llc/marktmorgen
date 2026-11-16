/** Opt-in balance evidence. Real aiLeft; synthetic Redis transport, no provider. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aiAllowance, aiLeft, aiMonthKey } from '@/lib/ai';
import { UnknownReplyError } from '@/lib/redis-reply';
import type { Store } from '@/lib/store';
import { calls, reset, store } from './z-counted-ack-world';
import { paidPeriod } from './billing-period-fixture';
const now=Date.UTC(2026,10,6,9);
const fixture={statsId:'writing-balance-proof',tier:'pro',period:paidPeriod(now)} as Store;
for(const [name,reply] of [
 ['extra null result',[null,99]],['extra count result',['1',99]],
 ['leading zero count',['01']],['noncanonical zero',['00']],
] as const){
 test(name+' must not certify available jobs',async()=>{
  reset([...reply]);const key=aiMonthKey(fixture,new Date(now));assert.ok(key);
  // Existing usage is real fixture state. Setup and inspection are not application IO.
  await store.pipeline([['SET',key,String(aiAllowance(fixture,now))]]);
  const result=aiLeft(fixture,now);
  await assert.rejects(result,UnknownReplyError);
  assert.equal(calls.length,1);assert.deepEqual(calls[0],['GET',key]);
  assert.deepEqual(await store.pipeline([['GET',key]]),[String(aiAllowance(fixture,now))]);
 });
}
for(const [name,reply,expected] of [
 ['known absent',[null],40],['canonical count',['1'],39],
 ['missing result',[],0],['nested invalid count',[['1']],0],
] as const){
 test(name+' control',async()=>{
  reset([...reply]);
  if(name==='missing result'||name==='nested invalid count')await assert.rejects(aiLeft(fixture,now),UnknownReplyError);
  else assert.equal(await aiLeft(fixture,now),expected);
  assert.equal(calls.length,1);
 });
}
