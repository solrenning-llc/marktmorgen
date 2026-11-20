/**
 * #4775, Codex X5 (X5-20261119-0922-fix-branch-claude7-wip-4775-payreq-delete, MEDIUM): a payment request's deletion
 * is one atomic, fenced step. The record went first in a pipeline, so a partial run lost the reference a retry needs,
 * and a delete that ran past its own lock could remove the next holder's new version. Synthetic Redis only.
 */
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteRequest, requestRecordKey } from '@/lib/payment-request-store';
import { personKey } from '@/lib/person-key';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';
const real=redis.pipeline.bind(redis),sid='b'.repeat(32),id='a'.repeat(32),email='delete-atomic@example.com';
const owner={sid} as Store,record=requestRecordKey(id),lock=`nl:payreq:w:${id}`;
const indexes=[`nl:payreq:s:${sid}`,`nl:payreq:o:${sid}`,'nl:payreq:due',`nl:payreq:p:${sid}:${personKey(sid,email)}`];
const now=Date.UTC(2030,0,1),value={id,sid,email,name:'Synthetic',lines:[],note:'synthetic only',currency:'usd',total:100,createdAt:now,expiresAt:now+86400000,state:'canceled',autoReminders:0,sent:[],failed:'',session:'',sessionAt:0,paidAt:0,amountPaid:0,payment:'',refunded:0,closedAt:now};
type Commands=(string|number)[][];
const deletion=(commands:Commands)=>commands.some(c=>(c[0]==='DEL'&&c[1]===record)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:payreq-delete:v1\n')));
const links=()=>[redis.run(['ZSCORE',indexes[0],id])!==null,redis.run(['ZSCORE',indexes[1],id])!==null,redis.run(['ZSCORE',indexes[2],`${sid}|${id}`])!==null,redis.run(['SISMEMBER',indexes[3],id])===1];
beforeEach(()=>{redis.clear();redis.run(['SET',record,JSON.stringify(value)]);redis.run(['ZADD',indexes[0],now,id]);redis.run(['ZADD',indexes[1],now,id]);redis.run(['ZADD',indexes[2],now,`${sid}|${id}`]);redis.run(['SADD',indexes[3],id]);});
afterEach(()=>{redis.pipeline=real;});
test('an unconfirmed deletion retains its record or removes every link; the retry can finish',async()=>{
 redis.pipeline=async commands=>{if(deletion(commands)){if(commands[0][0]==='DEL')await real([commands[0]]);return [];}return real(commands);};
 await assert.rejects(deleteRequest(owner,id,now));
 assert.ok(redis.run(['EXISTS',record])===1||links().every(x=>!x),'the only deletion proof is never dropped while personal indexes remain');
 redis.pipeline=real;assert.equal(await deleteRequest(owner,id,now),'deleted');assert.deepEqual(links(),[false,false,false,false]);
});
test('a delete delayed past its own lock cannot remove the next holder generation',async()=>{
 let paused=false;redis.pipeline=async commands=>{if(!paused&&deletion(commands)){paused=true;await real([['SET',lock,'next-holder','EX',10],['SET',record,JSON.stringify({...value,state:'open',note:'next generation'})]]);}return real(commands);};
 await assert.rejects(deleteRequest(owner,id,now));assert.equal(JSON.parse(String(redis.run(['GET',record]))).note,'next generation');assert.deepEqual(links(),[true,true,true,true]);assert.equal(redis.run(['GET',lock]),'next-holder');
});
test('a record changed under an unchanged lock is not the generation observed by the delete',async()=>{
 let paused=false;redis.pipeline=async commands=>{if(!paused&&deletion(commands)){paused=true;await real([['SET',record,JSON.stringify({...value,note:'changed generation'})]]);}return real(commands);};
 await assert.rejects(deleteRequest(owner,id,now));assert.equal(JSON.parse(String(redis.run(['GET',record]))).note,'changed generation');assert.deepEqual(links(),[true,true,true,true]);
});
test('a wrong-kind index is refused before any mutation, including the record deletion',async()=>{
 redis.run(['DEL',indexes[3]]);redis.run(['SET',indexes[3],'wrong-kind synthetic index']);await assert.rejects(deleteRequest(owner,id,now));assert.equal(redis.run(['EXISTS',record]),1);assert.deepEqual(indexes.slice(0,3).map((key,i)=>redis.run(['ZSCORE',key,i===2?`${sid}|${id}`:id])!==null),[true,true,true]);
});
test('a lost acknowledgement after a completed atomic deletion leaves no personal link',async()=>{
 redis.pipeline=async commands=>{const result=await real(commands);return deletion(commands)?[]:result;};await assert.rejects(deleteRequest(owner,id,now));assert.equal(redis.run(['EXISTS',record]),0);assert.deepEqual(links(),[false,false,false,false]);redis.pipeline=real;assert.equal(await deleteRequest(owner,id,now),null);
});
test('a healthy deletion confirms all five removals',async()=>{assert.equal(await deleteRequest(owner,id,now),'deleted');assert.equal(redis.run(['EXISTS',record]),0);assert.deepEqual(links(),[false,false,false,false]);});
