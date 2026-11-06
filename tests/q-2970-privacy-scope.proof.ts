/** Q #2970: real page + store reader + Redis REST decoder, synthetic transport only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {isValidElement,type ReactNode} from 'react';
import DeletePage from '@/app/privacy/delete/page';
import {claimHandle} from '@/lib/store';
import {MemoryRedis} from '@/lib/redis-memory';
const memory=new MemoryRedis();
process.env.UPSTASH_REDIS_REST_URL='https://q2970.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN='synthetic-only';
type Mode='healthy'|'handle-throw'|'owner-throw'|'handle-empty'|'owner-empty'|'handle-missing-result'|'absent'|'recovery';
let mode:Mode='healthy',commands=0,totalCommands=0,writes=0,inject=false;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 assert.equal(url.href,'https://q2970.invalid/pipeline','every call terminates at the synthetic Redis transport');
 const batch=JSON.parse(String(init?.body)) as (string|number)[][];
 commands+=batch.length;totalCommands+=batch.length;
 assert.ok(commands<=2000,'announced per-scenario 2000-command ceiling');
 assert.ok(totalCommands<=16000,'announced total 16000-command ceiling');
 const target=batch.some(c=>c[0]==='GET'&&String(c[1]).startsWith(mode.startsWith('owner-')?'nl:store:owner:':'nl:store:handle:'));
 if(inject&&target){
  if(mode==='handle-throw'||mode==='owner-throw'||mode==='recovery')throw Error('Synthetic connection reset');
  if(mode==='handle-empty'||mode==='owner-empty')return Response.json([]);
  if(mode==='handle-missing-result')return Response.json([{}]);
 }
 for(const c of batch)if(!['GET','GETRANGE','TTL','EXISTS'].includes(String(c[0])))writes++;
 return Response.json((await memory.pipeline(batch)).map(result=>({result})));
}) as typeof fetch;
function inspect(node:ReactNode,out={text:'',allHidden:0,storeDefault:0,statuses:0,confirms:0}):typeof out{
 if(Array.isArray(node)){for(const child of node)inspect(child,out);return out;}
 if(typeof node==='string'||typeof node==='number'){out.text+=String(node);return out;}
 if(!isValidElement<{children?:ReactNode;name?:string;value?:string;type?:string;defaultChecked?:boolean;role?:string}>(node))return out;
 if(node.props.role==='status')out.statuses++;
 if(node.type==='input'&&node.props.name==='scope'){
  if(node.props.value==='all'&&node.props.type==='hidden')out.allHidden++;
  if(node.props.value==='store'&&node.props.defaultChecked)out.storeDefault++;
 }
 if(node.type==='input'&&node.props.name==='action'&&node.props.value==='confirm')out.confirms++;
 inspect(node.props.children,out);return out;
}
async function scenario(kind:Mode){
 mode=kind;commands=0;writes=0;inject=false;memory.clear();
 assert.equal((await claimHandle('owner@example.test','scopeproof','Scope Proof','')).ok,true);
 const beforeWrites=writes;inject=kind!=='healthy'&&kind!=='absent';
 const show=async()=>inspect(await DeletePage({searchParams:Promise.resolve({store:kind==='absent'?'notthere':'scopeproof'})}));
 const first=await show();
 inject=false;
 const recovered=kind==='recovery'?await show():null;
 const observed={kind,notice:first.text.includes('could not be read just now'),loop:first.text.includes('use the link at the foot of that store'),allHidden:first.allHidden,storeDefault:first.storeDefault,statuses:first.statuses,confirms:first.confirms,pageWrites:writes-beforeWrites,commands,recoveredStoreDefault:recovered?.storeDefault??null};
 assert.equal(observed.pageWrites,0,'the GET page performs no erasure or other database write');
 assert.equal(observed.confirms,0,'an ask page is not an erasure confirmation');
 console.log('Q2970_OBSERVATION '+JSON.stringify(observed));
 return observed;
}
const cases:Mode[]=['healthy','handle-throw','owner-throw','handle-empty','owner-empty','handle-missing-result','absent','recovery'];
assert.ok(cases.length<=8,'announced maximum of eight new scenarios');
for(const kind of cases)test('privacy request scope: '+kind,async()=>{
 const r=await scenario(kind);
 if(kind==='healthy'){assert.equal(r.storeDefault,1);assert.equal(r.allHidden,0);assert.equal(r.notice,false);return;}
 if(kind==='absent'){assert.equal(r.notice,false);assert.equal(r.allHidden,1);assert.equal(r.loop,true);return;}
 assert.equal(r.notice,true,'an unread store must be described as unread, rather than silently offer every store');
 assert.equal(r.loop,false,'do not direct a person back to the link they just used');
 if(kind==='recovery')assert.equal(r.recoveredStoreDefault,1,'the same store URL recovers its scoped default');
});
