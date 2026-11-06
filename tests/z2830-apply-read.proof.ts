/** Real route/session/allowance/MemoryRedis; no response substitution or supplier IO. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NextRequest} from 'next/server';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,setSitePages,storeForEmail} from '@/lib/store';
import {parsePage,emptyBlock} from '@/lib/sales-page';
import {blocksForPage,type SavedSection} from '@/lib/saved-blocks';
import {writePage} from '@/lib/sales-page-store';
import {siteKey} from '@/lib/site-page-rules';
import {shareLimitsFor,monthOfUse} from '@/lib/funnel-share-rules';
import {countUse,storeMonthKey,MONTH_USE_SECONDS} from '@/lib/funnel-share-store';
import {POST} from '@/app/api/store/saved-blocks/route';
import {store as redis} from './redis-stub';

test('an exhausted apply reads no bytes beyond its confirmed studio allowance',async()=>{
 redis.clear();const owner='apply-proof@example.invalid';
 await claimHandle(owner,'applyreadproof','Fictional pages','');await ensureStatsId(owner);
 const session=await openSession(owner);
 const request=(body:unknown)=>new NextRequest('https://marktmorgen.com/api/store/saved-blocks',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify(body)});
 const saved=await POST(request({action:'save',name:'Fictional section',blocks:[{...emptyBlock('text'),heading:'Section',body:'A saved section.'}]}));
 assert.equal(saved.status,200);const {section}=await saved.json() as {section:SavedSection};
 const ids=['aaaaaaaaaa','bbbbbbbbbb'];
 assert.equal((await setSitePages(owner,ids.map((id,i)=>({id,slug:`page-${i}`,title:`Page ${i}`,nav:false,target:'',from:0})))).ok,true);
 const store=(await storeForEmail(owner))!;assert.ok(store.statsId);
 const keys=ids.map(siteKey);
 const page=parsePage({blocks:[...blocksForPage(section),...Array.from({length:20},(_,i)=>({...emptyBlock('text'),id:`text${String(i).padStart(4,'0')}`,heading:'Synthetic text',body:'x'.repeat(3000)}))]});
 assert.equal(page.blocks.length,21);
 for(const key of keys)await writePage(store.statsId,key,page,store);
 const month=monthOfUse(store);assert.ok(month);const applyKey=storeMonthKey(store.statsId,'apply',month);
 const limit=shareLimitsFor(store).appliesPerMonth;
 const healthy=await POST(request({action:'apply',id:section.id,pages:keys}));
 assert.equal(healthy.status,200,'the same large valid pages and section apply successfully while a monthly use remains');
 assert.equal(Number((await redis.pipeline([['GET',applyKey]]))[0]),1);
 // Exhaust the actual monthly counter through its real helper, not a fake ACK.
 for(let i=1;i<limit;i++)assert.equal(await countUse(applyKey,limit,MONTH_USE_SECONDS),true);
 const real=redis.pipeline.bind(redis);
 assert.equal(Number((await real([['GET',applyKey]]))[0]),limit);
 let pageBytes=0,pageGets=0,commands=0,studioUnits=0;
 const studioKeys=new Set<string>();
 const studioBefore=new Map<string,number>();
 redis.pipeline=(async(batch:(string|number)[][])=>{
  const reply=await real(batch);commands+=batch.length;
  batch.forEach((command,i)=>{
   if(command[0]==='GET'&&String(command[1]).startsWith(`nl:product:page:${store.statsId}:`)){
    assert.equal(typeof reply[i],'string');pageBytes+=Buffer.byteLength(reply[i] as string,'utf8');pageGets++;
   }
   if((command[0]==='INCRBY'||command[0]==='DECRBY')&&String(command[1]).startsWith('nl:allow:studio:')){
    studioUnits+=(command[0]==='INCRBY'?1:-1)*Number(command[2]);studioKeys.add(String(command[1]));
    if(command[0]==='INCRBY'){
     assert.equal(typeof reply[i],'number');
     if(!studioBefore.has(String(command[1])))studioBefore.set(String(command[1]),Number(reply[i])-Number(command[2]));
    }
   }
  });return reply;
 }) as typeof redis.pipeline;
 let response:Response;
 try{response=await POST(request({action:'apply',id:section.id,pages:keys}));}finally{redis.pipeline=real;}
 const body=await response.json() as {error?:string};
 assert.deepEqual([response.status,body.error],[429,'applies_full']);
 const monthAfter=Number((await real([['GET',applyKey]]))[0]);
 assert.equal(monthAfter,limit+1,'the refused attempt increments past the monthly ceiling; it is not an admitted apply');
 assert.equal(studioUnits,1);assert.equal(studioKeys.size,1);
 const [studioKey]=studioKeys;const chargedBefore=studioBefore.get(studioKey)!;
 const chargedAfter=Number((await real([['GET',studioKey]]))[0]);
 assert.equal(chargedAfter-chargedBefore,1,'the actual studio counter, not just INCRBY logs, confirms one paid unit');
 assert.match(readFileSync('tests/plan-cost-registry.ts','utf8'),/studio: request\("studio", [^\n]+, 50_000\)/);
 console.log('EVIDENCE',JSON.stringify({commands,pageGets,pageBytes,confirmedStudioUnits:studioUnits,studioCounterBefore:chargedBefore,studioCounterAfter:chargedAfter,studioBytesPriced:50000*studioUnits,monthlyApplyLimit:limit,monthlyApplyAfter:monthAfter,additionalAdmittedApplies:0,response:[response.status,body.error]}));
 assert.ok(pageBytes<=50000*studioUnits,'month-full refusal must not read more page bytes than its paid studio unit covers');
});
