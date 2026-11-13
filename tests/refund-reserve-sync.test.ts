/**
 * 306 [SY2] unit 3a: the refund reserve read incrementally
 * (lib/refund-reserve-sync.ts), so its scale limit is no longer the 2,000
 * charges of one full reading (unit 2b). Design approved by Claude 3,
 * 13/11/2026. Synthetic Stripe (tests/refund-reserve-stripe-world.ts) and
 * the in-memory Redis only; no request but GET.
 *
 * The oracle is unit 2b: after every run, at the same instant, the
 * incremental reserve equals readRefundReserve's full reading of the same
 * Stripe. Through a history of hundreds of charges: new charges, refunds made
 * pending then done, disputes opened and closed, a pending charge settling,
 * and time passing beyond the guarantee, the yearly months and the dispute
 * window (pruned, the total unchanged). Besides:
 *   - building the first state resumes across runs and is unknown until done;
 *   - a backlog past a run's ceilings is unknown and converges on later runs;
 *   - a stored state that is unreadable, of another format, or whose events
 *     cursor Stripe no longer keeps is unknown and rebuilt; a busy lock is
 *     unknown and reads nothing;
 *   - a Redis or Stripe answer in another shape is unknown, never empty;
 *   - the ceilings are named and registered as the company's fixed reading
 *     cost (NOT_A_COST, FAMILIES), and the lock outlives the run's budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_SYNC_REDIS_COMMANDS_PER_DAY,RESERVE_SYNC_STORED_BYTES,RESERVE_SYNC_STRIPE_GETS_PER_DAY,SYNC_BUDGET_MS,SYNC_KEY,SYNC_LIMITS,SYNC_LOCK_KEY,SYNC_LOCK_SECONDS,syncRefundReserve} from '@/lib/refund-reserve-sync';
import {readRefundReserve} from '@/lib/refund-reserve-read';
import {NOT_A_COST} from './plan-cost-registry';
import {FAMILIES} from './store-data-registry';
import {addCharge,dispute,refund,refundStatus,resetWorld,settle,stripeFetch,world,type Kind} from './refund-reserve-stripe-world';
import {counted,store} from './refund-reserve-sync-redis';

process.env.STRIPE_SECRET_KEY='sk_test_refund_reserve_sync_only_a_stand_in';
globalThis.fetch=stripeFetch as typeof fetch;
const DAY=86_400;
const START=Math.floor(Date.now()/1000);
const later=()=>Date.now()+60_000;

/** A deterministic spread of charges over the lookback. */
function history(count:number,now:number):string[]{
 let seed=7;const next=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
 const kinds:Kind[]=['plan','plan','plan','plan','assistant','captions','none','foreign'];
 const ids:string[]=[];
 for(let i=0;i<count;i++){
  const kind=kinds[Math.floor(next()*kinds.length)],cycle=next()<0.3?'year':'month';
  const amount=kind==='plan'?(cycle==='year'?69000:[6900,44900,99900][Math.floor(next()*3)]):kind==='assistant'?6900:1000+Math.floor(next()*5000);
  ids.push(addCharge({kind,cycle,amount,paidAt:now-1-Math.floor(next()*480*DAY),status:next()<0.03?'failed':'succeeded',billing:kind==='plan'&&next()<0.5?'subscription_cycle':undefined}));
 }
 return ids;
}
async function both(now:number){
 const run=await syncRefundReserve(now,later());
 const full=await readRefundReserve(now,later());
 return {run,full};
}
function fresh(clock:number):void{resetWorld(clock);store.clear();counted.commands=0;counted.garble=null;}
async function built(now:number,limits=SYNC_LIMITS){
 for(let i=0;i<20;i++){const run=await syncRefundReserve(now,later(),limits);if(run.why!=='building')return run;}
 throw Error('the first state was never built');
}

test('through a history of changes the incremental reserve equals the full reading at every run',async()=>{
 let now=START;fresh(now);
 const ids=history(300,now);
 let run=await built(now);
 let full=await readRefundReserve(now,later());
 assert.equal(run.why,null);assert.equal(full.reserve.kind,'known');
 assert.deepEqual(run.reserve,full.reserve,'first state');
 assert.equal(run.unclassified,full.unclassified);

 const recentPlan=ids.find(id=>{const c=world.charges.get(id)!.json;return c.status==='succeeded'&&(c.invoice as {subscription?:{metadata?:{store?:string}}}|null)?.subscription?.metadata?.store==='harbor'&&now-Number(c.created)<20*DAY;})!;
 assert.ok(recentPlan);
 const steps:[string,()=>void][]=[
  ['a refund made, still pending',()=>{refund(recentPlan,1000,'pending');}],
  ['the pending refund goes through',()=>{const r=world.charges.get(recentPlan)!.refunds[0];refundStatus(recentPlan,r.id,'succeeded');}],
  ['a dispute opened',()=>{dispute(ids[3],'needs_response');}],
  ['the dispute lost',()=>{dispute(ids[3],'lost');}],
  ['thirty new charges',()=>{for(let i=0;i<30;i++)addCharge({kind:'plan',amount:6900,paidAt:now-i});}],
  ['a pending charge settles',()=>{const id=addCharge({kind:'plan',amount:44900,paidAt:now,status:'pending'});settle(id,'succeeded');}],
 ];
 for(const [what,change] of steps){
  change();world.requests.length=0;
  ({run,full}=await both(now));
  assert.equal(run.why,null,what);
  assert.deepEqual(run.reserve,full.reserve,what);
 }
 // One refund changed one charge: the run reread only it.
 refund(ids[10],100,'requires_action');world.requests.length=0;
 run=await syncRefundReserve(now,later());
 assert.equal(run.rereads,1);
 assert.equal(world.requests.filter(r=>/^\/v1\/charges\/ch_/.test(r.path)).length,1);
 assert.deepEqual(run.reserve,(await readRefundReserve(now,later())).reserve);

 // Time passes with no change at Stripe, a run every 20 days: windows close, the total follows, charges that left
 // the lookback are let go.
 const storedBefore=run.stored;
 for(let days=20;days<=300;days+=20){
  now=START+days*DAY;world.clock=Math.max(world.clock,now);
  ({run,full}=await both(now));
  assert.equal(run.why,null,String(days));
  assert.deepEqual(run.reserve,full.reserve,`after ${days} days`);
 }
 assert.ok(run.stored<storedBefore,'charges that left the lookback are no longer kept');
 // No run for longer than Stripe keeps events: unknown, built again, then equal.
 now=START+340*DAY;world.clock=Math.max(world.clock,now);
 const gap=await syncRefundReserve(now,later());
 assert.equal(gap.why,'stale');assert.equal(gap.reserve.kind,'unknown');
 run=await built(now);
 assert.deepEqual(run.reserve,(await readRefundReserve(now,later())).reserve,'after the gap');
 assert.ok(world.requests.every(r=>r.method==='GET'),'GET only');
});

test('the first state is built across runs and is unknown until it is done',async()=>{
 const now=START;fresh(now);history(250,now);
 const limits={...SYNC_LIMITS,newPages:1};
 // Three pages at one a run; the run that finishes building with no page left says so, and the next one counts.
 for(const run of [1,2,3]){
  const reading=await syncRefundReserve(now,later(),limits);
  assert.equal(reading.why,'building',`run ${run}`);assert.equal(reading.reserve.kind,'unknown');
 }
 const fourth=await syncRefundReserve(now,later(),limits);
 assert.equal(fourth.why,null);
 assert.deepEqual(fourth.reserve,(await readRefundReserve(now,later())).reserve);
});

test('a backlog past a run\'s ceilings is unknown, and the next runs converge',async()=>{
 const now=START;fresh(now);const ids=history(220,now);
 await built(now);
 for(const id of ids.slice(0,150))if(world.charges.get(id)!.json.status==='succeeded')refund(id,10,'pending');
 const limits={...SYNC_LIMITS,eventPages:1};
 const first=await syncRefundReserve(now,later(),limits);
 assert.equal(first.why,'too_many');assert.equal(first.reserve.kind,'unknown');
 let run=first;
 for(let i=0;i<5&&run.why!==null;i++)run=await syncRefundReserve(now,later(),limits);
 assert.equal(run.why,null);
 assert.deepEqual(run.reserve,(await readRefundReserve(now,later())).reserve);
});

test('a state that cannot be trusted is unknown and rebuilt; a busy lock reads nothing',async()=>{
 const now=START;fresh(now);history(120,now);
 const good=async()=>{const run=await built(now);assert.equal(run.why,null);return run;};
 await good();
 const fields=await store.pipeline([['HKEYS',SYNC_KEY]]) as string[][];
 const record=fields[0].find(f=>f.startsWith('c:'))!;
 for(const [what,corrupt] of [
  ['a record that is not its shape',()=>store.pipeline([['HSET',SYNC_KEY,record,'{"broken":']])],
  ['another format',()=>store.pipeline([['HSET',SYNC_KEY,'v','0|other']])],
  ['a cursor that is not its shape',()=>store.pipeline([['HSET',SYNC_KEY,'cursor:events','nope']])],
 ] as const){
  await corrupt();
  const run=await syncRefundReserve(now,later());
  assert.equal(run.reserve.kind,'unknown',what);
  assert.equal(run.why,'state',what);
  await good();
 }
 // The events cursor Stripe no longer keeps (past its 30 days): unknown, then rebuilt.
 const cursor=(await store.pipeline([['HGET',SYNC_KEY,'cursor:events']]))[0] as string;
 const id=JSON.parse(cursor).id as string|null;
 addCharge({kind:'plan',amount:6900,paidAt:now});
 const newest=world.events[world.events.length-1].id;
 world.forgotten.add(id??newest);if(!id)world.forgotten.add(newest);
 const stale=await syncRefundReserve(now,later());
 assert.equal(stale.why,'stale');assert.equal(stale.reserve.kind,'unknown');
 world.forgotten.clear();
 await good();

 await store.pipeline([['SET',SYNC_LOCK_KEY,'somebody','EX',100]]);
 world.requests.length=0;
 const busy=await syncRefundReserve(now,later());
 assert.equal(busy.why,'locked');assert.equal(busy.reserve.kind,'unknown');
 assert.equal(world.requests.length,0);
 assert.equal((await store.pipeline([['GET',SYNC_LOCK_KEY]]))[0],'somebody','another run\'s lock is never let go');
});

test('Redis and Stripe answers in another shape are unknown, never empty',async()=>{
 const now=START;fresh(now);history(80,now);await built(now);
 for(const [what,garble] of [
  ['HSCAN answers no list',(c:(string|number)[])=>c[0]==='HSCAN'?'0':undefined],
  ['HMGET answers too few fields',(c:(string|number)[])=>c[0]==='HMGET'?[]:undefined],
  ['HSET answers no count',(c:(string|number)[])=>c[0]==='HSET'?'OK':undefined],
 ] as const){
  addCharge({kind:'plan',amount:6900,paidAt:now});
  counted.garble=garble;
  const run=await syncRefundReserve(now,later());
  counted.garble=null;
  assert.equal(run.reserve.kind,'unknown',what);
  const after=await built(now);
  assert.deepEqual(after.reserve,(await readRefundReserve(now,later())).reserve,what+': converges');
 }
 for(const [what,answer] of [
  ['an events page that is not a list',(path:string)=>path==='/v1/events'?{object:'list',data:'x',has_more:false}:undefined],
  ['a reread of another charge',(path:string)=>/^\/v1\/charges\/ch_/.test(path)?{id:'ch_Other00000001',object:'charge'}:undefined],
 ] as const){
  // A kept charge, so its refund is reread.
  const id=[...world.charges.keys()].find(k=>world.charges.get(k)!.json.status==='succeeded'&&world.charges.get(k)!.refunds.length===0)!;
  refund(id,100,'pending');
  world.fail=answer;
  const run=await syncRefundReserve(now,later());
  world.fail=null;
  assert.equal(run.reserve.kind,'unknown',what);
  const after=await built(now);
  assert.deepEqual(after.reserve,(await readRefundReserve(now,later())).reserve,what+': converges');
 }
});

test('the ceilings are named, registered as the company\'s fixed reading cost, and the lock outlives the run',async()=>{
 assert.deepEqual(SYNC_LIMITS,{newPages:20,eventPages:10,rereads:200,disputes:50,stored:50_000,scanCount:1000,recordBytes:400,eventRetentionDays:29});
 // 280 page and read GETs, and one tie page each of charges and events.
 assert.equal(RESERVE_SYNC_STRIPE_GETS_PER_DAY,282);
 assert.equal(RESERVE_SYNC_STORED_BYTES,20_000_000);
 for(const [name,value] of [['RESERVE_SYNC_STRIPE_GETS_PER_DAY',RESERVE_SYNC_STRIPE_GETS_PER_DAY],['RESERVE_SYNC_REDIS_COMMANDS_PER_DAY',RESERVE_SYNC_REDIS_COMMANDS_PER_DAY],['RESERVE_SYNC_STORED_BYTES',RESERVE_SYNC_STORED_BYTES]] as const){
  assert.ok(NOT_A_COST[name],name+' is registered');
  assert.ok(NOT_A_COST[name].includes(value.toLocaleString('en-US')),`${name}: the registry states ${value.toLocaleString('en-US')}; a ceiling that rises without its registry fails here`);
 }
 assert.ok(FAMILIES[`${SYNC_KEY}@lib/refund-reserve-sync.ts`],'the hash is a registered company family');
 assert.ok(FAMILIES[`${SYNC_LOCK_KEY}@lib/refund-reserve-sync.ts`],'the lock is registered');
 assert.ok(SYNC_LOCK_SECONDS*1000>=SYNC_BUDGET_MS+30_000,'the lock outlives the run with room');
 assert.ok(SYNC_BUDGET_MS<=45_000,'the run ends inside a 60-second cron with its own budget');

 // One run at every ceiling stays inside the registered counts.
 const now=START;fresh(now);history(120,now);await built(now);
 for(const id of [...world.charges.keys()].slice(0,100))if(world.charges.get(id)!.json.status==='succeeded'){refund(id,10,'pending');dispute(id,'needs_response');}
 counted.commands=0;world.requests.length=0;
 await syncRefundReserve(now,later());
 assert.ok(world.requests.length<=RESERVE_SYNC_STRIPE_GETS_PER_DAY,String(world.requests.length));
 assert.ok(counted.commands<=RESERVE_SYNC_REDIS_COMMANDS_PER_DAY,String(counted.commands));
});

test('a charge or an event in the very second of the cursor, listed on the other side of it, is not missed',async()=>{
 const now=START;fresh(now);history(60,now);await built(now);
 const state=(await store.pipeline([['HMGET',SYNC_KEY,'cursor:charges','cursor:events']]))[0] as string[];
 const charges=JSON.parse(state[0]) as {id:string;at:number},events=JSON.parse(state[1]) as {id:string;at:number};
 // A charge of the cursor's second whose id sorts after the cursor's: Stripe lists it as older, so ending_before skips it.
 const made=addCharge({kind:'plan',amount:44900,paidAt:charges.at});
 const tied=world.charges.get(made)!;world.charges.delete(made);
 const lowId='ch_Reserve000000000';tied.json={...tied.json,id:lowId};world.charges.set(lowId,tied);
 world.events.pop();
 let run=await syncRefundReserve(now,later());
 assert.equal(run.why,null);
 assert.deepEqual(run.reserve,(await readRefundReserve(now,later())).reserve,'the tied charge is counted');
 // An event of the events cursor's second, on a kept charge, listed as older than the cursor.
 const kept=[...world.charges.keys()].find(k=>k!==lowId&&world.charges.get(k)!.json.status==='succeeded'&&world.charges.get(k)!.refunds.length===0)!;
 refund(kept,500,'pending');
 const event=world.events.pop()!;
 world.events.push({...event,id:'evt_Reserve000000000',created:events.at});
 run=await syncRefundReserve(now,later());
 assert.equal(run.why,null);
 assert.equal(run.rereads,1,'the tied event\'s charge is reread once');
 assert.deepEqual(run.reserve,(await readRefundReserve(now,later())).reserve,'the tied refund is counted');
 const again=await syncRefundReserve(now,later());
 assert.equal(again.rereads,0,'and not again');
});

test('many charges and events of one second, listed in another order at every request across pages, are all counted once',async()=>{
 const now=START;fresh(now);
 // Clusters of 30 charges sharing a second, so every page boundary falls inside one.
 const ids:string[]=[];
 for(let c=0;c<12;c++)for(let i=0;i<30;i++)ids.push(addCharge({kind:'plan',amount:6900+c,paidAt:now-(c+1)*3*DAY}));
 // The oracle reads Stripe in one order; the incremental reading meets the ties shuffled at every request.
 const oracle=async()=>{world.shuffleTies=false;const full=await readRefundReserve(now,later());world.shuffleTies=true;return full.reserve;};
 world.shuffleTies=true;
 let run=await built(now);
 assert.equal(run.why,null);
 assert.equal(run.stored,ids.length,'every charge kept once');
 assert.deepEqual(run.reserve,await oracle(),'built through shuffled ties');
 // Forty refunds stamped in one second, then forty new charges in one second.
 world.frozen=world.clock+1;
 for(const id of ids.slice(0,40))refund(id,100,'pending');
 world.frozen=null;
 for(let i=0;i<40;i++)ids.push(addCharge({kind:'plan',amount:44900,paidAt:now}));
 run=await syncRefundReserve(now,later());
 assert.equal(run.why,null);
 assert.equal(run.rereads,40,'each refunded charge reread once');
 assert.deepEqual(run.reserve,await oracle(),'events and charges of one second');
 run=await syncRefundReserve(now,later());
 assert.equal(run.rereads,0,'nothing reread twice');
 assert.equal(run.stored,ids.length);
 assert.deepEqual(run.reserve,await oracle());
});
