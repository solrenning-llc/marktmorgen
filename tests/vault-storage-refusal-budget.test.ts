import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as vaultPost } from '../app/api/store/vault/route';
import { CURRENT_UPLOAD_BUDGET_POLICY as policy } from './upload-budget-approved-policy';
import { reset, seed } from './upload-budget-redis';
import { state, resetWorld } from './upload-route-world';
import { reserveStoreUploadReceipt } from '../lib/upload-budget';

// Issue #3960: a storage refusal happens before any upload session is opened,
// so the bytes it asked for go back to the store's monthly upload budget.
// The open itself stays spent: the storage measurement is a priced provider listing.
const request=(body:unknown)=>new Request('https://marktmorgen.example.test/api/store/vault',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) as Parameters<typeof vaultPost>[0];
const open=(bytes:number)=>request({action:'open',ownerId:'product-1',name:'file.pdf',bytes,type:'application/pdf',multipart:true});
const ledger=()=>{reset();resetWorld();return seed(policy);};

for(const [refusal,status,error] of [['storage_limit',400,'storage_full'],['storage_pending',409,'uploads_pending'],['storage_busy',409,'uploads_pending']] as const){
  test(`a ${refusal} refusal gives the asked bytes back and keeps the open spent`,async()=>{
    const row=ledger();const id='store:'+state.store.statsId+':';
    state.storageRefuses=refusal;
    const refused=await vaultPost(open(6));
    assert.equal(refused.status,status);assert.equal((await refused.json()).error,error);
    assert.equal(row.get(id+'bytes'),'0');assert.equal(row.get('company:bytes'),'0');
    assert.equal(row.get(id+'opens'),'1');assert.equal(row.get('company:opens'),'1');
    state.storageRefuses='';
    // 6 + 6 bytes would pass the store's 10-byte month if the refusal had kept them.
    const after=await vaultPost(open(6));
    assert.equal(after.status,200);assert.equal(row.get(id+'bytes'),'6');assert.equal(row.get(id+'opens'),'2');
  });
}

test('a refusal that is not about storage still retains the full reservation',async()=>{
  const row=ledger();state.storageRefuses='storage_unknown';
  assert.equal((await vaultPost(open(6))).status,503);
  assert.equal(row.get('store:'+state.store.statsId+':bytes'),'6');
});

test('bytes go back once, only to the same policy, never below zero',async()=>{
  const row=ledger();const id='store:'+state.store.statsId+':';
  const first=await reserveStoreUploadReceipt(state.store,4,'r2',policy);
  assert.ok(first);assert.equal(row.get(id+'bytes'),'4');
  assert.equal(await first.returnBytes(),true);assert.equal(await first.returnBytes(),false);
  assert.equal(row.get(id+'bytes'),'0');assert.equal(row.get(id+'opens'),'1');
  const second=await reserveStoreUploadReceipt(state.store,3,'r2',policy);
  assert.ok(second);row.set(id+'bytes','2');
  assert.equal(await second.returnBytes(),false);assert.equal(row.get(id+'bytes'),'2');
  row.set(id+'bytes','3');row.set('policy','another-policy');
  assert.equal(await second.returnBytes(),false);assert.equal(row.get(id+'bytes'),'3');
});

