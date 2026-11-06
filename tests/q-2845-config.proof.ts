/** Independent Q review of exact frozen #2845. All fixtures are synthetic. */
import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerEventsEditor } from '@/components/server-events-editor';
import { NextRequest } from 'next/server';
import { serverSetup, setTestCode, setServerToken, sendServerPurchase, customerType } from '@/lib/ad-events';
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { SESSION_COOKIE, openSession } from '@/lib/auth';
import { POST } from '@/app/api/store/ads-server/route';
import { NO_PIXELS } from '@/lib/pixels';
import { paidPeriod } from './billing-period-fixture';
import { store as redis } from './redis-stub';
process.env.NIMBUS_DATA_KEY='synthetic-q-2845-local-key-0123456789abcdef';
process.env.STRIPE_SECRET_KEY='sk_test_q2845';
let listed: unknown={data:[]};
let external=0;
globalThis.fetch=(async ()=>{ external++; return new Response(JSON.stringify(listed),{status:200}); }) as typeof fetch;
const original=redis.pipeline.bind(redis);
let cfg='';
let inject: ((commands:(string|number)[][], replies:unknown[])=>unknown[])|null=null;
const writes: (string|number)[][]=[];
redis.pipeline=(async (commands:(string|number)[][])=>{
  writes.push(...commands.filter(c=>c[0]==='SET' && c[1]===cfg));
  const r=await original(commands);
  return inject ? inject(commands,r) : r;
}) as typeof redis.pipeline;
async function main(){
 redis.clear();
 const owner='q2845@example.test';
 await claimHandle(owner,'q2845','Q config','');
 const id=(await ensureStatsId(owner))!.statsId!;
 cfg=`nl:adsrv:${id}`;
 await setStripeAccount(owner,'acct_1Q2845Test00001',true);
 await setSubscription(owner,{customerId:'cus_q2845',subscriptionId:'sub_q2845',active:true,tier:'creator',period:paidPeriod()});
 await setPixels(owner,{...NO_PIXELS,meta:'123456789012345'});
 await setAdsServer(owner,['meta','tiktok','google','pinterest']);
 for(const platform of ['meta','tiktok','google','pinterest'] as const) await setServerToken(id,platform,'Synthetictoken_'+platform+'x'.repeat(50),{account:'549755885175'});
 await setTestCode(id,'TEST111');
 const before=(await original([['GET',cfg]]))[0];
 let checked=0;
 const vectors:[string,(r:unknown[])=>unknown[]][]=[
 ['extra reply',r=>[...r,null]],
 ['sparse replies',r=>new Array(r.length)],
 ['undefined slot',r=>[undefined,...r.slice(1)]],
 ['JSON boolean',r=>['false',...r.slice(1)]],
 ['JSON array',r=>['[]',...r.slice(1)]],
 ['nested field',r=>['{"meta":{}}',...r.slice(1)]],
 ['null field',r=>['{"meta":null}',...r.slice(1)]],
 ['raw object',r=>[{},...r.slice(1)]],
 ['raw null-like text',r=>['null',...r.slice(1)]],
 ];
 for(const [label,mutate] of vectors){
   inject=(cmd,r)=>cmd.some(c=>c[0]==='GET' && c[1]===cfg)?mutate(r):r;
   writes.length=0;
   await assert.rejects(()=>setTestCode(id,'TEST222'),{name:'UnknownReplyError'},label);
   await assert.rejects(()=>setServerToken(id,'meta',''),{name:'UnknownReplyError'},label);
   await assert.rejects(()=>serverSetup(id),{name:'UnknownReplyError'},label);
   assert.equal(writes.length,0,label);
   assert.equal((await original([['GET',cfg]]))[0],before,label);
   checked+=5;
 }
 inject=null;
 await setTestCode(id,'TEST333');
 const after=JSON.parse(String((await original([['GET',cfg]]))[0]));
 const prior=JSON.parse(String(before));
 for(const k of ['meta','tiktok','google','pinterest','pinterestAccount']) assert.equal(after[k],prior[k]);
 checked+=5;
 const store=(await storeForEmail(owner))!;
 inject=(cmd,r)=>cmd.some(c=>c[0]==='GET' && c[1]===cfg)?['{broken',...r.slice(1)]:r;
 writes.length=0; external=0;
 await assert.rejects(()=>sendServerPurchase(store,'cs_test_q28450000000001',{ip:'',userAgent:'',url:'',cookies:{}}),{name:'UnknownReplyError'});
 assert.equal(external,0); assert.equal(writes.length,0); checked+=3;
 inject=null;
 for(const body of [null,{}, {data:null},{data:42},{data:'[]'}]){listed=body; assert.equal(await customerType(store,'buyer@example.test','cs_test_q28450000000001',2000000000),null); checked++;}
 const session=await openSession(owner);
 const post=async(body:unknown)=>POST(new NextRequest('https://marktmorgen.com/api/store/ads-server',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify(body)}));
 // Conditional transport anomaly: first GET is healthy; only final two-command refresh is unknown.
 inject=(cmd,r)=>cmd.length===2 && cmd[0][1]===cfg?[]:r;
 writes.length=0;
 const response=await post({platform:'meta',token:''});
 inject=null;
 const observed=JSON.parse(String((await original([['GET',cfg]]))[0]));
 assert.equal(response.status,503);
 assert.equal(writes.length,1);
 assert.equal(Object.hasOwn(observed,'meta'),false);
 assert.equal(observed.tiktok,prior.tiktok);
 const firstList=(await storeForEmail(owner))!.adsServer;
 const retry=await post({platform:'meta',token:''});
 assert.equal(retry.status,200);
 assert.deepEqual((await storeForEmail(owner))!.adsServer,['tiktok','google','pinterest']);
 console.log('OBSERVATION retry: HTTP200; store list converged without removing other tokens.');
 console.log('OBSERVATION final refresh unknown: HTTP 503; config SET=1; Meta removed; foreign tokens preserved; store list='+JSON.stringify(firstList));
 // Partial last-answer JSON currently passes the new exact-object check.
 for(const last of ['{}','{"at":"not-a-date","meta":{"bad":true}}']){
   inject=(cmd,r)=>cmd.length===2 && cmd[0][1]===cfg?[r[0],last]:r;
   const setup=await serverSetup(id);
   assert.deepEqual(setup.last,JSON.parse(last));
   const html=renderToStaticMarkup(createElement(ServerEventsEditor,{setup,pixels:{meta:true,tiktok:false,google:false,pinterest:false},googleId:''}));
   assert.ok(html.includes('Invalid Date'));
   console.log('OBSERVATION malformed last renders: '+html.match(/Last [^<]+/));
 }
 inject=(cmd,r)=>cmd.length===2 && cmd[0][1]===cfg?[r[0],'{"at":{"toString":null,"valueOf":null},"meta":"Received"}']:r;
 const poisonous=await serverSetup(id);
 assert.throws(()=>renderToStaticMarkup(createElement(ServerEventsEditor,{setup:poisonous,pixels:{meta:true,tiktok:false,google:false,pinterest:false},googleId:''})),TypeError);
 console.log('OBSERVATION malformed last.at object: real ServerEventsEditor static render throws TypeError.');
 inject=null;
 console.log(`PASS ${checked} independent invariant checks; plus 6 post-write/retry assertions and 5 malformed-last assertions (real component static render).`);
}
main().catch(e=>{console.error(e);process.exitCode=1});
