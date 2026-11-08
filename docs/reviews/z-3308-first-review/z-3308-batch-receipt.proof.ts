/** New batch transport controls: actual records deleted first, only acknowledgment changed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetNoted,noteForErasure } from "@/lib/erasure-index";
import { store as redis } from "../../../tests/redis-stub";
const stats="z3308-batch",email="synthetic-batch@buyer.example",real=redis.pipeline.bind(redis);
for(const mode of ["nested","oversized","throw","zero control"] as const)test(`batch acknowledgment ${mode}: never falsely completes an uncertain deletion`,async()=>{
 redis.clear();const keys=Array.from({length:1001},(_,i)=>`nl:z3308:batch:${i}`),notes=String(noteForErasure(stats,email,keys[0])[0][1]);
 if(mode!=="zero control")await real(keys.map(k=>["SET",k,"synthetic"]));
 await real([["ZADD",notes,...keys.flatMap(k=>[1,k])]]);
 let batches=0,error:unknown,result:unknown,survivor=keys[1000];const trace:(string|number)[][][]=[];
 redis.pipeline=async commands=>{
  trace.push(commands);const replies=await real(commands);
  if(commands.some(c=>c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:forget-noted-part:v1\n"))){
   batches++;const named=commands[0].slice(5).map(String);survivor=keys.find(k=>!named.includes(k))!;if(mode==="nested")return [[1000,0]];if(mode==="oversized")return [1001];if(mode==="throw")throw new Error("batch ACK lost AFTER actual deletion");
  }
  return replies;
 };
 try{result=await forgetNoted(stats,email);}catch(e){error=e;}finally{redis.pipeline=real;}
 const [left,remaining]=await real([["GET",survivor],["ZRANGEBYSCORE",notes,"-inf","+inf"]]);
 if(mode==="zero control"){assert.equal(error,undefined);assert.equal(result,0);assert.deepEqual(remaining,[]);}
 else{
  assert.ok(error instanceof Error);assert.equal(result,undefined);assert.equal(left,"synthetic");assert.deepEqual(remaining,[survivor],"uncertain batch leaves every surviving record indexed");
  assert.equal(await forgetNoted(stats,email),1);assert.equal((await real([["GET",survivor]]))[0],null);
 }
 console.log("Z_BATCH_RECEIPT",JSON.stringify({mode,batches,result,errorName:error instanceof Error?error.name:null,remainingRecords:Array.isArray(remaining)?remaining.length:null,productCommands:trace.flat().length,jsonPipelineBytes:trace.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0)}));
 assert.equal(batches,1);
});
