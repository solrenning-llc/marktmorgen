import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {finishConnect} from '@/lib/meet-routes';
import {reset,state,SESSION_COOKIE} from './meet-return-counter-world';
const vectors:[string,()=>unknown,boolean][]=[
 ['missing',()=>[],false],['partial',()=>['OK'],false],['extra',()=>['OK',1,1],false],
 ['negative',()=>['OK',-1],false],['zero',()=>['OK',0],false],['fraction',()=>['OK',1.2],false],
 ['text',()=>['OK','1'],false],['null',()=>['OK',null],false],['bad SET',()=>[false,1],false],
 ['getter',()=>Object.defineProperty(['OK',1],'1',{get(){throw Error('synthetic getter')}}),false],
 ['exceeded',()=>['OK',31],true],['unsafe',()=>['OK',Number.MAX_SAFE_INTEGER+1],false],
];
for(const provider of ['google','zoom'] as const)for(const [name,maker,limited] of vectors)test(provider+' unknown guard '+name,async()=>{
 reset();state.counter='cx1-custom';(globalThis as any).__cx1CounterReply=maker();
 const privatePart='cx1-private-'.repeat(400);
 const req=new NextRequest('https://example.invalid/callback?state='+privatePart+'&code='+privatePart,{headers:{cookie:SESSION_COOKIE+'=cx1-private-cookie','x-forwarded-for':'192.0.2.1'}});
 const response=await finishConnect(req,provider);const body=await response.text();
 assert.deepEqual(state.commands.map(x=>x[0]),['SET','INCR']);
 assert.equal(state.providerCalls,0);assert.equal(state.accessCalls,0);assert.equal(state.fundingCalls,0);
 assert.equal(state.commands[0][4],600);
 assert.ok(!body.includes('cx1-private'));assert.ok(Buffer.byteLength(body,'utf8')<=2048);
 if(provider==='google'){
  assert.equal(response.status,limited?429:503);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.match(response.headers.get('Content-Security-Policy')??'',/default-src 'none'/);
  assert.match(body,/href="\/studio\/meetings"/);assert.match(body,/href="\/studio\/calendar"/);
 }else{
  assert.equal(response.status,303);const to=new URL(response.headers.get('Location')!);assert.equal(to.pathname,'/studio/meetings');assert.equal(to.searchParams.get('meet'),limited?'limited':'error');
 }
});
