import { PAID_STORAGE_BYTES } from '../lib/storage-rules';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as vaultPost } from '../app/api/store/vault/route';
import { POST as streamPost } from '../app/api/store/stream/route';
import { POST as blobPost } from '../app/api/store/file/route';
import { CURRENT_UPLOAD_BUDGET_POLICY as policy } from './upload-budget-approved-policy';
import { reset, seed, hashes, calls, settings } from './upload-budget-redis';
import { state, resetWorld, PATH, FOLDER } from './upload-route-world';
const request=(body:unknown)=>new Request('https://marktmorgen.example.test/api/store/vault',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) as Parameters<typeof vaultPost>[0];
const open=(bytes=5)=>request({action:'open',ownerId:'product-1',name:'file.pdf',bytes,type:'application/pdf',multipart:true});
function begin(){reset();resetWorld();return seed(policy);}

test('R2 provider opens only after an actual monthly reservation',async()=>{
 const row=begin();const response=await vaultPost(open());assert.equal(response.status,200);assert.deepEqual(state.events,['provider:open']);assert.equal(row.get('store:'+state.store.statsId+':opens'),'1');assert.equal(row.get('store:'+state.store.statsId+':bytes'),'5');
});
test('failed provider opens and retries retain their full original reservation',async()=>{
 const row=begin();state.providerFails=true;assert.equal((await vaultPost(open(6))).status,503);state.providerFails=false;assert.equal((await vaultPost(open(5))).status,503);assert.deepEqual(state.events,['provider:open']);assert.equal(row.get('store:'+state.store.statsId+':bytes'),'6');assert.equal((await vaultPost(open(4))).status,200);
});
test('lost ledger acknowledgement cannot cause an unreserved provider call',async()=>{
 const row=begin();settings({lostAck:true});assert.equal((await vaultPost(open(6))).status,503);assert.deepEqual(state.events,[]);settings({lostAck:false});assert.equal((await vaultPost(open(5))).status,503);assert.equal(row.get('store:'+state.store.statsId+':bytes'),'6');
});
test('missing ledgers and stale policies refuse new grants and signatures',async()=>{
 begin();hashes.clear();assert.equal((await vaultPost(open())).status,503);assert.equal((await vaultPost(request({action:'sign',pathname:PATH,numbers:[1]}))).status,503);assert.deepEqual(state.events,[]);
 const month=policy.month;try{policy.month='2000-01';assert.equal((await vaultPost(open())).status,503);}finally{policy.month=month;}
});
test('completion and cancellation of existing grants work while new admission is paused',async()=>{
 begin();hashes.clear();const month=policy.month;try{policy.month='2000-01';assert.equal((await vaultPost(request({action:'done',pathname:PATH,etags:['etag']}))).status,200);assert.equal((await vaultPost(request({action:'abort',pathname:PATH}))).status,200);}finally{policy.month=month;}
 assert.deepEqual(state.events,['provider:complete','provider:abort']);assert.equal(calls.length,0);
});
test('signatures have a monthly control ceiling instead of only an hourly rate',async()=>{
 begin();for(let i=0;i<6;i++)assert.equal((await vaultPost(request({action:'sign',pathname:PATH,numbers:[1]}))).status,200);assert.equal((await vaultPost(request({action:'sign',pathname:PATH,numbers:[1]}))).status,503);assert.equal(state.events.filter(x=>x==='provider:sign').length,6);
});
test('unproven direct providers cannot bypass the R2 budget through fallback',async()=>{
 begin();state.vaultConfigured=false;const blob=await blobPost(request({pathname:'files/'+FOLDER+'/product-1/file.pdf',clientPayload:JSON.stringify({productId:'product-1'})}));assert.equal(blob.status,503);
 const stream=await streamPost(request({lessonId:'lesson-1',name:'video.mp4',bytes:5,type:'video/mp4'}));assert.equal(stream.status,404);assert.equal((await stream.json()).error,'off');assert.deepEqual(state.events,[]);
 state.vaultConfigured=true;assert.equal((await vaultPost(open())).status,200);assert.deepEqual(state.events,['provider:open']);
});
test('authentication and ownership refuse requests before consuming capacity',async()=>{
 begin();state.auth=false;assert.equal((await vaultPost(open())).status,401);assert.equal(calls.length,0);state.auth=true;state.owns=false;state.lessonOwned=false;assert.equal((await vaultPost(open())).status,404);assert.equal(calls.length,0);assert.deepEqual(state.events,[]);
});

test('a storage refusal, decided before any upload session is opened, leaves the monthly upload budget untouched',async()=>{
 const row=begin(),id='store:'+state.store.statsId+':';
 for(const [refusal,status,error] of [['storage_limit',400,'storage_full'],['storage_limit',400,'storage_full'],['storage_pending',409,'uploads_pending'],['storage_busy',409,'uploads_pending']] as const){
  state.storageRefusal=refusal;const response=await vaultPost(open(5));assert.equal(response.status,status);assert.equal((await response.json()).error,error);
 }
 assert.deepEqual(state.events,[]);
 for(const name of ['opens','bytes','controls'])assert.equal(row.get(id+name),undefined,name+' of the store were not taken');
 for(const name of ['opens','bytes','controls'])assert.equal(row.get('company:'+name),'0','company '+name+' were not taken');
 assert.equal(row.get('slots:creator'),String(policy.fundedStores.creator),'no funded slot was claimed');
 state.storageRefusal=null;assert.equal((await vaultPost(open(5))).status,200);assert.equal(row.get(id+'opens'),'1');assert.equal(row.get(id+'bytes'),'5');assert.deepEqual(state.events,['provider:open']);
});test('a spent upload budget is refused before storage is measured or cleaned up, with nothing written',async()=>{
 const row=begin(),id='store:'+state.store.statsId+':';
 // Starts spent: the policy gives a store two.
 assert.equal((await vaultPost(open(1))).status,200);assert.equal((await vaultPost(open(1))).status,200);
 const measured=state.storageLimits.length,before=new Map(row),commands=calls.length;
 const refused=await vaultPost(open(1));assert.equal(refused.status,503);assert.equal((await refused.json()).error,'upload_budget_unavailable');
 assert.equal(state.storageLimits.length,measured,'no storage measurement or cleanup');assert.deepEqual(state.events,['provider:open','provider:open']);
 assert.deepEqual(new Map(row),before,'the ledger is unchanged');assert.equal(calls.length-commands,1,'one read-only check');
 // Bytes spent: the policy gives a store ten.
 const bytesRow=begin();assert.equal((await vaultPost(open(9))).status,200);
 const bytesMeasured=state.storageLimits.length,bytesBefore=new Map(bytesRow);
 assert.equal((await vaultPost(open(2))).status,503);assert.equal(state.storageLimits.length,bytesMeasured);assert.deepEqual(new Map(bytesRow),bytesBefore);
 assert.equal(bytesRow.get(id+'bytes'),'9');
});
test('an unknown or malformed reply to the budget check refuses before storage is measured',async()=>{
 for(const reply of [[],['1'],[true],[2],[1,1],[null]]){
  begin();settings({reply});const response=await vaultPost(open(1));settings({reply:null});
  assert.equal(response.status,503,JSON.stringify(reply));assert.equal(state.storageLimits.length,0);assert.deepEqual(state.events,[]);assert.equal(calls.length,1);
 }
});

test('actual R2 route passes each paid tier storage limit to admission',async()=>{
 for(const tier of ['creator','pro','scale'] as const){begin();state.store.tier=tier;assert.equal((await vaultPost(open())).status,200);assert.deepEqual(state.storageLimits,[PAID_STORAGE_BYTES[tier]]);}
});
test('a Store trial cannot authorize the larger generic trial storage',async()=>{
 begin();state.store.trialEnds=Math.floor(Date.now()/1000)+86400;assert.equal((await vaultPost(open())).status,200);assert.deepEqual(state.storageLimits,[PAID_STORAGE_BYTES.creator]);
});
