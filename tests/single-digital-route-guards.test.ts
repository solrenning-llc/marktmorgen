/** Actual HTTP handlers and their shared runtime-injected paid branch. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {NextRequest} from 'next/server';
import {GET,POST,paidDownloadGet,paidDownloadRenewalPost} from '@/app/api/store/download/route';
import {renewalFixture,request,tokenKeys} from './single-digital-access-renewal-world';
import {store as redis} from './redis-stub';

test('production POST with no actual review refuses before a body read, provider call or source write',async()=>{
 const f=await renewalFixture(),keys=[...redis.keys()].sort();
 const req=request(f.url,new URLSearchParams({handle:f.store.handle,origin:f.url.searchParams.get('origin')!,request:'a'.repeat(64)}));
 Object.defineProperty(req,'body',{get(){throw Error('Unknown funding must not read a body');}});
 assert.equal((await POST(req)).status,503);assert.deepEqual([...redis.keys()].sort(),keys);assert.equal(f.gets.length,0);assert.equal(tokenKeys().length,0);
});
test('presence of a corrupted or empty original capsule never downgrades to the recent purchase scan',async()=>{
 const f=await renewalFixture();
 for(const value of ['',f.url.searchParams.get('origin')!+'corrupt']){
  const url=new URL(f.url);url.searchParams.set('origin',value);
  assert.equal((await GET({nextUrl:url,headers:new Headers()} as NextRequest)).status,410);
 }
 assert.equal(f.gets.some(url=>new URL(url).pathname.endsWith('/checkout/sessions')),false);assert.equal(tokenKeys().length,0);
});
test('duplicate and extra renewal fields refuse before current payment checks or queue creation',async()=>{
 const f=await renewalFixture();
 for(const name of ['handle','email']){
  const fields=new URLSearchParams({handle:f.store.handle,origin:f.url.searchParams.get('origin')!,request:'a'.repeat(64)});fields.append(name,'another');
  assert.equal((await paidDownloadRenewalPost(request(f.url,fields),f.runtime)).status,400);
 }
 assert.equal(f.gets.length,0);assert.equal([...redis.keys()].some(k=>k.startsWith('nl:order-confirmation:row:')),false);assert.equal(tokenKeys().length,0);
});
test('the body ceiling counts received bytes even when Content-Length claims one byte',async()=>{
 const f=await renewalFixture(),fields=new URLSearchParams({handle:f.store.handle,origin:'x'.repeat(17000),request:'a'.repeat(64)}),req=request(f.url,fields);
 req.headers.set('content-length','1');assert.equal((await paidDownloadRenewalPost(req,f.runtime)).status,400);
 assert.equal(f.gets.length,0);assert.equal(tokenKeys().length,0);
});
test('renewal forms are private, nonindexable and send no address to the browser',async()=>{
 const f=await renewalFixture(),response=await paidDownloadGet({nextUrl:f.url,headers:new Headers()} as NextRequest,f.runtime),html=await response.text();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 assert.equal(response.headers.get('x-robots-tag'),'noindex');assert.ok(response.headers.get('content-security-policy')?.includes("form-action 'self'"));
 assert.ok(html.includes('<h1>'));assert.ok(html.includes('<button type="submit">'));assert.equal(html.includes(f.email),false);assert.equal(tokenKeys().length,0);
});
