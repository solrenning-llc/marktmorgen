import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {finishConnect} from '@/lib/meet-routes';
import {beginConsent} from '@/tests/meet-return-provider-world';
import {fixture,reset,state,SESSION_COOKIE} from '@/tests/meet-return-counter-world';
import {hostId} from '@/lib/host-claims';
let callbacks=0;
for(const kind of ['google','zoom','host'] as const)for(const mode of ['exceeded','null-count'] as const)test(kind+' refusal preserves a usable connection context: '+mode,async()=>{
 assert.ok(++callbacks<=6,'six-callback admission before dispatch');reset();
 const provider=kind==='zoom'?'zoom':'google';
 const start=await beginConsent(provider,{statsId:fixture.statsId,sid:fixture.sid,sessionCookie:'synthetic-session',email:fixture.email,...(kind==='host'?{host:hostId(fixture.email)}:{})});
 state.commands.length=0;state.counter=mode;
 const req=new NextRequest('https://example.invalid/callback?state='+new URL(start).searchParams.get('state')+'&code=synthetic-code',{headers:{cookie:SESSION_COOKIE+'=synthetic-session','x-forwarded-for':'192.0.2.1'}});
 const response=await finishConnect(req,provider);
 assert.deepEqual(state.commands.map(c=>c[0]),['SET','INCR']);assert.equal(state.accessCalls,0);assert.equal(state.fundingCalls,0);assert.equal(state.providerCalls,0);
 if(kind==='zoom'){
  assert.equal(response.status,303);const target=new URL(response.headers.get('Location')!);assert.equal(target.pathname,'/studio/meetings');assert.equal(target.searchParams.get('meet'),mode==='exceeded'?'limited':'error');assert.equal(target.searchParams.get('p'),'zoom');
 }else{
  assert.equal(response.status,mode==='exceeded'?429:503);assert.equal(response.headers.get('Location'),null);assert.match(response.headers.get('Content-Type')??'',/^text\/html/);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  const body=await response.text();assert.ok(Buffer.byteLength(body,'utf8')<=2048,'fixed response-byte envelope');assert.match(body,/<html lang="en"/);assert.match(body,/<h1[^>]*>Google Calendar connection not completed/);assert.match(body,/href="\/studio\/meetings"[^>]*>Back to Video calls/);assert.match(body,/href="\/studio\/calendar"[^>]*>Back to Your calendar/);assert.doesNotMatch(body,/for=host|synthetic-code|synthetic-session/);
 }
});
