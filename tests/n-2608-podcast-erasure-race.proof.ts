import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {forgetPodcastPerson,tokenKey} from '@/lib/podcast-access';
import {data,trace,reset,onRead,override} from './n-2608-world';
const store={statsId:'podcast-proof-store'} as Parameters<typeof forgetPodcastPerson>[0];
const pid='a'.repeat(32),email='reader@example.test';
const key=createHash('sha256').update('nimbus-podcast:'+email).digest('hex').slice(0,32);
const by=`nl:pod:by:${store.statsId}:${pid}:${key}`;
const ok=`nl:pod:ok:${store.statsId}:${pid}:${key}`;
const first='1'.repeat(48),next='2'.repeat(48);
function seed(){reset();data.set(by,first);data.set(ok,'1');data.set(tokenKey(first),'old synthetic grant');}

test('control: confirmed current token and index are deleted, retry remains idempotent',async()=>{
 seed();assert.equal(await forgetPodcastPerson(store,[pid],email),3);
 assert.equal(data.size,0);assert.equal(await forgetPodcastPerson(store,[pid],email),0);
});
test('a token replaced after GET remains discoverable or the erasure reports uncertainty',async()=>{
 seed();onRead(()=>{data.set(by,next);data.set(tokenKey(next),'new synthetic grant');});
 let refused=false;
 try{await forgetPodcastPerson(store,[pid],email);}catch{refused=true;}
 const afterFirst={index:data.get(by)??null,grant:data.has(tokenKey(next))};
 await forgetPodcastPerson(store,[pid],email);
 const afterRetry={index:data.get(by)??null,grant:data.has(tokenKey(next))};
 assert.ok(!afterFirst.grant||(refused&&afterFirst.index===next),JSON.stringify({afterFirst,afterRetry,refused}));
});
test('unknown token read never deletes the only index and reports completion',async()=>{
 seed();override((commands,real)=>commands[0][0]==='GET'?[undefined]:real);
 await assert.rejects(forgetPodcastPerson(store,[pid],email));
 assert.equal(trace.some(cs=>cs.some(c=>c[0]==='DEL')),false);
});
test('unknown DEL acknowledgement never becomes confirmed zero records',async()=>{
 seed();override((commands,real)=>commands[0][0]==='DEL'?[undefined]:real);
 await assert.rejects(forgetPodcastPerson(store,[pid],email));
});
