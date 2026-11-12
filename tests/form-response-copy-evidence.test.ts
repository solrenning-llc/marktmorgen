/** Real form copier and store stream, with MemoryRedis and no provider IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPIERS } from '@/lib/person-copy';
import { erasureScope } from '@/lib/person-erasure';
import { storeExport } from '@/lib/store-export';
import { claimHandle, ensureStatsId, storeForEmail } from '@/lib/store';
import { writeForm } from '@/lib/form-store';
import { UnknownReply } from '@/lib/redis-exact';
import { store as redis } from './redis-stub';
import { form, responses } from './form-response-fixture';
test('unknown form answers abort the real person copier and mark the store stream incomplete',async()=>{
 redis.clear();const owner='form-owner@example.com',email='person@example.com';
 await claimHandle(owner,'formcopy','Synthetic form shop','');await ensureStatsId(owner);
 const store=(await storeForEmail(owner))!;assert.equal(await writeForm(store.statsId!,form),true);
 const key=`nl:form:r:${store.statsId}:${form.id}`;
 await redis.pipeline([['LPUSH',key,JSON.stringify({...responses[0],answers:{email0:email}})]]);
 const scope=(await erasureScope(store,email))!;const pipeline=redis.pipeline.bind(redis),fetchBefore=globalThis.fetch;
 let unknown=false,commands=0,provider=0;
 globalThis.fetch=(async()=>{provider++;throw Error('No provider allowed');}) as typeof fetch;
 redis.pipeline=async batch=>{
  if(commands+batch.length>300)throw Error('Synthetic read ceiling exceeded');commands+=batch.length;
  if(unknown&&batch.length===2&&batch[0][0]==='LRANGE'&&batch[0][1]===key)return [null,1];
  return pipeline(batch);
 };
 try{
  assert.equal((await COPIERS['lib/form-store.ts'](scope)).length,1);
  const known=JSON.parse(await new Response(storeExport(store)).text());assert.equal(known.forms[0].answers.length,1);assert.equal(known.unreadPart4,undefined);
  unknown=true;
  let copyUnknown=false;
  try{await COPIERS['lib/form-store.ts'](scope);}catch(error){copyUnknown=error instanceof UnknownReply;}
  const partial=JSON.parse(await new Response(storeExport(store)).text());assert.deepEqual({copyUnknown,formsOmitted:partial.forms===undefined,unread:typeof partial.unreadPart4==='string'&&partial.unreadPart4.includes('could not be read')},{copyUnknown:true,formsOmitted:true,unread:true});
  assert.equal(provider,0);
 }finally{redis.pipeline=pipeline;globalThis.fetch=fetchBefore;}
});
