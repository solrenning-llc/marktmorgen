import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, storeForEmail, closeStoreRecord, ERASING_KEY, erasingField, storeRef } from "@/lib/store";
import { setSalesGoal, readSalesGoal, SALES_GOAL_WRITE_COMMANDS } from "@/lib/sales-goal";
import { store as redis } from "./redis-stub";
const now=Date.UTC(2026,10,19,20);
test("a stale goal write cannot recreate a closed store's goal",async()=>{
 redis.clear();const owner="goal-erasure@example.test";
 await claimHandle(owner,"goalerasure","Synthetic","");await ensureStatsId(owner);
 const store=(await storeForEmail(owner))!;assert.ok(store.statsId);
 const write=(n:number)=>setSalesGoal(store,n,"usd",now);
 assert.equal(await write(123400),123400);
 assert.deepEqual(await readSalesGoal(store.statsId,"usd"),{cents:123400,since:"2026-11"});
 await closeStoreRecord(store);await redis.pipeline([["DEL",`nl:goal:${store.statsId}`]]);
 await assert.rejects(write(567800));
 assert.deepEqual(await redis.pipeline([["GET",`nl:goal:${store.statsId}`]]),[null]);
});
test("an erasing store's still-live id does not authorize a goal write or removal",async()=>{
 redis.clear();const owner="goal-mark@example.test";
 await claimHandle(owner,"goalmark","Synthetic","");await ensureStatsId(owner);
 const store=(await storeForEmail(owner))!;
 await setSalesGoal(store,123400,"usd",now);
 await redis.pipeline([["HSET",ERASING_KEY,await erasingField(storeRef(store)),""]]);
 for(const n of [0,999900]){
  await assert.rejects(setSalesGoal(store,n,"usd",now));
  assert.deepEqual(await readSalesGoal(store.statsId,"usd"),{cents:123400,since:"2026-11"});
 }
});

test("legacy owner records remain supported; confirmed removals and unknown receipts stay exact",async()=>{
 redis.clear();const owner="legacy-goal@example.test";
 await claimHandle(owner,"legacygoal","Synthetic","");await ensureStatsId(owner);
 const actual=(await storeForEmail(owner))!;
 const store={...actual,sid:"",extra:false};
 assert.equal(SALES_GOAL_WRITE_COMMANDS,4);
 assert.equal(await setSalesGoal(store,123400,"usd",now),123400);
 assert.equal(await setSalesGoal(store,0,"usd",now),0);
 assert.equal(await setSalesGoal(store,0,"usd",now),0);
 const original=redis.pipeline.bind(redis);
 try{
  for(const answer of [[],[null],["1"],[2],[-1],[1,1],[true]]){
   redis.pipeline=async commands=>commands[0]?.[0]==="EVAL"&&String(commands[0]?.[1]).includes("sales-goal-live:v1")?answer:original(commands);
   await assert.rejects(setSalesGoal(store,77700,"usd",now));
   assert.deepEqual(await original([["GET",`nl:goal:${store.statsId}`]]),[null]);
  }
 }finally{redis.pipeline=original;}
});
