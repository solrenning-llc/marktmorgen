import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MemoryRedis } from "@/lib/redis-memory";
import { ORDER_WRITE, ORDER_WRITE_IF_STORE_LIVE, orderScriptWith } from "@/lib/order-data";
const owner={sid:"synthetic-meter"};
const writes=[["HSETNX", "nl:aff:synthetic:sales", "in_synthetic", "{}"]];
for (const state of ["gone", "erasing", "live"] as const) test(`fence internal command meter: ${state}`, async()=>{
 const guarded=new MemoryRedis(); const plain=new MemoryRedis();
 if(state!=="gone") guarded.run(["SET","synthetic:id","1"]);
 if(state==="erasing") guarded.run(["HSET","synthetic:erasing","field","1"]);
 const [reply]=await guarded.pipeline([orderScriptWith(owner,writes,ORDER_WRITE_IF_STORE_LIVE,["synthetic:id","synthetic:erasing"],["field"])]);
 if(state==="live") await plain.pipeline([orderScriptWith(owner,writes,ORDER_WRITE,[],[])]);
 assert.equal(guarded.scriptCalls-plain.scriptCalls,state==="gone"?1:2,"Lua EXISTS/HEXISTS must be billed even on refusal");
 if(state!=="live") assert.deepEqual(reply,[-3]);
});
