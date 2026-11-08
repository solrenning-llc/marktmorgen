import {test} from "node:test";
import assert from "node:assert/strict";
import {sweep} from "@/lib/stream";
import {ABANDONED_AFTER_MS} from "@/lib/stream-rules";
import {store as redis} from "../../../tests/redis-stub";
type Batch=(string|number)[][];
const now=Date.UTC(2026,10,8,12),due="nl:stream:due",folder="0".repeat(32),lesson="abcdefghij12";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const key=(n:number)=>`nl:stream:v:${id(n)}`;
process.env.BUNNY_STREAM_LIBRARY_ID="123456";process.env.BUNNY_STREAM_API_KEY="synthetic-api-key-0000000000";process.env.BUNNY_STREAM_TOKEN_KEY="synthetic-token-key-000000000";
let http=0;globalThis.fetch=(async()=>{http++;return new Response("{}",{status:200});}) as typeof fetch;
test("failed moves use at most two bounded list reads and eighty unknown record attempts",async()=>{
 redis.clear();http=0;for(let n=1;n<=81;n++)await redis.pipeline([["SET",key(n),JSON.stringify({id:id(n),path:`stream/${folder}/${lesson}/${id(n)}`,name:"Synthetic",type:"video/mp4",bytes:1000,state:"upload",at:now-ABANDONED_AFTER_MS-600000,seconds:0,width:0,height:0})],["ZADD",due,now-1000+n,id(n)]]);
 const original=redis.pipeline.bind(redis),batches:Batch[]=[];let reads=0,moves=0,logs=0;const error=console.error;console.error=()=>{logs++;};
 redis.pipeline=async(b)=>{batches.push(b);if(b[0][0]==="GET"&&String(b[0][1]).startsWith("nl:stream:v:")){reads++;return [undefined];}if(b[0][0]==="ZADD"&&b[0][1]===due){moves++;return [0];}return original(b);};
 let result;try{result=await sweep(Date.now()+5000,now);}finally{redis.pipeline=original;console.error=error;}
 const lists=batches.flat().filter(c=>c[0]==="ZRANGEBYSCORE");console.log("Z_FOCAL_BOUND",JSON.stringify({reads,moves,logs,listCommands:lists,commands:batches.flat().length,jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0),http,result}));
 assert.equal(reads,80);assert.equal(moves,80);assert.equal(logs,80);assert.equal(lists.length,2);assert.equal(lists[0].at(-1),40);assert.equal(lists[1].at(-1),80);assert.equal(http,0);
 assert.equal((await original([["ZCARD",due]]))[0],81);
});
