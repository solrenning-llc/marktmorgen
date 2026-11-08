import {test} from "node:test";
import assert from "node:assert/strict";
import {mintReviewLink} from "@/lib/review-proof";
import {forgetNoted} from "@/lib/erasure-index";
import type {Store} from "@/lib/store";
import {store as redis} from "../../../tests/redis-stub";
type Batch=(string|number)[][];
const stats="0".repeat(32),email="synthetic-review@buyer.example",reference="pi_synthetic_index3296",room={statsId:stats,handle:"index3296"} as unknown as Store;
for(const mode of ["unknown","throw"] as const)test(`unconfirmed erasure note ${mode} writes no address grant`,async()=>{
 redis.clear();const original=redis.pipeline.bind(redis),batches:Batch[]=[];let sets=0;
 redis.pipeline=async(b)=>{batches.push(b);if(b[0]?.[0]==="ZADD"&&String(b[0][1]).startsWith("nl:erase:ix:")){if(mode==="throw")throw Error("synthetic note write uncertain");return [null,0,1];}if(b.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:rev:link:")))sets++;return original(b);};
 let error:unknown;try{await mintReviewLink(room,reference,email);}catch(e){error=e;}finally{redis.pipeline=original;}
 console.log("Z_NOTE_FIRST",JSON.stringify({mode,sets,commands:batches.flat().map(c=>c[0]),jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0)}));
 assert.ok(error instanceof Error);assert.equal(sets,0);assert.equal(redis.keys().filter(k=>k.startsWith("nl:rev:link:")).length,0);
});
test("real confirmed index precedes SET, survives lost ACK plus failed DEL, and erases retained address",async()=>{
 redis.clear();const original=redis.pipeline.bind(redis),batches:Batch[]=[];let link="",index="",indexedBeforeSet=false;const logs:string[]=[];const oldError=console.error;console.error=(...a)=>{logs.push(a.map(String).join(" "));};
 redis.pipeline=async(b)=>{
  batches.push(b);
  if(b[0]?.[0]==="ZADD"&&String(b[0][1]).startsWith("nl:erase:ix:"))index=String(b[0][1]);
  const set=b.find(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:rev:link:"));
  if(set){link=String(set[1]);const [keys]=await original([["ZRANGEBYSCORE",index,"-inf","+inf"]]);indexedBeforeSet=Array.isArray(keys)&&keys.includes(link);await original([set]);throw Error("synthetic grant ACK lost");}
  if(b[0]?.[0]==="DEL"&&b[0][1]===link)throw Error("synthetic cleanup ACK lost");
  return original(b);
 };
 let error:unknown;try{await mintReviewLink(room,reference,email);}catch(e){error=e;}finally{redis.pipeline=original;console.error=oldError;}
 const [raw,ttl]=await original([["GET",link],["TTL",link]]);await forgetNoted(stats,email);const [after]=await original([["GET",link]]);
 console.log("Z_BOTH_FAILURES",JSON.stringify({indexedBeforeSet,retainedBeforeErase:typeof raw==="string",grantBytes:typeof raw==="string"?Buffer.byteLength(raw):0,ttl,erased:after===null,logs,commands:batches.flat().map(c=>c[0]),jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0)}));
 assert.ok(error instanceof Error);assert.equal(indexedBeforeSet,true);assert.equal(typeof raw,"string");assert.equal(after,null);assert.ok(logs.some(x=>x.includes("noted for erasure")));
});
