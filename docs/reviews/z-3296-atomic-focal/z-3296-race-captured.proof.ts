import {test} from "node:test";
import assert from "node:assert/strict";
import {mintReviewLink} from "@/lib/review-proof";
import {forgetNoted,noteForErasure} from "@/lib/erasure-index";
import type {Store} from "@/lib/store";
import {store as redis} from "../../../tests/redis-stub";
const stats="1".repeat(32),email="synthetic-race@buyer.example",reference="pi_synthetic_race3296",room={statsId:stats,handle:"race3296"} as unknown as Store;
test("MEDIUM: erasure after confirmed note must not be followed by an unindexed address grant",async()=>{
 redis.clear();const original=redis.pipeline.bind(redis);let erased=false,link="";const batches:(string|number)[][][]=[];
 redis.pipeline=async(b)=>{
  batches.push(b);const a=await original(b);const note=b.find(c=>c[0]==="ZADD"&&String(c[1]).startsWith("nl:erase:ix:")&&String(c[3]).startsWith("nl:rev:link:"));
  if(note&&!erased){erased=true;link=String(note[3]);await forgetNoted(stats,email);}
  return a;
 };
 let token,error;try{token=await mintReviewLink(room,reference,email);}catch(e){error=e;}finally{redis.pipeline=original;}
 const index=String(noteForErasure(stats,email,link)[0][1]);const [raw,notes,ttl]=await original([["GET",link],["ZRANGEBYSCORE",index,"-inf","+inf"],["TTL",link]]);
 await forgetNoted(stats,email);const [after]=await original([["GET",link]]);
 console.log("Z_INDEX_RACE",JSON.stringify({erasedDuringMint:erased,errorName:error instanceof Error?error.name:null,returnedToken:typeof token==="string",grantBytes:typeof raw==="string"?Buffer.byteLength(raw):0,notes,ttl,retainedAfterSecondErasure:typeof after==="string",productAndErasureCommands:batches.flat().map(c=>c[0]),jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0)}));
 assert.equal(erased,true);assert.equal(after,null,"once the actual indexed-record erasure completed, a later grant must not retain the erased address outside that index");
});
