/** ACK-boundary validation plus separate actual Lua recovery proof. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {purchased} from './physical-option-confirmation-world';
import {confirmationLocalPipeline} from './order-confirmation-paid-fixture';
import {readConfirmationOrigin,runOrderConfirmationMail,confirmationOriginRowKey} from '@/lib/order-confirmation-outbox';
import {runShipmentMail,PENDING_MAIL_RECOVERY_SCRIPT} from '@/lib/shipment-mail-outbox';
import {COMMIT_ORDER_CONFIRMATION} from '@/lib/orders';
import {store as redis} from './redis-stub';

const recovery=(now:number,revision:number)=>({version:1 as const,revision,evidence:'SYNTHETIC finite recovery, no real funding',
 startsAt:now-1000,until:now+3600000,maximumAttempts:100,maximumCommandUnits:6400,maximumReadBytes:104857600,
 checkpointBytes:8192,maximumTriggerInvocations:100,triggerEvidence:'SYNTHETIC finite trigger envelope'});

test('recovery observation offers a valid option source only with express same-review coverage',async()=>{
 for(const covered of [false,true]){
  const f=await purchased(),row=(await readConfirmationOrigin(f.id,f.runtime))!;assert.ok(row);
  const parked={...row.row,next:0,checks:1};redis.run(['SET',confirmationOriginRowKey(f.id),JSON.stringify(parked)]);
  redis.run(['ZADD','nl:order-confirmation:due',-1,f.id]);f.advance(73*3600000);
  f.runtime.policy={...f.runtime.policy!,maximumChecks:2,recovery:recovery(f.runtime.now!(),1),
   coveredOrigins:covered?['physical-option-confirmation']:undefined};
  const base=f.runtime.pipeline!,finishes:(string|number)[][]=[];
  f.runtime.pipeline=async commands=>{
   if(commands[0][0]==='EVAL'&&commands[0][1]===PENDING_MAIL_RECOVERY_SCRIPT){
    const c=commands[0],op=c[3+Number(c[2])];
    if(op==='next')return[['ticket',f.id,'1']];finishes.push(c);return[['done']];
   }
   return base(commands);
  };
  const before=(await readConfirmationOrigin(f.id,f.runtime))!.raw;
  await runOrderConfirmationMail(f.runtime.now!()+30000,async()=>{throw Error('Parked source must not dispatch in this boundary proof');},f.runtime);
  assert.equal(finishes.length,1);assert.equal(finishes[0].at(-2),covered?'valid':'skip');
  assert.equal((await readConfirmationOrigin(f.id,f.runtime))?.raw,before);
 }
});

test('actual recovery skips an uncovered parked option and a later covered grant resumes it once',{
 skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT,
},async()=>{
 const realTime=Date.now,originalTime=realTime()-73*3600000;let f:Awaited<ReturnType<typeof purchased>>;
 try{Date.now=()=>originalTime;f=await purchased();}finally{Date.now=realTime;}
 f.advance(0);const source=await readConfirmationOrigin(f.id,f.runtime);assert.ok(source);const row=source.row;
 const person=createHash('sha256').update('buyer@example.test').digest('hex');
 const keys=[confirmationOriginRowKey(f.id),`nl:order-confirmation:source:${f.id}`,'nl:order-confirmation:due',
  `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,
  'nl:ship:mail:pool',`nl:ship:mail:pool:${row.statsId}`,'nl:ship:mail:all',`nl:order-confirmation:closed:${row.statsId}`,
  `nl:order-confirmation:erased:${row.statsId}:${row.person}`,`nl:order-confirmation:person:${row.statsId}:${person}`,
  `nl:order-confirmation:erased:${row.statsId}:${person}`];
 const made=new Set(keys);let settlement:(string|number)[]|undefined;
 assert.ok((await confirmationLocalPipeline(keys.map(k=>['TYPE',k]))).every(t=>t==='none'));
 try{
  // Source made by real checkout with synthetic provider/ACK. Native source
  // construction is covered separately; here exact Lua runs on disposable Redis.
  await confirmationLocalPipeline([['SET',keys[0],source.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,row.id],
   ...[3,4,7].map(i=>['SADD',keys[i],row.id]),['HSET',keys[5],'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
  const runtime={...f.runtime,now:realTime,policy:{...f.runtime.policy!,maximumChecks:1},pipeline:async(commands:(string|number)[][])=>{
   for(const c of commands)if(c[0]==='EVAL'&&c[1]===COMMIT_ORDER_CONFIRMATION&&!settlement){
    settlement=c;c.slice(3,9).forEach(k=>made.add(String(k)));
    assert.ok((await confirmationLocalPipeline(c.slice(3,9).map(k=>['TYPE',String(k)]))).every(t=>t==='none'));
    await confirmationLocalPipeline([['HSET',String(c[5]),String(c[10]),2],['HSET',String(c[6]),String(c[10]),2*Number(c[11])]]);
   }
   return confirmationLocalPipeline(commands);
  }};
  const first=await runOrderConfirmationMail(realTime()+30000,async()=> 'waiting',runtime,f.id);assert.equal(first.waiting,1);
  const parked=await readConfirmationOrigin(f.id,runtime);assert.ok(parked?.payload.message);
  assert.equal(parked.row.checks,1);assert.equal(parked.row.next,0);
  assert.deepEqual(await confirmationLocalPipeline([['ZSCORE',keys[2],f.id],['TTL',keys[0]],['HGET',keys[5],'items']]),['-1',-1,'1']);
  const uncovered={...runtime,policy:{...runtime.policy,reviewId:'SYNTHETIC_OPTION_UNCOVERED',continuedReviewIds:[runtime.policy.reviewId],
   coveredOrigins:undefined,maximumChecks:3,recovery:recovery(realTime(),1)}};
  const providerReads=f.calls.length;let sent=0;
  for(let pass=0;pass<4;pass++){
   await runShipmentMail(realTime()+30000,async()=>{throw Error('No shipment source');},uncovered);
   await runOrderConfirmationMail(realTime()+30000,async()=>{sent++;return'accepted';},uncovered);
  }
  assert.equal(sent,0);assert.equal(f.calls.length,providerReads);
  const held=await confirmationLocalPipeline([['ZSCORE',keys[2],f.id],['GET',keys[0]],['HGET',keys[5],'items']]);
  assert.equal(held[0],'-1');assert.equal(held[1]===parked.raw,true,'original protected payload remains byte-identical');assert.equal(held[2],'1');
  const checkpoint=JSON.parse(String((await confirmationLocalPipeline([['HGET',keys[5],'pendingRecovery']]))[0]));
  assert.equal(checkpoint.phase,'done','a known unsupported position advances instead of pinning the cursor');
  const covered={...runtime,policy:{...runtime.policy,reviewId:'SYNTHETIC_OPTION_COVERED',continuedReviewIds:[runtime.policy.reviewId,uncovered.policy.reviewId],
   maximumChecks:3,recovery:recovery(realTime(),2)}};
  for(let pass=0;pass<6;pass++){
   await runShipmentMail(realTime()+30000,async()=>{throw Error('No shipment source');},covered);
   await runOrderConfirmationMail(realTime()+30000,async(message,barrier)=>{
    assert.equal(JSON.stringify(message),JSON.stringify(parked.payload.message));assert.equal(await barrier(),true);sent++;return'accepted';
   },covered);
  }
  assert.equal(sent,1);assert.ok(settlement);
  assert.deepEqual(await confirmationLocalPipeline([['GET',String(settlement[4])],['HGET',String(settlement[5]),String(settlement[10])],
   ['HGET',keys[5],'items'],['EXISTS',keys[0]]]),['1','1','0',0]);
  assert.ok(Number((await confirmationLocalPipeline([['TTL',keys[1]]]))[0])>399*86400);
 }finally{await confirmationLocalPipeline([['DEL',...made]]);}
});
