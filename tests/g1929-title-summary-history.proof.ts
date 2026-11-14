/** G: inherited book invariants exercised on real title and summary, no provider. */
import { addProduct,claimHandle,ensureStatsId,setSubscription,storeForEmail } from '@/lib/store';
import { readListing } from '@/lib/catalog';
import { proposeTitle,proposeSummary } from '@/lib/agent-propose';
import { confirmFor,undoFor } from '@/lib/agent-confirm';
import { readBook } from '@/lib/agent-book';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { is,done } from './check';
globalThis.fetch=(async()=>{throw Error('No provider in G proof');}) as typeof fetch;
async function main(){
 const base=redis.pipeline.bind(redis);let serial=0;
 for(const field of ['title','summary'] as const)for(const phase of ['normal','confirm-unknown','undo-unknown']){
  redis.clear();serial++;
  const owner=`gtitle${serial}@example.test`;await claimHandle(owner,`gtitle${serial}`,'G fixture','');await ensureStatsId(owner);
  await setSubscription(owner,{customerId:'cus_GTitleFixture001',subscriptionId:'sub_GTitleFixture001',active:true,period:paidPeriod()});
  const made=await addProduct(owner,'Original title','Original summary','29',null);if(!made.ok)throw Error('fixture failed');
  const shop=(await storeForEmail(owner))!;if(!shop.statsId)throw Error('stats absent');const store={...shop,statsId:shop.statsId};
  const response=field==='title'?await proposeTitle(store,'g-key',{product:made.product.id,title:'Suggested title'}):await proposeSummary(store,'g-key',{product:made.product.id,summary:'Suggested summary'});
  const id=JSON.parse(response.content[0].text).proposal;if(typeof id!=='string')throw Error('proposal absent');
  const fresh=async()=>({...((await storeForEmail(owner))!),statsId:store.statsId});
  if(phase==='undo-unknown'){const initial=await confirmFor(await fresh(),owner,[id],owner);is(`${field}: initial confirmation actually applied`,initial.done,[id]);}
  let hit=0;
  redis.pipeline=(async commands=>{
   if(phase!=='normal'&&!hit&&commands.length===1&&commands[0][0]==='SET'&&commands[0][1]===`nl:agent:book:${store.statsId}`){hit++;return[];}
   return base(commands);
  }) as typeof redis.pipeline;
  try{if(phase==='undo-unknown')await undoFor(await fresh(),owner,id,owner);else await confirmFor(store,owner,[id],owner);}catch{ /* observed unconfirmed write, inspect persisted state below */ }
  finally{redis.pipeline=base;}
  const value=(await readListing(await fresh(),made.product.id))?.[field],book=await readBook(store.statsId);
  console.log({field,phase,hit,value,history:book.history.map(x=>({id:x.id,undone:x.undone}))});
  is(`${field}/${phase}: boundary`,hit,phase==='normal'?0:1);
  if(phase==='normal')is(`${field}: normal writer actually changed the field`,value,`Suggested ${field}`);
  const original=`Original ${field}`;
  const consistent=phase==='undo-unknown'?value!==original||Boolean(book.history.find(x=>x.id===id)?.undone):value===original||book.history.some(x=>x.id===id);
  is(`${field}/${phase}: real effect has matching durable history`,consistent,true);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
