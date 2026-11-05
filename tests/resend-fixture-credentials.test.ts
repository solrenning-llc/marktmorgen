/** Real guard and synthetic provider answers; no environment credential may
 * become a synthetic reviewed account merely by being present. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {currentResendFallbackProofIsMissing,guardedResendPost,prepareResendFallbackFixture} from './resend-fallback-fixture';
import {currentResendFallbackProofIsMissing as browserMissing,guardedResendPost as browserPost} from './e2e/reviewed-resend-transport';
import {store} from './redis-stub';
import {syntheticResendCredential} from './resend-fixture-credentials';
import {createRequire} from 'node:module';
import {MemoryRedis} from '@/lib/redis-memory';
const known='re_test_fixture1',unknown='re_unrecognized_test_probe_only';
const input=(credential:string)=>({base:'https://api.resend.com',path:'/emails' as const,credential,usageCredential:credential,body:JSON.stringify({from:'owner@example.test',to:['buyer@example.test'],subject:'Synthetic',text:'No real message'}),recipients:1});
test('unrecognized environment credentials never issue a synthetic proof or POST',async()=>{
 const previous=process.env.RESEND_API_KEY,read=process.env.RESEND_READ_API_KEY,fetcher=globalThis.fetch;let posts=0,hashes=0,ledger=0;
 const crypto=createRequire(process.cwd()+'/package.json')('node:crypto') as typeof import('node:crypto');
 const hash=crypto.createHash,run=MemoryRedis.prototype.run;
 crypto.createHash=(algorithm,options)=>{hashes++;return hash(algorithm,options);};
 MemoryRedis.prototype.run=function(command){ledger++;return run.call(this,command);};
 try{store.clear();process.env.RESEND_API_KEY=unknown;delete process.env.RESEND_READ_API_KEY;
  globalThis.fetch=async()=>{posts++;return Response.json({id:'synthetic'});};
  assert.equal(currentResendFallbackProofIsMissing(),true);
  assert.equal((await guardedResendPost(input(unknown))).kind,'blocked');assert.equal(posts,0);
  assert.equal(browserMissing(),true);assert.equal((await browserPost(input(unknown))).kind,'blocked');assert.equal(posts,0);
  assert.equal(hashes,0);assert.equal(ledger,0);
 }finally{crypto.createHash=hash;MemoryRedis.prototype.run=run;globalThis.fetch=fetcher;if(previous===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=previous;if(read===undefined)delete process.env.RESEND_READ_API_KEY;else process.env.RESEND_READ_API_KEY=read;store.clear();}
});
test('explicit fixture constructors reject unknown credentials before initialization',async()=>{
 let posts=0;assert.throws(()=>prepareResendFallbackFixture({credential:unknown,fetch:async()=>{posts++;return Response.json({id:'synthetic'});}}),/synthetic fixture credential/);assert.equal(posts,0);
});
test('recognized literals still use the real guard and finite inbound-inclusive budget',async()=>{
 let posts=0;const fixture=prepareResendFallbackFixture({credential:known,cap:2,received:1,fetch:async()=>{posts++;return Response.json({id:'synthetic'});}});await fixture.ready;
 assert.equal((await guardedResendPost(input(known),fixture.runtime)).kind,'response');
 assert.equal((await guardedResendPost({...input(known),body:input(known).body+' '},fixture.runtime)).kind,'blocked');
 assert.equal(posts,1);assert.equal(fixture.usage().monthly.used,2);
});

test('literal canonicalization never coerces unknown values or executes accessors',()=>{
 let reads=0;const hostile={get toString(){reads++;throw Error('must not execute');}};
 for(const value of [undefined,null,17,{},hostile,new String(known),'',known+' ',known.toUpperCase(),'re_test_not_in_the_literal_inventory','re_opaque_unrecognized_probe'])assert.equal(syntheticResendCredential(value),null);
 assert.equal(reads,0);assert.equal(syntheticResendCredential(known),known);
 for(const options of [Object.create({credential:known}),Object.assign(Object.create({usageCredential:unknown}),{credential:known}),{get credential(){reads++;return known;}},{credential:known,get usageCredential(){reads++;return known;}}])assert.throws(()=>prepareResendFallbackFixture(options),/synthetic fixture credential/);
 assert.equal(reads,0);
 assert.throws(()=>prepareResendFallbackFixture({credential:known,usageCredential:unknown}),/synthetic fixture credential/);
});

test('plain and null-prototype explicit options retain their finite synthetic runtime',async()=>{
 const options=Object.assign(Object.create(null),{credential:known,cap:1,fetch:async()=>Response.json({id:'synthetic'})});
 const fixture=prepareResendFallbackFixture(options);await fixture.ready;
 assert.equal((await guardedResendPost(input(known),fixture.runtime)).kind,'response');
 assert.equal(fixture.requests.filter(r=>r.method==='POST').length,1);
});
