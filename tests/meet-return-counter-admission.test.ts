/** Real callbacks, short counter and one-use consent. Provider/auth/funding stand-ins are explicit. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import { NextRequest } from 'next/server';
import { finishConnect } from '@/lib/meet-routes';
import { beginConsent } from './meet-return-provider-world';
import { hostId } from '@/lib/host-claims';
import { can } from '@/lib/team-roles';
import { fixture,reset,state,SESSION_COOKIE } from './meet-return-counter-world';
const kinds=['google','zoom','host'] as const;
type Kind=typeof kinds[number];
async function request(kind:Kind){
 const args={statsId:fixture.statsId,sid:fixture.sid,sessionCookie:'synthetic-session',email:fixture.email};
 const url=await beginConsent(kind==='zoom'?'zoom':'google',{...args,...(kind==='host'?{host:hostId(fixture.email)}:{})});
 const req=new NextRequest('https://example.invalid/callback?state='+new URL(url).searchParams.get('state')+'&code=synthetic-code',{headers:{cookie:SESSION_COOKIE+'=synthetic-session','x-forwarded-for':'192.0.2.1'}});
 state.commands.length=0;return req;
}
const invoke=(kind:Kind,req:NextRequest)=>finishConnect(req,kind==='zoom'?'zoom':'google');
// C5 6701844921: a refused return must not guess Google store/host intent.
async function assertCounterRefusal(response:Response,kind:Kind,limited:boolean){
 if(kind==='zoom'){
  assert.equal(response.status,303);const target=new URL(response.headers.get('Location')!);
  assert.equal(target.pathname,'/studio/meetings');assert.equal(target.searchParams.get('meet'),limited?'limited':'error');assert.equal(target.searchParams.get('p'),'zoom');assert.equal(await response.text(),'');
 }else{
  assert.equal(response.status,limited?429:503);assert.equal(response.headers.get('Location'),null);
  assert.match(response.headers.get('Content-Type')??'',/^text\/html/);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  const body=await response.text();assert.ok(Buffer.byteLength(body,'utf8')<=2048,'fixed response-byte envelope');assert.match(body,/<html lang="en"/);assert.match(body,/<h1[^>]*>Google Calendar connection not completed/);
  assert.match(body,/href="\/studio\/meetings"[^>]*>Back to Video calls/);assert.match(body,/href="\/studio\/calendar"[^>]*>Back to Your calendar/);
  assert.match(body,limited?/too many attempts/:/could not complete/);assert.doesNotMatch(body,/for=host|synthetic-code|synthetic-session/);
 }
}

for(const kind of kinds){
 for(const mode of ['false-set','null-count','text-count','timeout'])test(kind+' unknown '+mode+' stops before provider helper',async()=>{
  reset();const req=await request(kind);state.counter=mode;const response=await invoke(kind,req);
  assert.equal(state.commands.slice(0,2).length,2);assert.equal(state.commands[0][0],'SET');assert.equal(state.commands[1][0],'INCR');
  assert.equal(state.commands[0][3],'EX');assert.equal(state.commands[0][4],600);
  assert.equal(state.providerCalls,0,'unknown company counter must not authorize downstream provider work');
  await assertCounterRefusal(response,kind,false);
  assert.equal(state.commands.length,2);
  assert.equal(state.accessCalls,0);assert.equal(state.fundingCalls,0);
 });
 for(const mode of ['empty','partial','exceeded'])test(kind+' counter control '+mode,async()=>{
  reset();const req=await request(kind);state.counter=mode;const response=await invoke(kind,req);
  assert.equal(state.providerCalls,0);assert.equal(state.commands.length,2);
  await assertCounterRefusal(response,kind,mode==='exceeded');
 });
 for(const gate of ['configuration','session','state','access','pause','funding'])test(kind+' independent gate '+gate,async()=>{
  reset();const req=await request(kind);state.counter='normal';
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

// Existing notice source only; not a browser or SSR claim.
test('callback notices exist on the actual meetings page',()=>{const page=readFileSync(join(process.cwd(),'app/studio/meetings/page.tsx'),'utf8');assert.ok(page.includes('query.meet'));assert.ok(page.includes('Something went wrong on our side. Nothing was changed; try again in a moment.'));assert.ok(page.includes('That is too many attempts in a few minutes. Wait a moment and try again.'));});

// Claude 4's #2819 review: a host may be an editor/support member without settings access.
for (const mode of ['exceeded', 'null-count']) test('a refused host callback has a readable member notice: '+mode, async()=>{
 reset();const req=await request('host');state.counter=mode;
 await assertCounterRefusal(await invoke('host',req),'host',mode==='exceeded');
 const page=readFileSync(join(process.cwd(),'app/studio/calendar/page.tsx'),'utf8');
 for(const role of ['editor','support'] as const)assert.equal(can(role,'settings'),false);
 assert.ok(page.includes('studioView(jar, typeof query.store === "string" ? query.store : undefined, "member")'),'the destination must admit any host-eligible member');
 assert.equal(state.providerCalls,0);assert.equal(state.accessCalls,0);assert.equal(state.fundingCalls,0);
 assert.equal(state.commands.length,2,'no consent read or extra paid work on a refusal');
});
test('the member calendar has both retryable notices',()=>{
 const page=readFileSync(join(process.cwd(),'app/studio/calendar/page.tsx'),'utf8');
 assert.ok(page.includes('query.cal'));
 assert.ok(page.includes('Something went wrong on our side. Nothing was changed; try again in a moment.'));
 assert.ok(page.includes('That is too many attempts in a few minutes. Wait a moment and try again.'));
});
