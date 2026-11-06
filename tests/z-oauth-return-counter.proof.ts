/** Real callbacks, short counter and one-use consent. Provider/auth/funding stand-ins are explicit. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { finishMetaConnect } from '@/lib/meta-routes';
import { finishConnect } from '@/lib/meet-routes';
import { beginMeta } from './z-oauth-return-meta-world';
import { beginConsent } from './z-oauth-return-meet-world';
import { hostId } from '@/lib/host-claims';
import { fixture,reset,state,SESSION_COOKIE } from './z-oauth-return-world';
const kinds=['meta','google','zoom','host'] as const;
type Kind=typeof kinds[number];
async function request(kind:Kind){
 const args={statsId:fixture.statsId,sid:fixture.sid,sessionCookie:'synthetic-session',email:fixture.email};
 const url=kind==='meta'?await beginMeta({...args,redirect:'https://example.invalid/callback'}):await beginConsent(kind==='zoom'?'zoom':'google',{...args,...(kind==='host'?{host:hostId(fixture.email)}:{})});
 const req=new NextRequest('https://example.invalid/callback?state='+new URL(url).searchParams.get('state')+'&code=synthetic-code',{headers:{cookie:SESSION_COOKIE+'=synthetic-session','x-forwarded-for':'192.0.2.1'}});
 state.commands.length=0;return req;
}
const invoke=(kind:Kind,req:NextRequest)=>kind==='meta'?finishMetaConnect(req):finishConnect(req,kind==='zoom'?'zoom':'google');
for(const kind of kinds){
 for(const mode of ['false-set','null-count','text-count','timeout'])test(kind+' unknown '+mode+' stops before provider helper',async()=>{
  reset();const req=await request(kind);state.counter=mode;await invoke(kind,req);
  assert.equal(state.commands.slice(0,2).length,2);assert.equal(state.commands[0][0],'SET');assert.equal(state.commands[1][0],'INCR');
  assert.equal(state.commands[0][3],'EX');assert.equal(state.commands[0][4],600);
  assert.equal(state.commands.length,3);assert.equal(state.commands[2][0],'GETDEL');
  assert.equal(state.accessCalls,1);assert.equal(state.fundingCalls,1);
  if(mode==='false-set')console.log('EVIDENCE',kind,JSON.stringify({commands:state.commands.length,argumentJsonBytes:Buffer.byteLength(JSON.stringify(state.commands)),providerHelpers:state.providerCalls,syntheticFundingAcknowledgements:state.fundingCalls}));
  assert.equal(state.providerCalls,0,'unknown company counter must not authorize downstream provider work');
 });
 for(const mode of ['empty','partial','exceeded'])test(kind+' counter control '+mode,async()=>{
  reset();const req=await request(kind);state.counter=mode;await invoke(kind,req);
  assert.equal(state.providerCalls,0);assert.equal(state.commands.length,2);
 });
 for(const gate of ['configuration','session','state','access','pause','funding'])test(kind+' independent gate '+gate,async()=>{
  reset();const req=await request(kind);state.counter='null-count';
  if(gate==='configuration')state.configured=false;
  if(gate==='session')state.session=false;
  if(gate==='state')req.nextUrl.searchParams.set('state','invalid');
  if(gate==='access')state.access=false;
  if(gate==='pause')state.paused='paused_unpaid';
  if(gate==='funding')state.funding=false;
  await invoke(kind,req);assert.equal(state.providerCalls,0);
 });
 test(kind+' confirmed counter and one-use state control',async()=>{
  reset();const req=await request(kind);const response=await invoke(kind,req);
  assert.equal(response.status,303);assert.equal(state.providerCalls,1);assert.equal(state.fundingCalls,1);
  assert.equal(state.commands.length,3);assert.equal(state.commands[2][0],'GETDEL');
  await invoke(kind,req);assert.equal(state.providerCalls,1,'healthy replay cannot reuse the consumed consent');
 });
}
