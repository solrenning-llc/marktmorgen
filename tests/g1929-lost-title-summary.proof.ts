/** MemoryRedis lacks the generic fence EVAL: applied-owner injection targets its actual owner SET fallback, not a claimed native Lua run. */
/** G independent real-writer restore acknowledgement schedules; synthetic Redis only. */
import {addProduct,claimHandle,ensureStatsId,setSubscription,storeForEmail} from '@/lib/store';
import {readListing} from '@/lib/catalog';
import {proposeTitle,proposeSummary} from '@/lib/agent-propose';
import {confirmFor,undoFor} from '@/lib/agent-confirm';
import {readBook} from '@/lib/agent-book';
import {AGENT_KINDS} from '@/lib/agent-kinds';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
import {is,done} from './check';
globalThis.fetch=(async()=>{throw Error('No external request in G proof');}) as typeof fetch;
async function main(){const base=redis.pipeline.bind(redis);let serial=0;
 for(const field of ['title','summary'] as const)for(const mode of ['normal','before-product-batch','applied-owner-acklost']){
  redis.clear();serial++;const owner=`glost${serial}@example.test`;await claimHandle(owner,`glost${serial}`,'G fixture','');await ensureStatsId(owner);
  await setSubscription(owner,{customerId:'cus_GTitleLost001',subscriptionId:'sub_GTitleLost001',active:true,period:paidPeriod()});
  const made=await addProduct(owner,'Original title','Original summary','29',null);if(!made.ok)throw Error('fixture failed');
  const fresh=async()=>{const s=(await storeForEmail(owner))!;if(!s.statsId)throw Error('missing stats');return{...s,statsId:s.statsId};};
  const shop=await fresh();const proposal=field==='title'?await proposeTitle(shop,'g-key',{product:made.product.id,title:'Suggested title'}):await proposeSummary(shop,'g-key',{product:made.product.id,summary:'Suggested summary'});
  const id=JSON.parse(proposal.content[0].text).proposal;if(typeof id!=='string')throw Error('proposal missing');
  is(`${field}/${mode}: initial confirmation real`,(await confirmFor(await fresh(),owner,[id],owner)).done,[id]);
  is(`${field}/${mode}: no tolerant reconciliation hook`,AGENT_KINDS.get(`product.${field}`)?.currentExact,undefined);
  const undoStore=await fresh();
  const listingKey=`nl:catalog:${shop.catalog.id}:l:${made.product.id}`;let hit=0;let answer:unknown;
  redis.pipeline=(async commands=>{
   if(!hit&&mode==='before-product-batch'&&commands.some(c=>c[0]==='SET'&&c[1]===listingKey)){hit++;throw Error('G before restore product batch');}
   if(!hit&&mode==='applied-owner-acklost'&&commands.length===1&&commands[0][0]==='SET'&&String(commands[0][1]).startsWith('nl:store:owner:')){
    hit++;await base(commands);return[];
   }
   return base(commands);
  }) as typeof redis.pipeline;
  try{answer=await undoFor(undoStore,owner,id,owner);}catch(e){answer=e instanceof Error?e.name:'error';}finally{redis.pipeline=base;}
  const value=(await readListing(await fresh(),made.product.id))?.[field];const marked=Boolean((await readBook(shop.statsId)).history.find(d=>d.id===id)?.undone);
  console.log({field,mode,hit,answer,value,marked});
  is(`${field}/${mode}: boundary`,hit,mode==='normal'?0:1);
  is(`${field}/${mode}: success only with confirmation`,answer,mode==='normal'?{ok:true}:'BookWriteUnconfirmed');
  is(`${field}/${mode}: actual persisted value`,value,mode==='before-product-batch'?`Suggested ${field}`:`Original ${field}`);
  is(`${field}/${mode}: uncertain restore never loses durable mark`,marked,true);
 }
 done();}
main().catch(e=>{console.error(e);process.exitCode=1;});
