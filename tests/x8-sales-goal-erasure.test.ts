/** RED for Codex X8 (X8-20261119-2224), on main's signature: a goal written or removed while its store is closed or being erased. Synthetic only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, storeForEmail, closeStoreRecord, ERASING_KEY, erasingField, storeRef } from "@/lib/store";
import { setSalesGoal, readSalesGoal } from "@/lib/sales-goal";
import { store as redis } from "./redis-stub";
const now=Date.UTC(2026,10,19,20);
test("a stale goal write cannot recreate a closed store's goal",async()=>{
 redis.clear();const owner="goal-erasure@example.test";
 await claimHandle(owner,"goalerasure","Synthetic","");await ensureStatsId(owner);
 const store=(await storeForEmail(owner))!;assert.ok(store.statsId);
 const write=(n:number)=>setSalesGoal(store.statsId!,n,"usd",now);
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
 await setSalesGoal(store.statsId!,123400,"usd",now);
 await redis.pipeline([["HSET",ERASING_KEY,await erasingField(storeRef(store)),""]]);
 for(const n of [0,999900]){
  await assert.rejects(setSalesGoal(store.statsId!,n,"usd",now));
  assert.deepEqual(await readSalesGoal(store.statsId,"usd"),{cents:123400,since:"2026-11"});
 }
});

