/** Caller protocol control: rejecting batch101 must not forbid the final compare after batch100. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {forgetNoted,FORGET_KEYS} from "@/lib/erasure-index";
import {store as redis} from "../../../tests/redis-stub";
test("after exactly100 batches the final checked step is allowed",async()=>{
 const real=redis.pipeline.bind(redis),members=Array.from({length:FORGET_KEYS+1},(_,i)=>`nl:z3308:tail:${i}`);
 let batches=0,final=0,reads=0;
 redis.pipeline=async commands=>{
  if(commands[0][0]==="SMEMBERS"){reads++;return [[],batches<100?members:[]];}
  const script=String(commands[0][1]);
  if(/^-- marktmorgen:forget-noted-part:v[12]\n/.test(script)){batches++;return [0];}
  if(script.startsWith("-- marktmorgen:forget-noted:v2\n")){final++;return [[0,0]];}
  throw new Error("Unexpected protocol command");
 };
 let result;try{result=await forgetNoted("z3308-tail","synthetic-tail@buyer.example");}finally{redis.pipeline=real;}
 console.log("Z_FINAL_AFTER100",JSON.stringify({batches,reads,final,result,physicalRedisExecution:false}));
 assert.deepEqual([batches,reads,final,result],[100,101,1,0]);
});
