/** Read-only r24 proof: an unknown Redis list must not become a confirmed empty public feed. */
import { recentSales, rememberSale } from "@/lib/recent-sales";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY="sk_test_public_cache_only_a_stand_in";
  const owner="public.cache@example.com",now=Date.now();
  await claimHandle(owner,"publiccache","Synthetic Store","");await ensureStatsId(owner);
  const made=await addProduct(owner,"Synthetic guide","","19",null);if(!made.ok)throw Error("fixture product");
  const base=(await storeForEmail(owner))!;
  const store={...base,recentSales:true,stripeAccountId:"acct_test_public_cache"};
  const feed=`nl:recent:feed:${store.statsId}`,list=`nl:recent:${store.statsId}`;
  const pipeline=redis.pipeline.bind(redis),originalFetch=globalThis.fetch;
  let refunds=0;
  globalThis.fetch=(async input=>{
    if(!String(input).includes("/refunds"))throw Error("Unexpected synthetic provider request");
    if(++refunds>1)throw Error("One refund lookup per scenario is the proof ceiling");
    return new Response(JSON.stringify({object:"list",data:[],has_more:false}),{status:200});
  }) as typeof fetch;
  const cases=[
    {name:"null LRANGE",bad:true,answer:[null,null]},
    {name:"boolean LRANGE",bad:true,answer:[null,false]},
    {name:"object LRANGE",bad:true,answer:[null,{}]},
    {name:"unreadable list row",bad:true,answer:[null,[null]]},
    {name:"confirmed empty list",bad:false,empty:true,answer:undefined},
    {name:"confirmed real purchase",bad:false,empty:false,answer:undefined},
  ];
  try{
    part("Only the first list reply is changed; the next visit gets the real intact purchase");
    for(const scenario of cases){
      await pipeline([["DEL",feed,list]]);
      await rememberSale(store,{id:"cs_live_publicCache000001",mode:"payment",created:Math.floor(now/1000)-60,amount_total:1900,payment_intent:"pi_PublicCache000001",metadata:{product:made.product.id},customer_details:{address:{country:"US"}}});
      if(scenario.empty)await pipeline([["DEL",list]]);
      let injected=false,writes=0,commands=0;refunds=0;
      redis.pipeline=async batch=>{
        commands+=batch.length;
        if(batch.some(c=>c[0]==="SET"&&c[1]===feed))writes++;
        if(!injected&&batch.length===2&&batch[0][0]==="GET"&&batch[0][1]===feed&&batch[1][0]==="LRANGE"){
          injected=true;
          if(scenario.answer!==undefined)return scenario.answer;
        }
        return pipeline(batch);
      };
      const first=await recentSales(store,now),firstWrites=writes;
      // Test-only inspection, outside the application's command count.
      const [cached]=await pipeline([["GET",feed]]);
      const second=await recentSales(store,now);
      console.log("RECENT_CACHE_OBSERVATION",JSON.stringify({scenario:scenario.name,first:first.length,firstWrites,cached,second:second.length,refunds,appCommands:commands}));
      is(scenario.name+": no unchecked public purchase",first.length,scenario.bad||scenario.empty?0:1);
      is(scenario.name+": only confirmed evidence writes the cache",firstWrites,scenario.bad?0:1);
      is(scenario.name+": unknown is not stored as a confirmed empty feed",cached===null,scenario.bad);
      is(scenario.name+": next healthy visit recovers without waiting for TTL",second.length,scenario.empty?0:1);
      is(scenario.name+": healthy recovery checks its refund evidence once",refunds,scenario.empty?0:1);
      redis.pipeline=pipeline;
    }
  }finally{redis.pipeline=pipeline;globalThis.fetch=originalFetch;}
  done();
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
