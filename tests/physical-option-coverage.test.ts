/** Mechanical same-review recipe coverage only, not private financial proof. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shipmentMailPolicy,SHIPMENT_MAIL_SCRIPT} from '@/lib/shipment-mail-outbox';
import {shipmentPolicy} from './shipment-mail-outbox-fixture';
import {singleDigitalFixture,reserveDigital} from './single-digital-confirmation-world';
import {confirmationLocalPipeline} from './order-confirmation-paid-fixture';
const all=['course-confirmation','single-digital-confirmation','single-digital-access-renewal','physical-option-confirmation'];

test('one physical recipe and both mixed lists survive quantitative policy capture in original order',()=>{
 for(const coveredOrigins of [['physical-option-confirmation'],['single-digital-confirmation','physical-option-confirmation'],all]){
  const p=shipmentMailPolicy({...shipmentPolicy(),coveredOrigins});assert.ok(p);
  assert.deepEqual(p.coveredOrigins,coveredOrigins);assert.notEqual(p.coveredOrigins,coveredOrigins);
 }
});
test('omitting coverage retains the exact legacy JSON and does not create a property',()=>{
 const p=shipmentPolicy(),got=shipmentMailPolicy(p);assert.ok(got);assert.equal(Object.hasOwn(got,'coveredOrigins'),false);
 assert.equal(JSON.stringify(got),JSON.stringify(p));
});
test('unknown, duplicated, empty and excessive recipes still refuse',()=>{
 for(const coveredOrigins of [[],['unknown-recipe'],['single-digital-confirmation','single-digital-confirmation'],[...all,'unknown-recipe']])
  assert.equal(shipmentMailPolicy({...shipmentPolicy(),coveredOrigins}),null);
 assert.equal(shipmentMailPolicy({...shipmentPolicy(),coveredOrigins:all,ongoingStorageFunded:false}),null);
});
test('coverage cannot be inherited or accessor-backed to bypass the policy schema',()=>{
 let reads=0;const list=[...all];Object.defineProperty(list,'0',{get(){reads++;throw Error('no');}});
 assert.equal(shipmentMailPolicy({...shipmentPolicy(),coveredOrigins:list}),null);
 assert.equal(shipmentMailPolicy(Object.assign(Object.create({coveredOrigins:all}),shipmentPolicy())),null);assert.equal(reads,0);
});

test('actual Lua admits mixed recipes once and refuses bad or missing digital coverage before data writes',{
 skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT,
},async()=>{
 for(const coveredOrigins of [['single-digital-confirmation','physical-option-confirmation'],all]){
  const f=await singleDigitalFixture(),seed=await reserveDigital(f);assert.ok(seed.result.ok);
  const original=f.commands.find(c=>c[0]==='EVAL'&&c[1]===SHIPMENT_MAIL_SCRIPT&&c[13]==='enqueue');assert.ok(original);
  const command:(string|number)[]=[...original],keys=command.slice(3,13).map(String),policy=JSON.parse(String(command[18]));
  assert.ok((await confirmationLocalPipeline(keys.map(key=>['TYPE',key]))).every(t=>t==='none'));
  try{
   for(const invalid of [[],['unknown-recipe'],['single-digital-confirmation','single-digital-confirmation'],['physical-option-confirmation'],[...all,'unknown-recipe']]){
    const denied:(string|number)[]=[...command];denied[18]=JSON.stringify({...policy,coveredOrigins:invalid});
    assert.equal(((await confirmationLocalPipeline([denied]))[0] as string[])[0],'unknown');
    assert.ok((await confirmationLocalPipeline(keys.map(key=>['TYPE',key]))).every(t=>t==='none'),'no origin/source/pool data keys written');
   }
   command[18]=JSON.stringify({...policy,coveredOrigins});
   assert.equal(((await confirmationLocalPipeline([command]))[0] as string[])[0],'queued');
   assert.deepEqual(await confirmationLocalPipeline([['TTL',keys[0]],['TTL',keys[1]],['HGET',keys[5],'items']]),[-1,-1,'1']);
   assert.equal(((await confirmationLocalPipeline([command]))[0] as string[])[0],'existing');
   assert.deepEqual(await confirmationLocalPipeline([['HGET',keys[5],'items'],['GET',keys[0]]]),['1',String(command[15])]);
  }finally{await confirmationLocalPipeline([['DEL',...keys]]);}
 }
});
