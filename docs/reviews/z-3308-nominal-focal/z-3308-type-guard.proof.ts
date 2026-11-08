/** Current script model guard, not a substitute for the author's native Redis parity evidence. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {FORGET_NOTED_PART} from "@/lib/erasure-index";
import {store as redis} from "../../../tests/redis-stub";
for(const wrong of ["index","notes"] as const)test(`PARTv2 ${wrong} wrong type refuses before deleting actual model record`,async()=>{
 redis.clear();const index="nl:z3308:type:index",notes=index+":z",record="nl:z3308:type:record";
 await redis.pipeline([["SET",record,"synthetic address payload"],["SADD",index,record],["ZADD",notes,1,record],["SET",wrong==="index"?index:notes,"wrong type"]]);
 const answer=await redis.pipeline([["EVAL",FORGET_NOTED_PART,3,index,notes,record]]);
 const [raw,held]=await redis.pipeline([["GET",record],["GET",wrong==="index"?index:notes]]);
 console.log("Z_TYPE_GUARD",JSON.stringify({wrong,answer,recordRetained:raw==="synthetic address payload",typeMarkerRetained:held==="wrong type",nativeRedis:false}));
 assert.deepEqual(answer,[-1]);assert.equal(raw,"synthetic address payload");assert.equal(held,"wrong type");
});
