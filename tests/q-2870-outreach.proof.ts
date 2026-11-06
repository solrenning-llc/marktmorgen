/** Q supplemental #2870 proof. J owns the separate stopFromLink finding. */
import { strict as assert } from 'node:assert';
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from '@/lib/store';
import { listPitches, saveSender, startPitch, type PageReader } from '@/lib/outreach';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
const NOW=Math.floor(Date.now()/1000);
let pages=0, models=0;
globalThis.fetch=(async()=>{ models++; return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({subject:'A synthetic idea',body:'Hello, I make short cooking videos. Would a sponsored recipe video be of interest?'})}]}),{status:200}); }) as typeof fetch;
process.env.ANTHROPIC_API_KEY='sk-ant-api03-synthetic-q2870';
const real=redis.pipeline.bind(redis);
let inject:((r:unknown[])=>unknown[])|null=null;
let mutations=0;
redis.pipeline=(async(commands:(string|number)[][])=>{
 mutations+=commands.filter(c=>['SET','HSET','HDEL','SADD','INCR','EVAL'].includes(String(c[0]))).length;
 const r=await real(commands);
 return commands[0]?.[0]==='HGETALL' && inject?inject(r):r;
}) as typeof redis.pipeline;
const input={goal:'sponsor' as const,country:'US',isCompany:true,page:'https://brand.example.com/contact',email:'partnerships@brand.example.com',company:'Synthetic Brand',about:'Synthetic tools',notes:'I make short cooking videos and would feature tools in a sponsored recipe.'};
const reader:PageReader=async(url)=>{pages++;return new URL(url).pathname==='/robots.txt'?null:{url,html:'<p>For sponsorships: partnerships@brand.example.com</p>'};};
async function fixture(i:number){
 const email=`q2870-${i}@example.test`;
 await claimHandle(email,`q2870-${i}`,`Q ${i}`,'');await ensureStatsId(email);
 await setSubscription(email,{customerId:'cus_Q2870Test0001',subscriptionId:'sub_Q2870Test0001',active:true,tier:'pro',trialEnds:0,period:paidPeriod(Date.now(),{behind:30,ahead:300})});
 const store=(await storeForEmail(email))!;
 await saveSender(store,{name:'Q synthetic',address:'PO Box 100, Example City, US'});
 return store;
}
async function main(){
 redis.clear();const store=await fixture(0);const key=`nl:outreach:${store.statsId}:pitches`;
 const valid={id:'0000000000000001',domain:'brand.example.com',to:'partnerships@brand.example.com',status:'sent',createdAt:NOW-3*86400,sentAt:NOW-3*86400};
 await real([['HSET',key,valid.id,JSON.stringify(valid)]]);
 let n=0;
 const vectors:[string,(r:unknown[])=>unknown[]][]=[
 ['extra pipeline reply',r=>[...r,null]],['sparse pipeline',()=>new Array(1)],['undefined slot',()=>[undefined]],
 ['object hash',()=>[{[valid.id]:JSON.stringify(valid)}]],['boolean hash',()=>[false]],
 ['sparse hash',()=>[new Array(2)]],['non-string field',()=>[[7,JSON.stringify(valid)]]],
 ['good plus invalid pitch',()=>[[valid.id,JSON.stringify(valid),'0000000000000002','{}']]],
 ['good plus JSON null',()=>[[valid.id,JSON.stringify(valid),'0000000000000002','null']]],
 ];
 for(const [label,f] of vectors){inject=f;pages=models=mutations=0;
   await assert.rejects(()=>listPitches(store),{name:'UnknownReplyError'},label);
   assert.deepEqual(await startPitch(store,input,{reader,now:NOW}),{ok:false,reason:'unavailable'},label);
   assert.deepEqual([pages,models,mutations],[0,0,0],label);n+=3;
 }
 inject=null;
 assert.equal((await listPitches(store))[0].status,'sent');
 assert.deepEqual(await startPitch(store,input,{reader,now:NOW}),{ok:false,reason:'recent'});n+=2;
 // Conditional inherited parsePitch boundary: ordinary HGETALL shape, invalid saved timestamps.
 const partialStore=await fixture(1);const partialKey=`nl:outreach:${partialStore.statsId}:pitches`;
 await real([['HSET',partialKey,valid.id,JSON.stringify({...valid,createdAt:null,sentAt:null})]]);
 const parsed=await listPitches(partialStore);assert.deepEqual([parsed[0].createdAt,parsed[0].sentAt],[0,0]);
 pages=models=0;const result=await startPitch(partialStore,input,{reader,now:NOW});
 assert.equal(result.ok,true);assert.equal(models,1);n+=3;
 console.log('OBSERVATION inherited timestamp coercion: null timestamps accepted as zero; next real draft created; synthetic model delta1. No normal writer producing these bytes established.');
 console.log(`PASS ${n} independent assertions. J stop-link proof is separate and credited to its original author.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
