/** Caller protocol bound under continuously replenished notes; no claim of physical Redis dispatch/deletion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetNoted,FORGET_KEYS } from "@/lib/erasure-index";
import { store as redis } from "../../../tests/redis-stub";
test("LOW: the stated maximum of one hundred batch requests must be enforced before the next request",async()=>{
 const real=redis.pipeline.bind(redis),members=Array.from({length:FORGET_KEYS+1},(_,i)=>`nl:z3308:replenished:${i}`);
 let batches=0,reads=0,commands=0,jsonBytes=0,error:unknown;
 // Models records already expired, with their notes re-added by an overlapping writer after each batch.
 // Read and batch responses are exact; this measures only the real caller's loop/admission, not native Lua.
 redis.pipeline=async c=>{
  commands+=c.length;jsonBytes+=Buffer.byteLength(JSON.stringify(c));
  if(c[0][0]==="SMEMBERS"){reads++;return [[],members];}
  if(c[0][0]==="EVAL"&&/^-- marktmorgen:forget-noted-part:v[12]\n/.test(String(c[0][1]))){batches++;return [0];}
  throw new Error("Unexpected protocol request");
 };
 try{await forgetNoted("z3308-replenished","synthetic-bound@buyer.example");}catch(e){error=e;}finally{redis.pipeline=real;}
 console.log("Z_BATCH_BOUND",JSON.stringify({batches,reads,commands,jsonRequestBytes:jsonBytes,errorName:error instanceof Error?error.name:null,physicalRedisExecution:false}));
 assert.equal((error as Error)?.name,"UnknownReplyError");assert.ok(batches>0,"batch protocol hook actually ran");assert.ok(batches<=100,"FORGET_BATCHES100 must reject before issuing a101st thousand-key batch");
});
