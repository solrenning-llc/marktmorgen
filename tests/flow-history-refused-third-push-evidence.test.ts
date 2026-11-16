import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepFlowVersion} from '@/lib/flow-versions';
import type {Flow} from '@/lib/flows';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
const list='G2HistoryRoomRace',id='a'.repeat(16),key=`nl:wf:ver:${list}:${id}`,slot='wv:'+id;
const flow=(body:string):Flow=>({id,name:'Synthetic sequence',trigger:'joined',productId:null,createdAt:1,tag:'',active:false,steps:[{id:'b'.repeat(12),delayHours:0,subject:'Synthetic subject',body}]});
const after=flow('The proposed next version.');
// The workflow is saved: a version is kept only while its workflow is still there (Codex G on #1927).
const saved=()=>redis.run(['SET',`nl:mail:flows:${list}`,JSON.stringify([after])]);
test('control: sequential history writes retain and charge the complete list',async()=>{
 redis.clear();saved();assert.equal(await keepFlowVersion(ROOM,list,flow('one'),after,1),true);assert.equal(await keepFlowVersion(ROOM,list,flow('two'),after,2),true);
 const held=redis.run(['LRANGE',key,0,-1]) as string[];assert.ok(Number(redis.run(['HGET',dataKey(ROOM)!,slot]))>=dataBytes(held,held.length));
});
test('recount after a refused old push cannot shrink the room of a newer third push',async()=>{
 redis.clear();saved();assert.equal(await keepFlowVersion(ROOM,list,flow('Initial'),after,1),true);
 const base=redis.pipeline.bind(redis);let phase=0;
 redis.pipeline=async batch=>{
  if(phase===0&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:flow-version-keep:'))){
   phase=1;redis.pipeline=base;
   assert.equal(await keepFlowVersion(ROOM,list,flow('B'.repeat(400)),after,3),true);
   redis.pipeline=spy;
  }
  const answer=await base(batch);
  // Identified copy (Claude 3): the head no longer reads the list again after a refusal, so the newer third push lands
  // right after the refused EVAL's answer instead of after a recount; every assertion on the room is unchanged.
  if(phase===1&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:flow-version-keep:'))){
   phase=2;redis.pipeline=base;
   assert.equal(await keepFlowVersion(ROOM,list,flow('C'.repeat(800)),after,4),true);
   redis.pipeline=spy;
  }
  return answer;
 };
 const spy=redis.pipeline;
 try{
  const kept=await keepFlowVersion(ROOM,list,flow('A'.repeat(100)),after,2);assert.equal(kept,false);assert.equal(phase,2);
  const held=redis.run(['LRANGE',key,0,-1]) as string[],required=dataBytes(held,held.length),charged=Number(redis.run(['HGET',dataKey(ROOM)!,slot]));
  console.log('G2_HISTORY_RECOUNT_RACE',JSON.stringify({entries:held.length,charged,required}));assert.ok(charged>=required,'the stale recount released storage still holding the newest version');
 }finally{redis.pipeline=base;}
});

// Codex G2's residual on #1927 (proof codex/g2-review-1927-history-recount-red, 718223e4): a recount read after a
// refused push could go stale under a newer push and shrink the room. The window is the read itself, so the fix is
// that none happens: after the refused EVAL, keepFlowVersion reads nothing of the list again (it gives back only its
// own taking, by difference). On 1743533e this fails: an LRANGE of the list follows the refusal.
test('after a refused push, nothing reads the list again, so no recount can go stale', async () => {
  redis.clear();saved(); assert.equal(await keepFlowVersion(ROOM, list, flow('Initial'), after, 1), true);
  const base = redis.pipeline.bind(redis); let refused = false; const readsAfter: string[] = [];
  redis.pipeline = async (batch) => {
    if (refused) for (const c of batch) if (c[1] === key || c[3] === key) readsAfter.push(String(c[0]));
    if (!refused && batch.some((c) => c[0] === 'EVAL' && String(c[1]).startsWith('-- marktmorgen:flow-version-keep:'))) {
      redis.pipeline = base; assert.equal(await keepFlowVersion(ROOM, list, flow('B'.repeat(400)), after, 3), true); redis.pipeline = spy;
      refused = true;
    }
    return base(batch);
  };
  const spy = redis.pipeline;
  try {
    assert.equal(await keepFlowVersion(ROOM, list, flow('A'.repeat(100)), after, 2), false);
    assert.deepEqual(readsAfter, []);
    const held = redis.run(['LRANGE', key, 0, -1]) as string[];
    assert.ok(Number(redis.run(['HGET', dataKey(ROOM)!, slot])) >= dataBytes(held, held.length));
  } finally { redis.pipeline = base; }
});
