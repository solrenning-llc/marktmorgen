/** Bounded Node 24 reproduction for C5/6701875994. This is a narrow source
 * harness, not a full Next.js, semantic TypeScript or production funding run.
 * Real email-sync, route, crypto, platform HTTP and MemoryRedis code; synthetic
 * store/auth/admission/notice boundaries are enumerated below. Only loopback
 * HTTP is used by the permanent test's platform hooks. No provider is reached.
 * Run from the repository: node --max-old-space-size=512 tests/h2-2824-post-write-native.mjs
 * H2_PRODUCT_REF may select the pre-fix product; the assertions stay local.
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
const root=process.cwd(), ref=process.env.H2_PRODUCT_REF;
const sources=new Map();
const boundaries={
 'lib/auth.ts': `export const normaliseEmail=s=>s.trim().toLowerCase();`,
 'lib/store.ts': `export async function setEmailSyncRef(){} export const storeRef=s=>s.email; export async function ensureStatsId(){throw Error('unexpected allocation');}`,
 'lib/catalog.ts': `export const productIds=s=>s.catalog.items.map(p=>p.id);`,
 'lib/site-url.ts': `export const SITE_URL='https://example.test';`,
 'lib/contract-resource-window.ts': `export async function reservePaidResourceWindow(){throw Error('unexpected paid admission');}`,
 'next/server': `export const after=f=>globalThis.h2After.push(f);`,
 'lib/store-request.ts': `export async function guardStoreWrite(){return {ok:true,store:globalThis.h2RouteStore,body:globalThis.h2RouteBody,ref:'synthetic'}} export const text=(s,n)=>typeof s==='string'?s.slice(0,n):'';`,
 'lib/metered-limits.ts': `export async function withinServiceWhy(){return null} export function serviceRefusedJson(){throw Error('unexpected service refusal')}`,
 'lib/account-notice.ts': `export async function noticeCreator(store,change){globalThis.h2Notices.push(change);}`,
};
const productPaths=new Set(['lib/email-sync.ts','app/api/store/email-sync/route.ts','components/email-sync-editor.tsx']);
function source(path){
 if(!sources.has(path))sources.set(path,ref&&productPaths.has(path)
  ?execFileSync('git',['show',`${ref}:${path}`],{cwd:root,encoding:'utf8',timeout:20000,maxBuffer:1048576})
  :readFileSync(resolve(root,path),'utf8'));
 return sources.get(path);
}
let commands=0;
globalThis.h2Count=n=>{commands+=n;if(commands>20000)throw Error('synthetic command ceiling');};
globalThis.h2After=[];globalThis.h2Notices=[];
globalThis.fetch=async()=>{throw Error('external fetch forbidden');};
registerHooks({resolve(s,c,next){
 if(s==='next/server')return {url:'h2:///next/server',shortCircuit:true};
 if(s.startsWith('node:'))return next(s,c);
 let path;if(s==='@/lib/redis')path='tests/redis-stub.ts';
 else if(s.startsWith('@/'))path=s.slice(2);
 else if(s.startsWith('.')&&c.parentURL?.startsWith('h2:///'))path=posix.normalize(posix.join(posix.dirname(c.parentURL.slice(6)),s));
 else return next(s,c);
 if(!posix.extname(path))path+='.ts';
 return {url:'h2:///'+path,shortCircuit:true};
},load(url,c,next){
 if(!url.startsWith('h2:///'))return next(url,c);
 const path=url.slice(6);let text=boundaries[path]??source(path);
 if(path==='tests/redis-stub.ts')text+=`\nconst original=store.pipeline.bind(store);store.pipeline=async cs=>{globalThis.h2Count(cs.length);return original(cs)};`;
 if(path==='tests/email-sync-exact-view.test.ts')text=text.replace('void main();','await main();');
 return {format:'module',source:stripTypeScriptTypes(text,{mode:'transform'}),shortCircuit:true};
}});
await import('h2:///tests/email-sync-exact-view.test.ts');
// Exercise the real POST after the permanent backend assertions. The provider
// boundary is already covered by the real platform HTTP code above; this route
// scenario hooks only safe-fetch's explicit resolver/agent, just as that test.
const {store:redis}=await import('h2:///tests/redis-stub.ts');
const {POST}=await import('h2:///app/api/store/email-sync/route.ts');
const {setPlatformHooksForTests}=await import('h2:///lib/email-platforms.ts');
const http=await import('node:http'),https=await import('node:https'),net=await import('node:net');
const server=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(request.url.startsWith('/v4/forms')?JSON.stringify({forms:[{id:'audience',name:'Audience'}]}):'{}');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
class LocalAgent extends https.Agent{createConnection(){return net.connect(server.address().port,'127.0.0.1');}}
setPlatformHooksForTests({resolve:async()=>[{address:'93.184.216.34',family:4}],agent:new LocalAgent()});
globalThis.h2RouteStore={statsId:'routeexact2824',handle:'routeexact',email:'route@example.test',catalog:{items:[]}};
const cfg='nl:esync:cfg:routeexact2824';
const pipeline=redis.pipeline.bind(redis);
let failViews=false,routeChecks=0,routeFailures=0;
redis.pipeline=async cs=>{
 if(cs.length===3&&cs[0][0]==='GET'&&cs[0][1]===cfg&&cs[2][0]==='LRANGE'){
  if(failViews&&redis.run(['EXISTS',cfg]))return [redis.run(['GET',cfg])];
 }
 return pipeline(cs);
};
const check=(name,got,want)=>{routeChecks++;const ok=JSON.stringify(got)===JSON.stringify(want);console.log(`${ok?'ok':'FAIL'} route: ${name}`,ok?'':JSON.stringify({got,want}));if(!ok)routeFailures++;};
try{
 redis.clear();failViews=true;
 globalThis.h2RouteBody={action:'connect',provider:'kit',key:'kit_synthetic_exact_view_key_123456'};
 const response=await POST({});const body=await response.json();
 check('saved connection returns success',[response.status,body.ok,redis.run(['EXISTS',cfg])],[200,true,1]);
 for(const task of globalThis.h2After)await task();
 check('confirmed connection schedules its security notice',globalThis.h2Notices.map(n=>n.kind),['email-platform-connected']);
 check('the unavailable log remains unknown',body.view?.log,null);
 // Keep cfg but make both view reads unknown during withdrawal.
 globalThis.h2RouteBody={action:'disconnect'};globalThis.h2After=[];globalThis.h2Notices=[];
 const removal=await POST({});check('withdrawal succeeds',removal.status,200);
 for(const task of globalThis.h2After)await task();
 check('unknown previous label still schedules a generic removal notice',globalThis.h2Notices,[{kind:'email-platform-removed',name:'Your email platform'}]);
 check('withdrawal actually removed the sealed configuration',redis.run(['EXISTS',cfg]),0);
 const editor=source('components/email-sync-editor.tsx');
 check('unread sends do not claim a disconnected connection is still available',editor.includes('Your connection and settings are still available'),false);
}finally{
 redis.pipeline=pipeline;setPlatformHooksForTests(undefined);await new Promise(r=>server.close(r));
}
console.log(JSON.stringify({ref:ref??'local',commands,routeChecks,routeFailures,files:sources.size,boundaries:Object.keys(boundaries),semanticTypes:'not run'}));
if(routeFailures)process.exitCode=1;
