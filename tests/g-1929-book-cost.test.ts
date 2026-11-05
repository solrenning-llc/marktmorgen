import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,addProduct,storeForEmail} from '../lib/store';
import {makeKey} from '../lib/api-keys';
import {proposeDescription} from '../lib/agent-propose';
import {confirmFor} from '../lib/agent-confirm';
import {allowanceUsed} from '../lib/store-allowance';
import {POST as mcp} from '../app/api/mcp/route';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const tools=process.env.G_AGENT_COST_TOOL?[process.env.G_AGENT_COST_TOOL]:['propose_product_title','propose_product_summary'];
for(const tool of tools)test(`G ${tool} must fit the cost envelope it reserves with ordinary retained history`,async()=>{
 redis.clear();globalThis.fetch=async()=>{throw Error('No external service in G cost proof');};
 const owner='g-agent-cost@example.test';
 await claimHandle(owner,'gagentcost','G agent cost','');await ensureStatsId(owner);
 await setSubscription(owner,{customerId:'cus_GAgentCost0001',subscriptionId:'sub_GAgentCost0001',active:true,period:paidPeriod()});
 const added=await addProduct(owner,'Knife skills','Practical cooking','29',null);assert.ok(added.ok);
 const id=added.product.id,sid=(await ensureStoreId(owner))!.sid;
 const key=await makeKey(sid,'G cost drafter',Date.now(),false,'draft');assert.ok(key.ok);
 // Three genuine description proposals, each confirmed through the real
 // handlers. No synthetic oversized/invalid book is injected.
 for(let i=0;i<3;i++){
  const store=(await storeForEmail(owner))!;
  assert.ok(store.statsId);
  const made=await proposeDescription(store,key.made.id,{product:id,description:`Course notes ${i}: `+'A'.repeat(4900)});
  assert.equal(made.isError,false);
  const proposal=JSON.parse(made.content[0].text).proposal;
  const done=await confirmFor({...store,statsId:store.statsId},owner,[proposal],owner);
  assert.deepEqual(done.done,[proposal]);
 }
 const store=(await storeForEmail(owner))!,before=await allowanceUsed(store,'api');
 const pipeline=redis.pipeline,inner=redis.scriptCalls;let wireBytes=0,outer=0,bookReadBytes=0,bookWriteBytes=0;
 redis.pipeline=async commands=>{
  outer+=commands.length;wireBytes+=Buffer.byteLength(JSON.stringify(commands));
  const replies=await pipeline(commands);wireBytes+=Buffer.byteLength(JSON.stringify(replies));
  commands.forEach((command,i)=>{
   if(command[1]===`nl:agent:book:${store.statsId}`){
    if(command[0]==='GET')bookReadBytes+=Buffer.byteLength(JSON.stringify(replies[i]));
    if(command[0]==='SET')bookWriteBytes+=Buffer.byteLength(JSON.stringify(command));
   }
  });return replies;
 };
 const field=tool==='propose_product_title'?'title':tool==='propose_product_summary'?'summary':'description';
 let response:{result?:{isError?:boolean}};
 try{
  response=await(await mcp(new Request('https://marktmorgen.com/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key.key}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{product:id,[field]:'A new practical cooking course'}}})}))).json();
 }finally{redis.pipeline=pipeline;}
 assert.equal(response.result?.isError,false);
 const commands=outer+redis.scriptCalls-inner,units=(await allowanceUsed((await storeForEmail(owner))!,'api'))-before;
 console.log('G MEASURED',JSON.stringify({tool,commands,wireBytes,bookReadBytes,bookWriteBytes,apiUnits:units,historyEntries:3}));
 assert.ok(units>=1);
 assert.ok(wireBytes<=units*20000,`wire ${wireBytes} bytes for ${units} API unit(s), envelope ${units*20000}`);
 assert.ok(commands<=units*24,`${commands} billed commands for ${units} API units, envelope ${units*24}`);
});
